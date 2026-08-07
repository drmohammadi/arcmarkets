'use client';

/**
 * Real probability history, reconstructed from on-chain events.
 *
 * The FPMM emits Buy/Sell/LiquidityAdded/LiquidityRemoved but never records the
 * resulting price, so history is derived by REPLAYING those events forward from
 * the pool's creation block. Every reserve mutation in the contract is exactly
 * reproducible from event args (see replayStep), so the reconstruction is exact
 * rather than approximate.
 *
 * Why replay instead of historical eth_call at old blocks: archive state is not
 * guaranteed on public RPCs (and Arc testnet may prune), whereas logs are
 * broadly available. Replay also costs one range query instead of N calls.
 *
 * Correctness is not assumed — the final replayed reserves are compared against
 * live reserves() and the hook reports `verified: false` if they diverge, so
 * the UI can decline to show a chart it cannot stand behind.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { parseAbiItem } from 'viem';
import { usePublicClient } from 'wagmi';
import { yesProbBps } from '@/lib/pricing';

/**
 * Event definitions as typed literals. parseAbiItem preserves the arg names and
 * types, which is what lets getLogs return decoded, correctly-typed args and
 * lets the MarketCreated filter accept `{ questionId }`. These must stay
 * byte-identical to the signatures in lib/abis.ts.
 */
const EV_MARKET_CREATED = parseAbiItem(
  'event MarketCreated(uint256 indexed questionId, address indexed fpmm, bytes32 indexed conditionId, string question, string category, uint256 resolutionTime, address resolver, uint256 fee)'
);
const EV_BUY = parseAbiItem(
  'event Buy(address indexed buyer, uint256 outcome, uint256 investmentAmount, uint256 sharesOut)'
);
const EV_SELL = parseAbiItem(
  'event Sell(address indexed seller, uint256 outcome, uint256 returnAmount, uint256 sharesIn)'
);
const EV_LIQ_ADD = parseAbiItem(
  'event LiquidityAdded(address indexed provider, uint256 collateral, uint256 shares)'
);
const EV_LIQ_REMOVE = parseAbiItem(
  'event LiquidityRemoved(address indexed provider, uint256 shares, uint256 collateral)'
);

export interface PricePoint {
  /** Unix seconds of the block this state was reached at. */
  t: number;
  /** Implied YES probability in bps at that time. */
  yesBps: number;
  /** Pool reserves after the event, for tooltips. */
  reserveYes: bigint;
  reserveNo: bigint;
  /** What caused this point. 'seed' is the initial liquidity. */
  kind: 'seed' | 'buy' | 'sell' | 'liquidity';
}

export interface PriceHistory {
  points: PricePoint[];
  isLoading: boolean;
  /** True when replayed reserves match live reserves exactly. */
  verified: boolean;
  /** Set when history could not be built; UI shows this instead of a chart. */
  error: string | null;
}

/** Chunk size for getLogs. Conservative enough for strict public RPCs. */
const LOG_CHUNK = BigInt(9000);
/** Hard cap on chunks so a mis-set fromBlock can never spin forever. */
const MAX_CHUNKS = 200;

interface ReplayState {
  yes: bigint;
  no: bigint;
  totalSupply: bigint;
}

/**
 * Apply one event to the running reserve state, mirroring the Solidity exactly.
 *
 * buy():  splits the FULL investment into sets (both reserves += investment),
 *         then transfers sharesOut of the bought side to the trader.
 * sell(): pulls sharesIn of the sold side in, then merges returnAmount full
 *         sets back to collateral (both reserves -= returnAmount).
 * addLiquidity():    splits collateral into sets → both reserves += collateral.
 * removeLiquidity(): withdraws a proportional slice of BOTH reserves; the
 *         mergeable part becomes collateral and the residual is transferred to
 *         the LP, so the pool loses the full proportional amount either way.
 */
function replayStep(s: ReplayState, name: string, args: Record<string, unknown>): ReplayState {
  if (name === 'Buy') {
    const invest = args.investmentAmount as bigint;
    const out = args.sharesOut as bigint;
    const outcome = args.outcome as bigint;
    let yes = s.yes + invest;
    let no = s.no + invest;
    if (outcome === BigInt(0)) yes -= out;
    else no -= out;
    return { ...s, yes, no };
  }

  if (name === 'Sell') {
    const ret = args.returnAmount as bigint;
    const inAmt = args.sharesIn as bigint;
    const outcome = args.outcome as bigint;
    let yes = s.yes;
    let no = s.no;
    if (outcome === BigInt(0)) yes += inAmt;
    else no += inAmt;
    yes -= ret;
    no -= ret;
    return { ...s, yes, no };
  }

  if (name === 'LiquidityAdded') {
    const collateral = args.collateral as bigint;
    const shares = args.shares as bigint;
    return { yes: s.yes + collateral, no: s.no + collateral, totalSupply: s.totalSupply + shares };
  }

  if (name === 'LiquidityRemoved') {
    const shares = args.shares as bigint;
    if (s.totalSupply <= BigInt(0)) return s;
    // Same floor division the contract performs, in the same order.
    const yesOut = (shares * s.yes) / s.totalSupply;
    const noOut = (shares * s.no) / s.totalSupply;
    return { yes: s.yes - yesOut, no: s.no - noOut, totalSupply: s.totalSupply - shares };
  }

  return s;
}

export function usePriceHistory(
  fpmm: `0x${string}` | undefined,
  factory: `0x${string}` | undefined,
  questionId: bigint | null,
  liveYes: bigint,
  liveNo: bigint
): PriceHistory {
  const client = usePublicClient();
  const [state, setState] = useState<PriceHistory>({
    points: [],
    isLoading: true,
    verified: false,
    error: null,
  });

  // Guards against setState after unmount and against overlapping runs.
  const runIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!client || !fpmm || !factory || questionId === null) return;
    const runId = ++runIdRef.current;
    const alive = () => runIdRef.current === runId;

    setState((s) => ({ ...s, isLoading: true, error: null }));

    try {
      const latest = await client.getBlockNumber();

      // 1. Find the pool's creation block from the factory's MarketCreated
      //    event, so the scan is bounded to this market's lifetime.
      let fromBlock = BigInt(0);
      try {
        const created = await client.getLogs({
          address: factory,
          event: EV_MARKET_CREATED,
          args: { questionId },
          fromBlock: BigInt(0),
          toBlock: latest,
        });
        if (created.length > 0 && created[0].blockNumber !== null) {
          fromBlock = created[0].blockNumber;
        }
      } catch {
        // Non-fatal: fall back to scanning from genesis.
      }

      // 2. Pull all four event types across the range, in chunks.
      const logs = await fetchLogsChunked(client, fpmm, fromBlock, latest);
      if (!alive()) return;

      // 3. Resolve block timestamps (deduped — many events share a block).
      const blockNums = Array.from(new Set(logs.map((l) => l.blockNumber)));
      const stamps = new Map<string, number>();
      for (const bn of blockNums) {
        try {
          const blk = await client.getBlock({ blockNumber: bn });
          stamps.set(bn.toString(), Number(blk.timestamp));
        } catch {
          // Skip: the point is dropped rather than dated wrongly.
        }
      }
      if (!alive()) return;

      // 4. Replay in canonical chain order.
      const ordered = [...logs].sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
        return a.logIndex - b.logIndex;
      });

      let s: ReplayState = { yes: BigInt(0), no: BigInt(0), totalSupply: BigInt(0) };
      const points: PricePoint[] = [];

      for (const log of ordered) {
        s = replayStep(s, log.name, log.args);

        const ts = stamps.get(log.blockNumber.toString());
        if (ts === undefined) continue;
        if (s.yes <= BigInt(0) && s.no <= BigInt(0)) continue;

        points.push({
          t: ts,
          yesBps: yesProbBps(s.yes, s.no),
          reserveYes: s.yes,
          reserveNo: s.no,
          kind:
            log.name === 'Buy'
              ? 'buy'
              : log.name === 'Sell'
                ? 'sell'
                : points.length === 0
                  ? 'seed'
                  : 'liquidity',
        });
      }

      // 5. Verify the replay against live state. Exact match required.
      const verified = s.yes === liveYes && s.no === liveNo;

      if (!alive()) return;
      setState({
        points,
        isLoading: false,
        verified,
        error: null,
      });
    } catch (err) {
      if (!alive()) return;
      setState({
        points: [],
        isLoading: false,
        verified: false,
        error: err instanceof Error ? err.message : 'Could not load price history',
      });
    }
  }, [client, fpmm, factory, questionId, liveYes, liveNo]);

  useEffect(() => {
    load();
    return () => {
      // Invalidate any in-flight run on unmount.
      runIdRef.current++;
    };
  }, [load]);

  return state;
}

/** Normalized log shape. Decoding happens at fetch time so the replay loop
 *  works with one concrete type instead of a union of four event shapes. */
interface ReplayLog {
  blockNumber: bigint;
  logIndex: number;
  name: string;
  args: Record<string, unknown>;
}

/**
 * Fetch the four FPMM events across a block range in chunks, tolerating RPCs
 * that cap getLogs spans.
 */
async function fetchLogsChunked(
  client: NonNullable<ReturnType<typeof usePublicClient>>,
  address: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint
): Promise<ReplayLog[]> {
  const out: ReplayLog[] = [];
  let start = fromBlock;
  let chunks = 0;

  while (start <= toBlock && chunks < MAX_CHUNKS) {
    const end = start + LOG_CHUNK > toBlock ? toBlock : start + LOG_CHUNK;

    // One request per event type: viem's multi-event overload widens args to a
    // union that erases the per-event names, so four narrow queries are both
    // simpler and better typed. They are small and run against one address.
    const [buys, sells, adds, removes] = await Promise.all([
      client.getLogs({ address, event: EV_BUY, fromBlock: start, toBlock: end }),
      client.getLogs({ address, event: EV_SELL, fromBlock: start, toBlock: end }),
      client.getLogs({ address, event: EV_LIQ_ADD, fromBlock: start, toBlock: end }),
      client.getLogs({ address, event: EV_LIQ_REMOVE, fromBlock: start, toBlock: end }),
    ]);

    const push = (
      logs: readonly { blockNumber: bigint | null; logIndex: number | null; args: unknown }[],
      name: string
    ) => {
      for (const l of logs) {
        if (l.blockNumber === null || l.logIndex === null) continue;
        out.push({
          blockNumber: l.blockNumber,
          logIndex: l.logIndex,
          name,
          args: (l.args ?? {}) as Record<string, unknown>,
        });
      }
    };

    push(buys, 'Buy');
    push(sells, 'Sell');
    push(adds, 'LiquidityAdded');
    push(removes, 'LiquidityRemoved');

    start = end + BigInt(1);
    chunks++;
  }

  return out;
}

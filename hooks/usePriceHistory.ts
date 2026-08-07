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
 * broadly available.
 *
 * Correctness is not assumed — the final replayed reserves are compared against
 * live reserves() and the hook reports `verified: false` if they diverge, so
 * the UI can decline to show a chart it cannot stand behind.
 *
 * ── RPC BUDGET ────────────────────────────────────────────────────────────────
 * The public Arc RPC rate-limits (HTTP 429), and this is the heaviest caller in
 * the app. Every measure below exists to keep the request count near zero on
 * repeat views:
 *
 *  1. **React Query owns the fetch.** One shared cache entry per (chain, pool)
 *     means N mounted charts trigger ONE request, and re-renders from unrelated
 *     UI state (range tabs, hover, theme) never refetch. Previously this was a
 *     useEffect keyed on live reserves, so every reserve refresh rescanned all
 *     of history.
 *  2. **Never scans from block 0.** The scan starts at the market's creation
 *     block, found from the factory's MarketCreated log (itself cached).
 *  3. **Range cache.** Fetched ranges persist in memory + sessionStorage; a
 *     later load fetches only `[cachedTo + 1, latest]`.
 *  4. **Serialized + backed off.** All calls go through lib/rpcQueue, which
 *     spaces requests and applies 1s/2s/4s/8s backoff on 429.
 *  5. **No polling.** `refetchInterval` is off and `staleTime` is long; new
 *     trades arrive via an explicit `refresh()` the trade panel can call.
 *  6. **Empty history is a cached answer,** not a retry loop: a pool with no
 *     events resolves successfully with zero points and is not re-queried.
 */

import { useCallback, useMemo } from 'react';
import { parseAbiItem } from 'viem';
import { useChainId, usePublicClient } from 'wagmi';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { yesProbBps } from '@/lib/pricing';
import { enqueueRpc, isRateLimit } from '@/lib/rpcQueue';
import { readCache, writeCache, reviveArgs, type CachedEvent } from '@/lib/logCache';

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
  /** True when the failure was rate limiting, so the UI can say so precisely. */
  rateLimited: boolean;
  /** Manual refetch for after a trade. No automatic polling happens. */
  refresh: () => void;
}

/** Chunk size for getLogs. Conservative enough for strict public RPCs. */
const LOG_CHUNK = BigInt(9000);
/** Hard cap on chunks per load so one call can never spin forever. */
const MAX_CHUNKS = 200;
/** Treat data as fresh for 5 minutes; trades trigger refresh() explicitly. */
const STALE_MS = 5 * 60_000;

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
function replayStep(s: ReplayState, name: string, args: Record<string, bigint>): ReplayState {
  if (name === 'Buy') {
    const invest = args.investmentAmount ?? BigInt(0);
    const out = args.sharesOut ?? BigInt(0);
    const outcome = args.outcome ?? BigInt(0);
    let yes = s.yes + invest;
    let no = s.no + invest;
    if (outcome === BigInt(0)) yes -= out;
    else no -= out;
    return { ...s, yes, no };
  }

  if (name === 'Sell') {
    const ret = args.returnAmount ?? BigInt(0);
    const inAmt = args.sharesIn ?? BigInt(0);
    const outcome = args.outcome ?? BigInt(0);
    let yes = s.yes;
    let no = s.no;
    if (outcome === BigInt(0)) yes += inAmt;
    else no += inAmt;
    yes -= ret;
    no -= ret;
    return { ...s, yes, no };
  }

  if (name === 'LiquidityAdded') {
    const collateral = args.collateral ?? BigInt(0);
    const shares = args.shares ?? BigInt(0);
    return { yes: s.yes + collateral, no: s.no + collateral, totalSupply: s.totalSupply + shares };
  }

  if (name === 'LiquidityRemoved') {
    const shares = args.shares ?? BigInt(0);
    if (s.totalSupply <= BigInt(0)) return s;
    // Same floor division the contract performs, in the same order.
    const yesOut = (shares * s.yes) / s.totalSupply;
    const noOut = (shares * s.no) / s.totalSupply;
    return { yes: s.yes - yesOut, no: s.no - noOut, totalSupply: s.totalSupply - shares };
  }

  return s;
}

/** What the query resolves to: raw events plus the timestamps they need. */
interface HistoryData {
  events: CachedEvent[];
  /** blockNumber (decimal string) → unix seconds. */
  stamps: Record<string, number>;
}

type Client = NonNullable<ReturnType<typeof usePublicClient>>;

export function usePriceHistory(
  fpmm: `0x${string}` | undefined,
  factory: `0x${string}` | undefined,
  questionId: bigint | null,
  liveYes: bigint,
  liveNo: bigint
): PriceHistory {
  const client = usePublicClient();
  const chainId = useChainId();
  const queryClient = useQueryClient();

  const enabled = !!client && !!fpmm && !!factory && questionId !== null;

  // Key deliberately EXCLUDES live reserves: they change on every trade and
  // block refresh, and including them would defeat the cache entirely. The
  // reserves are only used afterwards, to verify the replay.
  const queryKey = useMemo(
    () => ['priceHistory', chainId, fpmm ?? null, factory ?? null, questionId?.toString() ?? null],
    [chainId, fpmm, factory, questionId]
  );

  const { data, isLoading, error, refetch } = useQuery<HistoryData, Error>({
    queryKey,
    enabled,
    staleTime: STALE_MS,
    gcTime: 30 * 60_000,
    // No polling: historical blocks don't change, and new trades are picked up
    // by refresh(). retry is 0 because rpcQueue already handles 429 backoff
    // internally; a React Query retry on top would multiply the request count.
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    retry: false,
    queryFn: async () => {
      if (!client || !fpmm || !factory || questionId === null) {
        throw new Error('Price history is not available yet.');
      }
      return loadHistory(client, chainId, fpmm, factory, questionId);
    },
  });

  // Replay is pure and cheap, so it runs in a memo on the cached events rather
  // than being baked into the query. That keeps live-reserve verification out
  // of the cache key while still reacting to reserve updates.
  const { points, verified } = useMemo(() => {
    if (!data) return { points: [] as PricePoint[], verified: false };

    const ordered = [...data.events].sort((a, b) => {
      const ab = BigInt(a.blockNumber);
      const bb = BigInt(b.blockNumber);
      if (ab !== bb) return ab < bb ? -1 : 1;
      return a.logIndex - b.logIndex;
    });

    let s: ReplayState = { yes: BigInt(0), no: BigInt(0), totalSupply: BigInt(0) };
    const out: PricePoint[] = [];

    for (const ev of ordered) {
      s = replayStep(s, ev.name, reviveArgs(ev.args));

      const ts = data.stamps[ev.blockNumber];
      if (ts === undefined) continue;
      if (s.yes <= BigInt(0) && s.no <= BigInt(0)) continue;

      out.push({
        t: ts,
        yesBps: yesProbBps(s.yes, s.no),
        reserveYes: s.yes,
        reserveNo: s.no,
        kind:
          ev.name === 'Buy'
            ? 'buy'
            : ev.name === 'Sell'
              ? 'sell'
              : out.length === 0
                ? 'seed'
                : 'liquidity',
      });
    }

    return { points: out, verified: s.yes === liveYes && s.no === liveNo };
  }, [data, liveYes, liveNo]);

  const refresh = useCallback(() => {
    // Invalidate so the next fetch resumes from the cached tail rather than
    // rescanning: loadHistory always starts at cachedTo + 1.
    void queryClient.invalidateQueries({ queryKey });
    void refetch();
  }, [queryClient, queryKey, refetch]);

  return {
    points,
    isLoading: enabled && isLoading,
    verified,
    error: error ? describeError(error) : null,
    rateLimited: !!error && isRateLimit(error),
    refresh,
  };
}

function describeError(err: Error): string {
  if (isRateLimit(err)) {
    return 'The network RPC is rate limiting requests right now. History will load once the limit clears.';
  }
  return err.message || 'Could not load price history';
}

/**
 * Fetch (or incrementally extend) this pool's event history.
 *
 * Returns every known event for the pool, from the cache plus whatever new
 * range had to be fetched. Only the uncached tail hits the network.
 */
async function loadHistory(
  client: Client,
  chainId: number,
  fpmm: `0x${string}`,
  factory: `0x${string}`,
  questionId: bigint
): Promise<HistoryData> {
  const latest = await enqueueRpc(() => client.getBlockNumber());

  const cached = readCache(chainId, fpmm);
  let fromBlock: bigint;
  let known: CachedEvent[];

  if (cached) {
    // Resume at the block after the cached range. If the cache already covers
    // `latest`, this loop body runs zero times and no logs are fetched at all.
    fromBlock = BigInt(cached.toBlock) + BigInt(1);
    known = cached.events;
  } else {
    fromBlock = await findCreationBlock(client, factory, questionId, latest);
    known = [];
  }

  const fresh = fromBlock > latest ? [] : await fetchLogsChunked(client, fpmm, fromBlock, latest);

  // Dedupe by (block, logIndex): overlapping ranges or a re-fetched boundary
  // block must not double-apply an event, which would corrupt the replay.
  const seen = new Set<string>();
  const merged: CachedEvent[] = [];
  for (const ev of [...known, ...fresh]) {
    const id = `${ev.blockNumber}:${ev.logIndex}`;
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(ev);
  }

  writeCache(chainId, fpmm, {
    fromBlock: (cached ? BigInt(cached.fromBlock) : fromBlock).toString(),
    toBlock: latest.toString(),
    events: merged,
  });

  const stamps = await fetchTimestamps(client, merged);
  return { events: merged, stamps };
}

/**
 * Locate the market's creation block from the factory's MarketCreated event.
 *
 * This is the one query that must span all of history, so its result is what
 * makes every later scan narrow. Cached per market under its own key. If it
 * cannot be found, we return `latest` rather than 0 — scanning nothing is
 * better than scanning the entire chain and getting rate limited.
 */
async function findCreationBlock(
  client: Client,
  factory: `0x${string}`,
  questionId: bigint,
  latest: bigint
): Promise<bigint> {
  const cacheKey = `${factory.toLowerCase()}:${questionId.toString()}`;
  const hit = creationBlocks.get(cacheKey);
  if (hit !== undefined) return hit;

  try {
    const created = await enqueueRpc(() =>
      client.getLogs({
        address: factory,
        event: EV_MARKET_CREATED,
        args: { questionId },
        fromBlock: BigInt(0),
        toBlock: latest,
      })
    );
    if (created.length > 0 && created[0].blockNumber !== null) {
      const block = created[0].blockNumber;
      creationBlocks.set(cacheKey, block);
      return block;
    }
  } catch (err) {
    // A rate-limited lookup must propagate: silently falling back to a full
    // scan is exactly what caused the 429 storm this rewrite fixes.
    if (isRateLimit(err)) throw err;
  }

  creationBlocks.set(cacheKey, latest);
  return latest;
}

/** Creation blocks are immutable, so a plain module map is the right cache. */
const creationBlocks = new Map<string, bigint>();

/**
 * Block timestamps, deduped and cached across pools.
 *
 * Many events share a block, and blocks are immutable, so this is a pure win.
 * Fetched serially through the queue to avoid a burst of getBlock calls.
 */
const blockStamps = new Map<string, number>();

async function fetchTimestamps(
  client: Client,
  events: CachedEvent[]
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const needed: string[] = [];

  for (const ev of events) {
    const key = ev.blockNumber;
    const hit = blockStamps.get(key);
    if (hit !== undefined) {
      out[key] = hit;
    } else if (!needed.includes(key)) {
      needed.push(key);
    }
  }

  for (const key of needed) {
    try {
      const blk = await enqueueRpc(() => client.getBlock({ blockNumber: BigInt(key) }));
      const ts = Number(blk.timestamp);
      blockStamps.set(key, ts);
      out[key] = ts;
    } catch (err) {
      if (isRateLimit(err)) throw err;
      // Otherwise skip: the point is dropped rather than dated wrongly.
    }
  }

  return out;
}

/**
 * Fetch the four FPMM events across a block range in chunks, tolerating RPCs
 * that cap getLogs spans. Every request goes through the shared queue.
 */
async function fetchLogsChunked(
  client: Client,
  address: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint
): Promise<CachedEvent[]> {
  const out: CachedEvent[] = [];
  let start = fromBlock;
  let chunks = 0;

  while (start <= toBlock && chunks < MAX_CHUNKS) {
    const end = start + LOG_CHUNK > toBlock ? toBlock : start + LOG_CHUNK;

    // One request per event type: viem's multi-event overload widens args to a
    // union that erases the per-event names, so four narrow queries are both
    // simpler and better typed. Serialized by the queue rather than run with
    // Promise.all, so a chunk costs 4 spaced requests instead of a burst of 4.
    const buys = await enqueueRpc(() =>
      client.getLogs({ address, event: EV_BUY, fromBlock: start, toBlock: end })
    );
    const sells = await enqueueRpc(() =>
      client.getLogs({ address, event: EV_SELL, fromBlock: start, toBlock: end })
    );
    const adds = await enqueueRpc(() =>
      client.getLogs({ address, event: EV_LIQ_ADD, fromBlock: start, toBlock: end })
    );
    const removes = await enqueueRpc(() =>
      client.getLogs({ address, event: EV_LIQ_REMOVE, fromBlock: start, toBlock: end })
    );

    const push = (
      logs: readonly { blockNumber: bigint | null; logIndex: number | null; args: unknown }[],
      name: string
    ) => {
      for (const l of logs) {
        if (l.blockNumber === null || l.logIndex === null) continue;
        out.push({
          blockNumber: l.blockNumber.toString(),
          logIndex: l.logIndex,
          name,
          args: stringifyArgs(l.args),
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

/** Normalize decoded args to strings so they survive JSON persistence. */
function stringifyArgs(args: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!args || typeof args !== 'object') return out;
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (typeof v === 'bigint') out[k] = v.toString();
    else if (typeof v === 'number' || typeof v === 'string') out[k] = String(v);
    else if (typeof v === 'boolean') out[k] = v ? '1' : '0';
  }
  return out;
}

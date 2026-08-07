'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from 'wagmi';
import { erc20Abi, fpmmAbi, conditionalTokensAbi } from '@/lib/abis';
import { sanitizeText } from '@/lib/sanitize';
import { formatUsdc, parseUsdc } from '@/lib/format';
import {
  formatProbPct,
  sharePriceUsdc,
  avgBuyPrice,
  minSharesOut,
  maxSharesIn,
} from '@/lib/pricing';
import { ErrorNote, Badge } from './ui';

type Mode = 'buy' | 'sell';
type Outcome = 0 | 1;

/** Slippage presets in bps. Custom entry is deliberately omitted: these cover
 *  real use and an unbounded field is a footgun on a thin-liquidity AMM. */
const SLIPPAGE_OPTIONS = [50, 100, 300] as const;

const QUICK_AMOUNTS = ['1', '10', '50', '100'] as const;

/**
 * Buy/sell panel for a single binary market.
 *
 * Owns its own form state and approval flow so it can sit beside the chart and
 * be reused for any outcome of a multi-outcome event.
 */
export function TradePanel({
  fpmm,
  collateralToken,
  conditionalTokens,
  yesBps,
  resolved,
  hasLiquidity,
  initialOutcome = 0,
  yesShares,
  noShares,
  onTraded,
}: {
  fpmm: `0x${string}` | undefined;
  collateralToken: `0x${string}` | undefined;
  conditionalTokens: `0x${string}` | undefined;
  yesBps: number;
  resolved: boolean;
  hasLiquidity: boolean;
  initialOutcome?: Outcome;
  yesShares: bigint;
  noShares: bigint;
  onTraded?: () => void;
}) {
  const { address, isConnected } = useAccount();
  const [mode, setMode] = useState<Mode>('buy');
  const [outcome, setOutcome] = useState<Outcome>(initialOutcome);
  const [amountInput, setAmountInput] = useState('');
  const [slippageBps, setSlippageBps] = useState<number>(100);
  const [error, setError] = useState('');

  // Reflect a ?side= deep link, but only until the user picks a side themselves.
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setOutcome(initialOutcome);
  }, [initialOutcome, touched]);

  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: txWaiting, isSuccess: txDone } = useWaitForTransactionReceipt({ hash: txHash });
  const working = isPending || txWaiting;

  useEffect(() => {
    if (txDone) {
      setAmountInput('');
      onTraded?.();
    }
  }, [txDone, onTraded]);

  const amount = parseUsdc(amountInput); // BigInt(0) on invalid input, never throws
  const heldShares = outcome === 0 ? yesShares : noShares;

  const { data: balance } = useReadContract({
    address: collateralToken,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!collateralToken },
  });

  const { data: allowance } = useReadContract({
    address: collateralToken,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address && fpmm ? [address, fpmm] : undefined,
    query: { enabled: !!address && !!collateralToken && !!fpmm },
  });

  const { data: isOperator } = useReadContract({
    address: conditionalTokens,
    abi: conditionalTokensAbi,
    functionName: 'isApprovedForAll',
    args: address && fpmm ? [address, fpmm] : undefined,
    query: { enabled: !!address && !!conditionalTokens && !!fpmm },
  });

  const { data: buyQuote } = useReadContract({
    address: fpmm,
    abi: fpmmAbi,
    functionName: 'calcBuyAmount',
    args: [BigInt(outcome), amount],
    query: { enabled: !!fpmm && mode === 'buy' && amount > BigInt(0) },
  });

  const { data: sellQuote } = useReadContract({
    address: fpmm,
    abi: fpmmAbi,
    functionName: 'calcSellAmount',
    args: [BigInt(outcome), amount],
    query: { enabled: !!fpmm && mode === 'sell' && amount > BigInt(0) },
  });

  const quote = (mode === 'buy' ? buyQuote : sellQuote) as bigint | undefined;

  // Worst-case bound the user is actually signing, shown explicitly.
  const worstCase = useMemo(() => {
    if (quote === undefined) return null;
    return mode === 'buy' ? minSharesOut(quote, slippageBps) : maxSharesIn(quote, slippageBps);
  }, [quote, mode, slippageBps]);

  const insufficientBalance =
    mode === 'buy' && amount > BigInt(0) && balance !== undefined && amount > (balance as bigint);
  const insufficientShares =
    mode === 'sell' && worstCase !== null && worstCase > heldShares;

  const needsErc20Approval =
    mode === 'buy' && amount > BigInt(0) && (allowance ?? BigInt(0)) < amount;
  const needsOperatorApproval = mode === 'sell' && amount > BigInt(0) && !isOperator;

  function onError(err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Contract custom errors are far more useful than the raw RPC dump.
    const friendly = friendlyError(msg);
    setError(friendly || sanitizeText(msg).slice(0, 200) || 'Transaction failed');
  }

  function guard(): boolean {
    if (!fpmm || !collateralToken) {
      setError('Market is not fully loaded yet. Try again in a moment.');
      return false;
    }
    if (amount <= BigInt(0)) {
      setError('Enter an amount greater than zero.');
      return false;
    }
    return true;
  }

  function handleApproveErc20() {
    if (!guard() || !collateralToken || !fpmm) return;
    setError('');
    writeContract(
      { address: collateralToken, abi: erc20Abi, functionName: 'approve', args: [fpmm, amount] },
      { onError }
    );
  }

  function handleApproveOperator() {
    if (!conditionalTokens || !fpmm) {
      setError('Market is not fully loaded yet. Try again in a moment.');
      return;
    }
    setError('');
    writeContract(
      {
        address: conditionalTokens,
        abi: conditionalTokensAbi,
        functionName: 'setApprovalForAll',
        args: [fpmm, true],
      },
      { onError }
    );
  }

  function handleTrade() {
    if (!guard() || !fpmm || quote === undefined || worstCase === null) return;
    setError('');
    if (mode === 'buy') {
      writeContract(
        {
          address: fpmm,
          abi: fpmmAbi,
          functionName: 'buy',
          args: [BigInt(outcome), amount, worstCase],
        },
        { onError }
      );
    } else {
      writeContract(
        {
          address: fpmm,
          abi: fpmmAbi,
          functionName: 'sell',
          args: [BigInt(outcome), amount, worstCase],
        },
        { onError }
      );
    }
  }

  if (resolved) {
    return (
      <Panel>
        <div className="rounded-lg bg-surface-sunken px-3 py-6 text-center">
          <p className="text-sm font-medium text-content">Market resolved</p>
          <p className="mt-1 text-xs text-content-muted">
            Trading is closed. Winning shares can be redeemed from your position.
          </p>
        </div>
      </Panel>
    );
  }

  if (!isConnected) {
    return (
      <Panel>
        <div className="rounded-lg bg-surface-sunken px-3 py-6 text-center">
          <p className="text-sm font-medium text-content">Connect a wallet to trade</p>
          <p className="mt-1 text-xs text-content-muted">
            Browsing and price history are open to everyone.
          </p>
        </div>
      </Panel>
    );
  }

  const noBps = 10000 - yesBps;
  const actionLabel = mode === 'buy' ? 'Buy' : 'Sell';
  const disabled =
    working ||
    amount <= BigInt(0) ||
    quote === undefined ||
    quote === BigInt(0) ||
    insufficientBalance ||
    insufficientShares;

  return (
    <Panel>
      {/* Buy / Sell */}
      <div className="mb-3 grid grid-cols-2 gap-1 rounded-lg bg-surface-sunken p-1">
        {(['buy', 'sell'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              setError('');
              setAmountInput('');
            }}
            aria-pressed={mode === m}
            className={`rounded-md py-1.5 text-xs font-semibold capitalize transition-colors ${
              mode === m ? 'bg-surface-raised text-content shadow-sm' : 'text-content-muted hover:text-content'
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      {/* Outcome */}
      <div className="mb-3 grid grid-cols-2 gap-2">
        <OutcomeButton
          active={outcome === 0}
          tone="yes"
          label="Yes"
          price={sharePriceUsdc(yesBps)}
          pct={formatProbPct(yesBps)}
          onClick={() => {
            setOutcome(0);
            setTouched(true);
            setError('');
          }}
        />
        <OutcomeButton
          active={outcome === 1}
          tone="no"
          label="No"
          price={sharePriceUsdc(noBps)}
          pct={formatProbPct(noBps)}
          onClick={() => {
            setOutcome(1);
            setTouched(true);
            setError('');
          }}
        />
      </div>

      {/* Amount */}
      <label htmlFor="trade-amount" className="mb-1 block text-2xs font-medium text-content-muted">
        {mode === 'buy' ? 'You spend (USDC)' : 'You receive (USDC)'}
      </label>
      <input
        id="trade-amount"
        type="text"
        inputMode="decimal"
        value={amountInput}
        onChange={(e) => {
          setAmountInput(e.target.value);
          setError('');
        }}
        placeholder="0.00"
        disabled={working}
        className="h-10 w-full rounded-lg border border-edge bg-surface px-3 text-sm tabular-nums text-content placeholder:text-content-subtle disabled:opacity-60"
      />

      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {QUICK_AMOUNTS.map((q) => (
          <button
            key={q}
            type="button"
            disabled={working}
            onClick={() => {
              setAmountInput(q);
              setError('');
            }}
            className="rounded border border-edge px-1.5 py-0.5 text-2xs text-content-muted transition-colors hover:border-edge-strong hover:text-content disabled:opacity-50"
          >
            ${q}
          </button>
        ))}
        <span className="ml-auto text-2xs tabular-nums text-content-subtle">
          {mode === 'buy'
            ? `Balance ${balance !== undefined ? formatUsdc(balance as bigint) : '0'} USDC`
            : `Holding ${formatUsdc(heldShares)} ${outcome === 0 ? 'YES' : 'NO'}`}
        </span>
      </div>

      {/* Slippage */}
      <div className="mt-3 flex items-center justify-between">
        <span className="text-2xs font-medium text-content-muted">Max slippage</span>
        <div className="flex gap-0.5 rounded-md border border-edge p-0.5">
          {SLIPPAGE_OPTIONS.map((bps) => (
            <button
              key={bps}
              type="button"
              onClick={() => setSlippageBps(bps)}
              aria-pressed={slippageBps === bps}
              className={`rounded px-1.5 py-0.5 text-2xs font-medium tabular-nums transition-colors ${
                slippageBps === bps ? 'bg-content text-surface' : 'text-content-muted hover:text-content'
              }`}
            >
              {bps / 100}%
            </button>
          ))}
        </div>
      </div>

      {/* Quote summary */}
      {amount > BigInt(0) && (
        <dl className="mt-3 space-y-1 rounded-lg bg-surface-sunken px-3 py-2 text-2xs">
          <Row
            label={mode === 'buy' ? 'Shares received' : 'Shares sold'}
            value={quote !== undefined ? formatUsdc(quote) : '—'}
          />
          {mode === 'buy' && quote !== undefined && quote > BigInt(0) && (
            <Row label="Avg price / share" value={`$${avgBuyPrice(amount, quote)}`} />
          )}
          <Row
            label={mode === 'buy' ? 'Minimum received' : 'Maximum sold'}
            value={worstCase !== null ? formatUsdc(worstCase) : '—'}
            emphasis
          />
        </dl>
      )}

      {!hasLiquidity && (
        <p className="mt-3 rounded-lg bg-surface-sunken px-3 py-2 text-2xs text-warn">
          This market has no liquidity yet, so trades will revert. An admin needs to fund it first.
        </p>
      )}

      {insufficientBalance && (
        <p className="mt-3 text-2xs text-no">Amount exceeds your USDC balance.</p>
      )}
      {insufficientShares && (
        <p className="mt-3 text-2xs text-no">
          You do not hold enough {outcome === 0 ? 'YES' : 'NO'} shares for this sale.
        </p>
      )}

      {error && (
        <div className="mt-3">
          <ErrorNote message={error} />
        </div>
      )}

      <div className="mt-3">
        {needsErc20Approval ? (
          <Action onClick={handleApproveErc20} working={working} label="Approve USDC" />
        ) : needsOperatorApproval ? (
          <Action onClick={handleApproveOperator} working={working} label="Approve shares" />
        ) : (
          <Action
            onClick={handleTrade}
            working={working}
            disabled={disabled}
            label={`${actionLabel} ${outcome === 0 ? 'Yes' : 'No'}`}
            tone={outcome === 0 ? 'yes' : 'no'}
          />
        )}
      </div>
    </Panel>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="rounded-card border border-edge bg-surface-raised p-4">{children}</div>;
}

function Row({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className="text-content-subtle">{label}</dt>
      <dd className={`tabular-nums ${emphasis ? 'font-medium text-content' : 'text-content-muted'}`}>
        {value}
      </dd>
    </div>
  );
}

function OutcomeButton({
  active,
  tone,
  label,
  price,
  pct,
  onClick,
}: {
  active: boolean;
  tone: 'yes' | 'no';
  label: string;
  price: string;
  pct: string;
  onClick: () => void;
}) {
  const activeCls =
    tone === 'yes' ? 'border-yes bg-yes-soft text-yes' : 'border-no bg-no-soft text-no';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-lg border px-3 py-2 text-left transition-colors ${
        active ? activeCls : 'border-edge text-content-muted hover:border-edge-strong'
      }`}
    >
      <span className="block text-xs font-semibold">{label}</span>
      <span className="block text-2xs tabular-nums opacity-80">
        ${price} · {pct}
      </span>
    </button>
  );
}

function Action({
  onClick,
  working,
  label,
  disabled,
  tone = 'brand',
}: {
  onClick: () => void;
  working: boolean;
  label: string;
  disabled?: boolean;
  tone?: 'brand' | 'yes' | 'no';
}) {
  const tones = {
    brand: 'bg-brand hover:bg-brand-hover',
    yes: 'bg-yes hover:opacity-90',
    no: 'bg-no hover:opacity-90',
  } as const;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={working || disabled}
      className={`h-10 w-full rounded-lg text-sm font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40 ${tones[tone]}`}
    >
      {working ? 'Confirming…' : label}
    </button>
  );
}

/** Map known contract/wallet failures onto plain language. */
function friendlyError(raw: string): string {
  const m = raw.toLowerCase();
  if (m.includes('user rejected') || m.includes('user denied')) return 'Transaction rejected in wallet.';
  if (m.includes('slippageexceeded')) return 'Price moved beyond your slippage limit. Try again or raise the tolerance.';
  if (m.includes('insufficientliquidity')) return 'Not enough liquidity in this pool for that size.';
  if (m.includes('returnexceedsreserves')) return 'That payout is larger than the pool can cover. Try a smaller amount.';
  if (m.includes('zeroamount')) return 'Enter an amount greater than zero.';
  if (m.includes('invalidoutcome')) return 'Invalid outcome selected.';
  if (m.includes('enforcedpause') || m.includes('paused')) return 'Trading is paused on this market.';
  if (m.includes('erc20insufficientallowance')) return 'USDC approval is too low. Approve again.';
  if (m.includes('erc20insufficientbalance')) return 'Insufficient USDC balance.';
  if (m.includes('erc1155missingapprovalforall')) return 'Share approval missing. Approve shares first.';
  if (m.includes('insufficient funds')) return 'Not enough native USDC to cover gas.';
  return '';
}

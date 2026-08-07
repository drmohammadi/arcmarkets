'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useChainId, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { Header } from '@/components/Header';
import { PriceChart } from '@/components/PriceChart';
import { TradePanel } from '@/components/TradePanel';
import { MarketIcon, Badge, ProbabilityBar, EmptyState, Skeleton, ErrorNote } from '@/components/ui';
import { useMarket } from '@/hooks/useMarket';
import { useMarkets } from '@/hooks/useMarkets';
import { useMarketPools } from '@/hooks/useMarketPools';
import { usePosition } from '@/hooks/usePosition';
import { usePriceHistory } from '@/hooks/usePriceHistory';
import { useMarketImage } from '@/hooks/useMarketImage';
import { getDeployment } from '@/lib/contracts';
import { conditionalTokensAbi } from '@/lib/abis';
import { sanitizeText, shortAddress } from '@/lib/sanitize';
import { formatUsdc, formatUsdcCompact } from '@/lib/format';
import { yesProbBps, formatProbPct, sharePriceUsdc } from '@/lib/pricing';
import { categoryLabel, normalizeCategory } from '@/lib/marketMeta';
import { groupMarkets, findGroupFor, parseQuestion } from '@/lib/eventGroups';
import { formatResolutionDateTime, formatTimeLeft } from '@/lib/time';

export default function MarketPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const chainId = useChainId();
  const deployment = getDeployment(chainId);

  const rawId = params?.id as string | undefined;
  // Route param must be a plain non-negative integer of sane length.
  const validId = typeof rawId === 'string' && /^\d{1,18}$/.test(rawId);
  const questionId = validId ? BigInt(rawId) : null;

  const market = useMarket(questionId);
  const { markets } = useMarkets();
  const { poolFor } = useMarketPools(markets);
  const position = usePosition(market.fpmm, market.conditionalTokens);
  const marketImage = useMarketImage(questionId);

  const [nowSec, setNowSec] = useState<bigint>(BigInt(0));
  useEffect(() => {
    const tick = () => setNowSec(BigInt(Math.floor(Date.now() / 1000)));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  const history = usePriceHistory(
    market.fpmm,
    deployment?.marketFactory as `0x${string}` | undefined,
    questionId,
    market.reserveYes,
    market.reserveNo
  );

  const group = useMemo(() => {
    if (questionId === null || markets.length === 0) return null;
    return findGroupFor(groupMarkets(markets), questionId);
  }, [markets, questionId]);

  // Re-read the user's balances after a trade or redemption, and pull the new
  // trade into the chart. The history hook no longer polls (that was the source
  // of the RPC rate limiting), so this explicit refresh is what keeps the chart
  // current; it resumes from the cached block tail rather than rescanning.
  //
  // Depends on the two FUNCTION references, not on the hook result objects:
  // those are new identities every render, and PositionCard calls this from an
  // effect that keys on it while isSuccess stays true — an unstable callback
  // there would loop forever and hammer the RPC.
  const refetchPosition = position.refetch;
  const refreshHistory = history.refresh;
  const refetchAll = useCallback(() => {
    refetchPosition();
    refreshHistory();
  }, [refetchPosition, refreshHistory]);

  if (!validId) {
    return (
      <Shell>
        <EmptyState
          title="Invalid market link"
          hint="That market id isn't a valid number."
          action={<BackLink />}
        />
      </Shell>
    );
  }

  if (market.isLoading) {
    return (
      <Shell>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-4">
            <Skeleton className="h-20 w-full rounded-card" />
            <Skeleton className="h-[260px] w-full rounded-card" />
          </div>
          <Skeleton className="h-[420px] w-full rounded-card" />
        </div>
      </Shell>
    );
  }

  if (!market.exists) {
    return (
      <Shell>
        <EmptyState
          title="Market not found"
          hint="This market doesn't exist on the connected network."
          action={<BackLink />}
        />
      </Shell>
    );
  }

  const fullQuestion = sanitizeText(market.question) || 'Untitled market';
  const parsed = parseQuestion(market.question);
  const isGrouped = !!group?.isMultiOutcome;
  const heading = isGrouped ? parsed.outcomeLabel : fullQuestion;
  const eventTitle = isGrouped ? group.title : null;

  const yesBps = yesProbBps(market.reserveYes, market.reserveNo);
  const hasLiquidity = market.reserveYes + market.reserveNo > BigInt(0);
  const category = normalizeCategory(market.category, market.question);
  const liquidity =
    market.reserveYes < market.reserveNo ? market.reserveYes : market.reserveNo;

  // ?side=no preselects NO on the trade panel from a card's quick-buy link.
  const sideParam = searchParams?.get('side');
  const initialOutcome: 0 | 1 = sideParam === 'no' ? 1 : 0;

  return (
    <Shell>
      <nav className="mb-4 flex items-center gap-1.5 text-xs text-content-subtle">
        <Link href="/" className="hover:text-content">
          Markets
        </Link>
        <span aria-hidden="true">/</span>
        <span className="truncate text-content-muted">{eventTitle ?? heading}</span>
      </nav>

      {/* Header */}
      <div className="mb-5 flex items-start gap-3">
        <MarketIcon
          seed={market.fpmm ?? fullQuestion}
          text={eventTitle ?? fullQuestion}
          size="lg"
          src={marketImage}
        />
        <div className="min-w-0 flex-1">
          {eventTitle && (
            <p className="text-xs font-medium text-content-muted">{eventTitle}</p>
          )}
          <h1 className="text-lg font-semibold leading-tight tracking-tight text-content sm:text-xl">
            {heading}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-content-subtle">
            <Badge tone="neutral">{categoryLabel(category)}</Badge>
            {market.resolved ? (
              <Badge tone="brand">Resolved</Badge>
            ) : (
              <span>{formatTimeLeft(market.resolutionTime, nowSec)}</span>
            )}
            <span>Resolves {formatResolutionDateTime(market.resolutionTime)}</span>
            <span>Liquidity ${formatUsdcCompact(liquidity)}</span>
            <span>Resolver {shortAddress(market.resolver)}</span>
          </div>
        </div>
      </div>

      {/* Two-column on desktop, stacked on mobile. Trade panel sticks on scroll. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <div className="min-w-0 space-y-4">
          <PriceChart
            points={history.points}
            isLoading={history.isLoading}
            error={history.error}
            verified={history.verified}
            rateLimited={history.rateLimited}
            currentBps={yesBps}
            nowSec={nowSec}
          />

          {/* Current odds summary */}
          <div className="rounded-card border border-edge bg-surface-raised p-4">
            <div className="mb-3 grid grid-cols-2 gap-3">
              <OddsTile label="Yes" bps={yesBps} tone="yes" />
              <OddsTile label="No" bps={10000 - yesBps} tone="no" />
            </div>
            <ProbabilityBar yesBps={yesBps} showLabels />
            {!hasLiquidity && (
              <p className="mt-3 text-2xs text-warn">
                No liquidity in this pool yet — the 50/50 split shown is a placeholder, not a
                market price.
              </p>
            )}
          </div>

          {isGrouped && group && (
            <SiblingOutcomes
              group={group}
              activeId={questionId}
              poolFor={poolFor}
            />
          )}

          <PositionCard
            yesShares={position.yesShares}
            noShares={position.noShares}
            resolved={market.resolved}
            conditionalTokens={market.conditionalTokens}
            collateralToken={market.collateralToken}
            conditionId={market.conditionId as `0x${string}` | undefined}
            onRedeemed={refetchAll}
          />
        </div>

        <div className="lg:sticky lg:top-4">
          <TradePanel
            fpmm={market.fpmm}
            collateralToken={market.collateralToken}
            conditionalTokens={market.conditionalTokens}
            yesBps={yesBps}
            resolved={market.resolved}
            hasLiquidity={hasLiquidity}
            initialOutcome={initialOutcome}
            yesShares={position.yesShares}
            noShares={position.noShares}
            onTraded={refetchAll}
          />
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex-1">
      <Header />
      <div id="main" className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        {children}
      </div>
    </main>
  );
}

function BackLink() {
  return (
    <Link href="/" className="text-sm font-medium text-brand hover:underline">
      Back to markets
    </Link>
  );
}

function OddsTile({ label, bps, tone }: { label: string; bps: number; tone: 'yes' | 'no' }) {
  return (
    <div className="rounded-lg bg-surface-sunken px-3 py-2">
      <p className="text-2xs font-medium uppercase tracking-wide text-content-subtle">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${tone === 'yes' ? 'text-yes' : 'text-no'}`}>
        {formatProbPct(bps)}
      </p>
      <p className="text-2xs tabular-nums text-content-subtle">${sharePriceUsdc(bps)} per share</p>
    </div>
  );
}

/** Other outcomes in the same event, each linking to its own market. */
function SiblingOutcomes({
  group,
  activeId,
  poolFor,
}: {
  group: NonNullable<ReturnType<typeof findGroupFor>>;
  activeId: bigint | null;
  poolFor: (id: bigint) => { yesBps: number; hasLiquidity: boolean };
}) {
  return (
    <section className="rounded-card border border-edge bg-surface-raised p-4">
      <h2 className="mb-3 text-sm font-semibold text-content">
        All outcomes
        <span className="ml-1.5 text-2xs font-normal text-content-subtle">
          each trades as its own YES/NO market
        </span>
      </h2>
      <ul className="space-y-1">
        {group.markets.map((v) => {
          const id = v.market.questionId;
          const pool = poolFor(id);
          const active = activeId !== null && id === activeId;
          return (
            <li key={id.toString()}>
              <Link
                href={`/market/${id.toString()}`}
                aria-current={active ? 'true' : undefined}
                className={`flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors ${
                  active ? 'bg-surface-sunken' : 'hover:bg-surface-sunken'
                }`}
              >
                <span className="min-w-0 flex-1 truncate text-xs text-content">
                  {v.outcomeLabel}
                </span>
                {v.market.resolved && <Badge tone="brand">Resolved</Badge>}
                <span className="shrink-0 text-xs font-semibold tabular-nums text-content">
                  {pool.hasLiquidity ? formatProbPct(pool.yesBps, 0) : '—'}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The user's shares in this market, plus redemption once resolved. */
function PositionCard({
  yesShares,
  noShares,
  resolved,
  conditionalTokens,
  collateralToken,
  conditionId,
  onRedeemed,
}: {
  yesShares: bigint;
  noShares: bigint;
  resolved: boolean;
  conditionalTokens: `0x${string}` | undefined;
  collateralToken: `0x${string}` | undefined;
  conditionId: `0x${string}` | undefined;
  onRedeemed: () => void;
}) {
  const [error, setError] = useState('');
  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: waiting, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });
  const working = isPending || waiting;

  useEffect(() => {
    if (isSuccess) onRedeemed();
  }, [isSuccess, onRedeemed]);

  if (yesShares <= BigInt(0) && noShares <= BigInt(0)) return null;

  function handleRedeem() {
    if (!conditionalTokens || !collateralToken || !conditionId) {
      setError('Market data is still loading. Try again in a moment.');
      return;
    }
    setError('');
    writeContract(
      {
        address: conditionalTokens,
        abi: conditionalTokensAbi,
        functionName: 'redeemPositions',
        args: [collateralToken, conditionId],
      },
      {
        onError: (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          setError(
            msg.toLowerCase().includes('nowinningshares')
              ? 'No winning shares to redeem in this market.'
              : sanitizeText(msg).slice(0, 200) || 'Redeem failed'
          );
        },
      }
    );
  }

  return (
    <section className="rounded-card border border-edge bg-surface-raised p-4">
      <h2 className="mb-2 text-sm font-semibold text-content">Your position</h2>
      <div className="flex flex-wrap gap-4 text-xs text-content-muted">
        {yesShares > BigInt(0) && (
          <span className="tabular-nums">
            <span className="font-medium text-yes">YES</span> {formatUsdc(yesShares)} shares
          </span>
        )}
        {noShares > BigInt(0) && (
          <span className="tabular-nums">
            <span className="font-medium text-no">NO</span> {formatUsdc(noShares)} shares
          </span>
        )}
      </div>

      {resolved && (
        <button
          type="button"
          onClick={handleRedeem}
          disabled={working}
          className="mt-3 h-9 rounded-lg bg-brand px-4 text-xs font-semibold text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
        >
          {working ? 'Redeeming…' : 'Redeem winnings'}
        </button>
      )}

      {error && (
        <div className="mt-3">
          <ErrorNote message={error} />
        </div>
      )}
    </section>
  );
}

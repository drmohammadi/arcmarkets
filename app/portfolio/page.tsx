'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useAccount, useChainId, useReadContracts } from 'wagmi';
import { Header } from '@/components/Header';
import { MarketAvatar, Badge, EmptyState, Skeleton } from '@/components/ui';
import { useMarkets } from '@/hooks/useMarkets';
import { useMarketPools } from '@/hooks/useMarketPools';
import { getDeployment } from '@/lib/contracts';
import { fpmmAbi, conditionalTokensAbi } from '@/lib/abis';
import { formatUsdc } from '@/lib/format';
import { formatProbPct } from '@/lib/pricing';
import { parseQuestion } from '@/lib/eventGroups';
import { formatResolutionDate } from '@/lib/time';

const ZERO = BigInt(0);

export default function PortfolioPage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const deployment = getDeployment(chainId);
  const { markets, isLoading } = useMarkets();
  const { poolFor } = useMarketPools(markets);

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Round 1: position IDs for every market.
  const { data: posIdData } = useReadContracts({
    contracts: markets.flatMap((m) => [
      { address: m.fpmm as `0x${string}`, abi: fpmmAbi, functionName: 'yesPositionId' as const },
      { address: m.fpmm as `0x${string}`, abi: fpmmAbi, functionName: 'noPositionId' as const },
    ]),
    query: { enabled: markets.length > 0 },
  });

  // Round 2: the connected wallet's balance for each of those IDs.
  const balanceContracts = useMemo(
    () =>
      markets.flatMap((_, i) => {
        const yesId =
          posIdData?.[i * 2]?.status === 'success' ? (posIdData[i * 2].result as bigint) : undefined;
        const noId =
          posIdData?.[i * 2 + 1]?.status === 'success'
            ? (posIdData[i * 2 + 1].result as bigint)
            : undefined;
        const ct = deployment?.conditionalTokens as `0x${string}` | undefined;
        return [
          {
            address: ct,
            abi: conditionalTokensAbi,
            functionName: 'balanceOf' as const,
            args: address && yesId !== undefined ? [address, yesId] : undefined,
          },
          {
            address: ct,
            abi: conditionalTokensAbi,
            functionName: 'balanceOf' as const,
            args: address && noId !== undefined ? [address, noId] : undefined,
          },
        ];
      }),
    [markets, posIdData, address, deployment]
  );

  const { data: balData, isLoading: balLoading } = useReadContracts({
    contracts: balanceContracts,
    query: { enabled: !!address && !!deployment && markets.length > 0 && !!posIdData },
  });

  const positions = useMemo(
    () =>
      markets
        .map((m, i) => {
          const yes = balData?.[i * 2]?.status === 'success' ? (balData[i * 2].result as bigint) : ZERO;
          const no =
            balData?.[i * 2 + 1]?.status === 'success' ? (balData[i * 2 + 1].result as bigint) : ZERO;
          return { market: m, yes, no };
        })
        .filter((p) => p.yes > ZERO || p.no > ZERO),
    [markets, balData]
  );

  // Current mark-to-market value: each share is worth its implied probability
  // until resolution. This is an estimate of exit value, not a guaranteed price.
  const totals = useMemo(() => {
    let value = ZERO;
    let redeemable = ZERO;
    for (const p of positions) {
      const pool = poolFor(p.market.questionId);
      const yesBps = BigInt(pool.yesBps);
      const noBps = BigInt(10000 - pool.yesBps);
      const v = (p.yes * yesBps + p.no * noBps) / BigInt(10000);
      value += v;
      if (p.market.resolved) redeemable += v;
    }
    return { value, redeemable };
  }, [positions, poolFor]);

  const loading = isLoading || balLoading;

  return (
    <main className="flex-1">
      <Header />
      <div id="main" className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
        <h1 className="mb-1 text-xl font-semibold tracking-tight text-content sm:text-2xl">
          Portfolio
        </h1>
        <p className="mb-6 text-sm text-content-muted">
          Your open positions across every market on Arc.
        </p>

        {!mounted ? (
          <Skeleton className="h-24 w-full rounded-card" />
        ) : !isConnected ? (
          <EmptyState
            title="Connect your wallet"
            hint="Your positions will appear here once a wallet is connected."
          />
        ) : loading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-20 w-full rounded-card" />
            ))}
          </div>
        ) : positions.length === 0 ? (
          <EmptyState
            title="No open positions"
            hint="Buy YES or NO on any market and it will show up here."
            action={
              <Link href="/" className="text-sm font-medium text-brand hover:underline">
                Browse markets
              </Link>
            }
          />
        ) : (
          <>
            <div className="mb-5 grid grid-cols-2 gap-3">
              <SummaryTile label="Estimated value" value={`$${formatUsdc(totals.value)}`} />
              <SummaryTile label="Redeemable now" value={`$${formatUsdc(totals.redeemable)}`} />
            </div>

            <ul className="space-y-2">
              {positions.map(({ market, yes, no }) => {
                const pool = poolFor(market.questionId);
                const parsed = parseQuestion(market.question);
                const title = parsed.eventTitle
                  ? `${parsed.eventTitle}: ${parsed.outcomeLabel}`
                  : parsed.outcomeLabel || 'Untitled market';
                return (
                  <li key={market.questionId.toString()}>
                    <Link
                      href={`/market/${market.questionId.toString()}`}
                      className="flex items-start gap-3 rounded-card border border-edge bg-surface-raised p-3 transition-colors hover:border-edge-strong"
                    >
                      <MarketAvatar
                        questionId={market.questionId}
                        seed={market.fpmm}
                        text={title}
                        size="sm"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2 text-sm font-medium leading-snug text-content">
                          {title}
                        </p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-content-muted">
                          {yes > ZERO && (
                            <span className="tabular-nums">
                              <span className="font-medium text-yes">YES</span> {formatUsdc(yes)}
                            </span>
                          )}
                          {no > ZERO && (
                            <span className="tabular-nums">
                              <span className="font-medium text-no">NO</span> {formatUsdc(no)}
                            </span>
                          )}
                          <span className="tabular-nums text-content-subtle">
                            {pool.hasLiquidity ? `${formatProbPct(pool.yesBps)} yes` : 'no liquidity'}
                          </span>
                          <span className="text-content-subtle">
                            {formatResolutionDate(market.resolutionTime)}
                          </span>
                        </div>
                      </div>
                      {market.resolved ? (
                        <Badge tone="brand">Redeemable</Badge>
                      ) : (
                        <Badge tone="neutral">Open</Badge>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>

            <p className="mt-4 text-2xs text-content-subtle">
              Estimated value marks each share at the pool&apos;s current implied probability. Actual
              proceeds depend on liquidity and slippage at the time you sell.
            </p>
          </>
        )}
      </div>
    </main>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-edge bg-surface-raised px-3 py-2.5">
      <p className="text-2xs uppercase tracking-wide text-content-subtle">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-content">{value}</p>
    </div>
  );
}

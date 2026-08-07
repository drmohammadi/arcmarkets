'use client';

import Link from 'next/link';
import { MarketAvatar, Badge, ProbabilityBar } from './ui';
import { categoryLabel } from '@/lib/marketMeta';
import { formatProbPctCompact, formatProbPct } from '@/lib/pricing';
import { formatUsdcCompact } from '@/lib/format';
import { formatCountdown } from '@/lib/time';
import type { EventGroup, MarketView } from '@/lib/eventGroups';
import type { Pool } from '@/hooks/useMarketPools';

/**
 * Compact card for a standalone binary market.
 *
 * Density target: the whole card fits in ~112px so a 4-up grid shows many
 * markets without scrolling. Question is clamped to 2 lines.
 */
export function MarketCard({
  group,
  pool,
  nowSec,
}: {
  group: EventGroup;
  pool: Pool;
  nowSec: bigint;
}) {
  const view = group.markets[0];
  const m = view.market;
  const href = `/market/${m.questionId.toString()}`;
  const countdown = formatCountdown(m.resolutionTime, nowSec);

  return (
    <Link
      href={href}
      className="group flex h-full flex-col gap-3 rounded-card border border-edge bg-surface-raised p-3 transition-colors hover:border-edge-strong focus-visible:border-brand"
    >
      <div className="flex items-start gap-2.5">
        <MarketAvatar
          questionId={m.questionId}
          seed={m.fpmm || group.key}
          text={view.fullQuestion}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-medium leading-snug text-content">
            {view.fullQuestion || 'Untitled market'}
          </p>
          <p className="mt-1 text-2xs text-content-subtle">{categoryLabel(group.category)}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-base font-semibold tabular-nums text-content">
            {pool.hasLiquidity ? formatProbPctCompact(pool.yesBps) : '—'}
          </p>
          <p className="text-2xs text-content-subtle">yes</p>
        </div>
      </div>

      <ProbabilityBar yesBps={pool.yesBps} />

      <div className="mt-auto flex items-center justify-between text-2xs text-content-subtle">
        <span className="tabular-nums">
          {pool.hasLiquidity ? `$${formatUsdcCompact(pool.liquidity)} liq` : 'No liquidity'}
        </span>
        {m.resolved ? <Badge tone="brand">Resolved</Badge> : <span className="tabular-nums">{countdown}</span>}
      </div>
    </Link>
  );
}

/**
 * Card for a multi-outcome event: one row per member market, each row showing
 * that outcome's own probability and its own YES/NO entry points.
 *
 * Rows link to the individual binary market, which is where trading happens.
 * Long lists are capped with a "+N more" affordance to keep the card compact.
 */
export function EventGroupCard({
  group,
  poolFor,
  nowSec,
  maxRows = 3,
}: {
  group: EventGroup;
  poolFor: (questionId: bigint) => Pool;
  nowSec: bigint;
  maxRows?: number;
}) {
  const rows = group.markets.slice(0, maxRows);
  const hidden = group.markets.length - rows.length;
  const countdown = formatCountdown(group.earliestResolution, nowSec);
  const primaryHref = `/market/${group.markets[0].market.questionId.toString()}`;

  return (
    <div className="flex h-full flex-col gap-3 rounded-card border border-edge bg-surface-raised p-3">
      <div className="flex items-start gap-2.5">
        <MarketAvatar
          questionId={group.markets[0].market.questionId}
          seed={group.key}
          text={group.title}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <Link
            href={primaryHref}
            className="line-clamp-2 text-sm font-medium leading-snug text-content hover:underline"
          >
            {group.title}
          </Link>
          <p className="mt-1 flex items-center gap-1.5 text-2xs text-content-subtle">
            <span>{categoryLabel(group.category)}</span>
            <span aria-hidden="true">·</span>
            <span>{group.markets.length} outcomes</span>
          </p>
        </div>
        {group.allResolved ? (
          <Badge tone="brand">Resolved</Badge>
        ) : (
          <span className="shrink-0 text-2xs tabular-nums text-content-subtle">{countdown}</span>
        )}
      </div>

      <ul className="flex flex-col gap-1.5">
        {rows.map((view) => (
          <OutcomeRow key={view.market.questionId.toString()} view={view} pool={poolFor(view.market.questionId)} />
        ))}
      </ul>

      {hidden > 0 && (
        <Link
          href={primaryHref}
          className="mt-auto text-2xs font-medium text-brand hover:underline"
        >
          +{hidden} more {hidden === 1 ? 'outcome' : 'outcomes'}
        </Link>
      )}
    </div>
  );
}

/**
 * One outcome inside an event card. The YES/NO buttons are links that preselect
 * the side on the detail page — trading always happens against that outcome's
 * own FPMM, never a shared pool.
 */
function OutcomeRow({ view, pool }: { view: MarketView; pool: Pool }) {
  const id = view.market.questionId.toString();
  const label = view.outcomeLabel || 'Outcome';
  const noBps = 10000 - pool.yesBps;

  return (
    <li className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-xs text-content-muted" title={view.fullQuestion}>
        {label}
      </span>
      <span className="shrink-0 text-xs font-semibold tabular-nums text-content">
        {pool.hasLiquidity ? formatProbPctCompact(pool.yesBps) : '—'}
      </span>
      <span className="flex shrink-0 gap-1">
        <Link
          href={`/market/${id}?side=yes`}
          aria-label={`Buy YES on ${label} at ${formatProbPct(pool.yesBps)}`}
          className="rounded px-1.5 py-0.5 text-2xs font-semibold text-yes ring-1 ring-yes/30 transition-colors hover:bg-yes-soft"
        >
          Yes
        </Link>
        <Link
          href={`/market/${id}?side=no`}
          aria-label={`Buy NO on ${label} at ${formatProbPct(noBps)}`}
          className="rounded px-1.5 py-0.5 text-2xs font-semibold text-no ring-1 ring-no/30 transition-colors hover:bg-no-soft"
        >
          No
        </Link>
      </span>
    </li>
  );
}

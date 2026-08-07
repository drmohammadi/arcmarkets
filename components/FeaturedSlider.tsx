'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { MarketIcon, Badge } from './ui';
import { categoryLabel } from '@/lib/marketMeta';
import { formatProbPctCompact } from '@/lib/pricing';
import { formatUsdcCompact } from '@/lib/format';
import { formatCountdown } from '@/lib/time';
import type { EventGroup } from '@/lib/eventGroups';
import type { Pool } from '@/hooks/useMarketPools';

/**
 * Featured / popular markets rail.
 *
 * Native horizontal scroll with snap points rather than a JS carousel: it works
 * with touch, trackpad, keyboard and screen readers for free, needs no
 * dependency, and degrades gracefully if JS is slow to hydrate. The arrow
 * buttons are a progressive enhancement layered on top of real scroll.
 */
export function FeaturedSlider({
  groups,
  poolFor,
  nowSec,
}: {
  groups: EventGroup[];
  poolFor: (questionId: bigint) => Pool;
  nowSec: bigint;
}) {
  const railRef = useRef<HTMLUListElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  const sync = useCallback(() => {
    const el = railRef.current;
    if (!el) return;
    // 2px tolerance absorbs sub-pixel rounding at fractional zoom levels.
    setAtStart(el.scrollLeft <= 2);
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);
  }, []);

  useEffect(() => {
    sync();
    const el = railRef.current;
    if (!el) return;
    el.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync);
    return () => {
      el.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
    };
  }, [sync, groups.length]);

  function nudge(dir: -1 | 1) {
    const el = railRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(240, el.clientWidth * 0.8), behavior: 'smooth' });
  }

  if (groups.length === 0) return null;

  return (
    <section aria-labelledby="featured-heading" className="mb-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="featured-heading" className="text-sm font-semibold text-content">
          Featured
        </h2>
        <div className="flex gap-1">
          <RailButton dir={-1} disabled={atStart} onClick={() => nudge(-1)} />
          <RailButton dir={1} disabled={atEnd} onClick={() => nudge(1)} />
        </div>
      </div>

      <ul
        ref={railRef}
        className="no-scrollbar flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth pb-1"
      >
        {groups.map((g) => (
          <FeaturedCard key={g.key} group={g} poolFor={poolFor} nowSec={nowSec} />
        ))}
      </ul>
    </section>
  );
}

function RailButton({
  dir,
  disabled,
  onClick,
}: {
  dir: -1 | 1;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === -1 ? 'Scroll featured left' : 'Scroll featured right'}
      className="flex h-7 w-7 items-center justify-center rounded-md border border-edge text-content-muted transition-colors hover:border-edge-strong hover:text-content disabled:opacity-35 disabled:hover:border-edge"
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
        <path
          d={dir === -1 ? 'M10 3.5 5.5 8l4.5 4.5' : 'M6 3.5 10.5 8 6 12.5'}
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/**
 * Wider, richer card for the rail. Shows the leading outcome for a
 * multi-outcome event so the row communicates the current favourite.
 */
function FeaturedCard({
  group,
  poolFor,
  nowSec,
}: {
  group: EventGroup;
  poolFor: (questionId: bigint) => Pool;
  nowSec: bigint;
}) {
  // Leading outcome = highest implied YES probability among members.
  let lead = group.markets[0];
  let leadPool = poolFor(lead.market.questionId);
  for (const v of group.markets) {
    const p = poolFor(v.market.questionId);
    if (p.yesBps > leadPool.yesBps) {
      lead = v;
      leadPool = p;
    }
  }

  const href = `/market/${lead.market.questionId.toString()}`;
  const totalLiq = group.markets.reduce(
    (sum, v) => sum + poolFor(v.market.questionId).liquidity,
    BigInt(0)
  );

  return (
    <li className="w-[248px] shrink-0 snap-start sm:w-[272px]">
      <Link
        href={href}
        className="flex h-full flex-col gap-3 rounded-card border border-edge bg-surface-raised p-3.5 transition-colors hover:border-edge-strong"
      >
        <div className="flex items-start gap-2.5">
          <MarketIcon seed={group.key} text={group.title} size="md" />
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-sm font-medium leading-snug text-content">{group.title}</p>
            <p className="mt-1 text-2xs text-content-subtle">{categoryLabel(group.category)}</p>
          </div>
        </div>

        <div className="flex items-baseline justify-between">
          <span className="min-w-0 truncate text-xs text-content-muted">
            {group.isMultiOutcome ? lead.outcomeLabel : 'YES'}
          </span>
          <span className="shrink-0 text-lg font-semibold tabular-nums text-content">
            {leadPool.hasLiquidity ? formatProbPctCompact(leadPool.yesBps) : '—'}
          </span>
        </div>

        <div className="mt-auto flex items-center justify-between text-2xs text-content-subtle">
          <span className="tabular-nums">
            {totalLiq > BigInt(0) ? `$${formatUsdcCompact(totalLiq)} liq` : 'No liquidity'}
          </span>
          {group.allResolved ? (
            <Badge tone="brand">Resolved</Badge>
          ) : (
            <span className="tabular-nums">{formatCountdown(group.earliestResolution, nowSec)}</span>
          )}
        </div>
      </Link>
    </li>
  );
}

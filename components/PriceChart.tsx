'use client';

import { useMemo, useState } from 'react';
import type { PricePoint } from '@/hooks/usePriceHistory';
import { formatProbPct } from '@/lib/pricing';
import { formatChartTick, formatChartStamp } from '@/lib/time';
import { Skeleton } from './ui';

/**
 * Probability-over-time chart, hand-rolled as inline SVG.
 *
 * No charting library: the shapes needed here (one monotone-in-x line, an area
 * fill, a hover crosshair) are a few dozen lines of path math, and adding a
 * dependency for that would fail the project's per-dependency justification bar.
 *
 * Rendering notes:
 *  - viewBox + preserveAspectRatio="none" makes the plot fluidly responsive
 *    without a resize observer; stroke widths are compensated via vector-effect.
 *  - The series is also exposed as a <table> in a visually-hidden container so
 *    screen readers get the actual numbers rather than an opaque graphic.
 *  - Colour is never the only signal: the current value is always printed.
 */

const VIEW_W = 100;
const VIEW_H = 100;

export type RangeKey = '1d' | '1w' | 'all';

const RANGES: { key: RangeKey; label: string; seconds: number }[] = [
  { key: '1d', label: '1D', seconds: 86400 },
  { key: '1w', label: '1W', seconds: 604800 },
  { key: 'all', label: 'All', seconds: Number.MAX_SAFE_INTEGER },
];

export function PriceChart({
  points,
  isLoading,
  error,
  verified,
  currentBps,
  nowSec,
}: {
  points: PricePoint[];
  isLoading: boolean;
  error: string | null;
  verified: boolean;
  currentBps: number;
  nowSec: bigint;
}) {
  const [range, setRange] = useState<RangeKey>('all');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const series = useMemo(() => {
    if (points.length === 0) return [];
    const span = RANGES.find((r) => r.key === range)?.seconds ?? Number.MAX_SAFE_INTEGER;
    const now = Number(nowSec) || points[points.length - 1].t;
    const cutoff = span === Number.MAX_SAFE_INTEGER ? -Infinity : now - span;
    const windowed = points.filter((p) => p.t >= cutoff);
    // Keep at least two points so a line can be drawn at short ranges.
    return windowed.length >= 2 ? windowed : points.slice(-2);
  }, [points, range, nowSec]);

  // Append a synthetic "now" point so the line runs to the right edge at the
  // current price rather than stopping at the last trade.
  const plotted = useMemo(() => {
    if (series.length === 0) return [];
    const last = series[series.length - 1];
    const now = Number(nowSec);
    if (now > last.t) {
      return [...series, { ...last, t: now, yesBps: currentBps }];
    }
    return series;
  }, [series, nowSec, currentBps]);

  const geom = useMemo(() => computeGeometry(plotted), [plotted]);

  if (isLoading) {
    return (
      <div className="rounded-card border border-edge bg-surface-raised p-4">
        <Skeleton className="h-[220px] w-full" />
      </div>
    );
  }

  // Honest failure states: never draw a line we can't justify.
  if (error) {
    return <ChartNote title="Price history unavailable" body={error} />;
  }
  if (points.length === 0) {
    return (
      <ChartNote
        title="No trades yet"
        body="This chart is built from on-chain trades. Once this market has its first trade, its full price history will appear here."
      />
    );
  }
  if (!verified) {
    return (
      <ChartNote
        title="Price history could not be verified"
        body="The reconstructed pool state did not match the live pool, so the chart is hidden rather than shown with values that may be wrong. The current price above is read directly from the contract and is accurate."
      />
    );
  }

  const hovered = hoverIdx !== null ? plotted[hoverIdx] : null;
  const shown = hovered ?? plotted[plotted.length - 1];
  const intraday = range === '1d';

  return (
    <div className="rounded-card border border-edge bg-surface-raised p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-2xs uppercase tracking-wide text-content-subtle">
            {hovered ? 'At selected time' : 'Current'}
          </p>
          <p className="text-2xl font-semibold tabular-nums text-content">
            {formatProbPct(shown?.yesBps ?? currentBps)}
          </p>
          <p className="text-2xs text-content-subtle">
            {hovered ? formatChartStamp(hovered.t) : 'chance of YES'}
          </p>
        </div>

        <div
          role="group"
          aria-label="Chart time range"
          className="flex gap-0.5 rounded-lg border border-edge p-0.5"
        >
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => {
                setRange(r.key);
                setHoverIdx(null);
              }}
              aria-pressed={range === r.key}
              className={`rounded px-2 py-1 text-2xs font-medium transition-colors ${
                range === r.key
                  ? 'bg-content text-surface'
                  : 'text-content-muted hover:text-content'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          className="h-[220px] w-full touch-none"
          role="img"
          aria-label={`YES probability over time, currently ${formatProbPct(currentBps)}`}
          onMouseLeave={() => setHoverIdx(null)}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            if (rect.width === 0 || plotted.length === 0) return;
            const frac = (e.clientX - rect.left) / rect.width;
            const idx = Math.round(frac * (plotted.length - 1));
            setHoverIdx(Math.max(0, Math.min(plotted.length - 1, idx)));
          }}
        >
          {/* Horizontal guides at 25/50/75%. */}
          {[25, 50, 75].map((pct) => (
            <line
              key={pct}
              x1={0}
              x2={VIEW_W}
              y1={VIEW_H - (pct / 100) * VIEW_H}
              y2={VIEW_H - (pct / 100) * VIEW_H}
              stroke="rgb(var(--edge))"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              strokeDasharray={pct === 50 ? '0' : '3 3'}
            />
          ))}

          {geom.areaPath && (
            <path d={geom.areaPath} fill="rgb(var(--brand))" fillOpacity={0.12} stroke="none" />
          )}
          {geom.linePath && (
            <path
              d={geom.linePath}
              fill="none"
              stroke="rgb(var(--brand))"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          )}

          {hoverIdx !== null && geom.coords[hoverIdx] && (
            <>
              <line
                x1={geom.coords[hoverIdx].x}
                x2={geom.coords[hoverIdx].x}
                y1={0}
                y2={VIEW_H}
                stroke="rgb(var(--content-subtle))"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={geom.coords[hoverIdx].x}
                cy={geom.coords[hoverIdx].y}
                r={3}
                fill="rgb(var(--brand))"
                stroke="rgb(var(--surface))"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            </>
          )}
        </svg>

        {/* Y-axis labels, positioned outside the stretched SVG so text is not skewed. */}
        <div className="pointer-events-none absolute inset-y-0 left-0 flex flex-col justify-between py-0 text-2xs tabular-nums text-content-subtle">
          <span>100%</span>
          <span>50%</span>
          <span>0%</span>
        </div>
      </div>

      <div className="mt-2 flex justify-between text-2xs tabular-nums text-content-subtle">
        <span>{plotted.length > 0 ? formatChartTick(plotted[0].t, intraday) : ''}</span>
        <span>{plotted.length > 0 ? formatChartTick(plotted[plotted.length - 1].t, intraday) : ''}</span>
      </div>

      {/* Accessible data table equivalent of the graphic. */}
      <table className="sr-only">
        <caption>YES probability history</caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">YES probability</th>
          </tr>
        </thead>
        <tbody>
          {plotted.map((p, i) => (
            <tr key={`${p.t}-${i}`}>
              <td>{formatChartStamp(p.t)}</td>
              <td>{formatProbPct(p.yesBps)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Map points into viewBox space. X is spread by timestamp so gaps in trading
 * are visible as flat stretches rather than being compressed away.
 */
function computeGeometry(points: PricePoint[]) {
  if (points.length === 0) return { coords: [], linePath: '', areaPath: '' };

  const tMin = points[0].t;
  const tMax = points[points.length - 1].t;
  const tSpan = tMax - tMin;

  const coords = points.map((p, i) => {
    const x = tSpan > 0 ? ((p.t - tMin) / tSpan) * VIEW_W : (i / Math.max(1, points.length - 1)) * VIEW_W;
    const y = VIEW_H - (Math.max(0, Math.min(10000, p.yesBps)) / 10000) * VIEW_H;
    return { x, y };
  });

  if (coords.length === 1) {
    // A single point renders as a flat line across the full width.
    const y = coords[0].y;
    return {
      coords,
      linePath: `M 0 ${y} L ${VIEW_W} ${y}`,
      areaPath: `M 0 ${y} L ${VIEW_W} ${y} L ${VIEW_W} ${VIEW_H} L 0 ${VIEW_H} Z`,
    };
  }

  // Step-after interpolation: price is constant between trades and jumps at the
  // trade, which is literally how an AMM behaves. A smooth curve would imply
  // continuous price movement that never happened.
  let line = `M ${coords[0].x} ${coords[0].y}`;
  for (let i = 1; i < coords.length; i++) {
    line += ` L ${coords[i].x} ${coords[i - 1].y} L ${coords[i].x} ${coords[i].y}`;
  }

  const area = `${line} L ${coords[coords.length - 1].x} ${VIEW_H} L ${coords[0].x} ${VIEW_H} Z`;

  return { coords, linePath: line, areaPath: area };
}

function ChartNote({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center rounded-card border border-dashed border-edge bg-surface-raised px-6 py-8 text-center">
      <p className="text-sm font-medium text-content">{title}</p>
      <p className="mt-1 max-w-sm text-xs text-content-muted">{body}</p>
    </div>
  );
}

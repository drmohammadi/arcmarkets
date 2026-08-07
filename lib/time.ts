/**
 * Resolution-time formatting.
 *
 * Chain timestamps are seconds as bigint and are attacker-influenced only
 * within block-timestamp drift, but they can still be absurd (0, or far future),
 * so every helper validates before formatting and never throws.
 */

const SEC = BigInt(1);
const MIN = BigInt(60);
const HOUR = BigInt(3600);
const DAY = BigInt(86400);

/** True when the timestamp is a plausible Unix seconds value we can render. */
export function isPlausibleTimestamp(ts: bigint): boolean {
  // 2000-01-01 .. 2200-01-01, generous but excludes 0 and overflow garbage.
  return ts > BigInt(946684800) && ts < BigInt(7258118400);
}

/** Absolute date, e.g. "Mar 14, 2026". Returns "unknown" when implausible. */
export function formatResolutionDate(ts: bigint): string {
  if (!isPlausibleTimestamp(ts)) return 'unknown';
  const d = new Date(Number(ts) * 1000);
  if (!Number.isFinite(d.getTime())) return 'unknown';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Absolute date + time, for the detail page. */
export function formatResolutionDateTime(ts: bigint): string {
  if (!isPlausibleTimestamp(ts)) return 'unknown';
  const d = new Date(Number(ts) * 1000);
  if (!Number.isFinite(d.getTime())) return 'unknown';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Compact countdown, e.g. "3d", "5h", "12m", or "ended".
 * `nowSec` is injected so callers can keep it in state and avoid
 * server/client hydration mismatches from calling Date.now() during render.
 */
export function formatCountdown(ts: bigint, nowSec: bigint): string {
  if (!isPlausibleTimestamp(ts)) return 'unknown';
  if (ts <= nowSec) return 'ended';
  const delta = ts - nowSec;
  if (delta >= DAY) return `${delta / DAY}d`;
  if (delta >= HOUR) return `${delta / HOUR}h`;
  if (delta >= MIN) return `${delta / MIN}m`;
  return `${delta / SEC}s`;
}

/** Longer countdown for the detail page, e.g. "3d 4h left". */
export function formatTimeLeft(ts: bigint, nowSec: bigint): string {
  if (!isPlausibleTimestamp(ts)) return 'Resolution time unknown';
  if (ts <= nowSec) return 'Resolution time reached';
  const delta = ts - nowSec;
  const days = delta / DAY;
  const hours = (delta % DAY) / HOUR;
  const mins = (delta % HOUR) / MIN;
  if (days > BigInt(0)) return `${days}d ${hours}h left`;
  if (hours > BigInt(0)) return `${hours}h ${mins}m left`;
  return `${mins}m left`;
}

/** Short axis label for the chart, e.g. "Mar 14" or "14:30" for intraday. */
export function formatChartTick(ts: number, intraday: boolean): string {
  const d = new Date(ts * 1000);
  if (!Number.isFinite(d.getTime())) return '';
  return intraday
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Full tooltip timestamp for a chart point. */
export function formatChartStamp(ts: number): string {
  const d = new Date(ts * 1000);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

'use client';

/**
 * Shared presentational primitives. Kept in one file because each is small and
 * they are always imported together; splitting them would add churn without
 * improving testability.
 *
 * None of these accept raw HTML — all text goes in as children/props and is
 * rendered as escaped text nodes.
 */

import { accentFor, monogramFor } from '@/lib/marketMeta';
import { formatProbPct } from '@/lib/pricing';
import { useMarketImage } from '@/hooks/useMarketImage';

const ICON_DIMS = {
  sm: 'h-8 w-8 text-2xs',
  md: 'h-10 w-10 text-xs',
  lg: 'h-12 w-12 text-base',
  xl: 'h-16 w-16 text-xl',
  '2xl': 'h-20 w-20 text-2xl',
} as const;

export type IconSize = keyof typeof ICON_DIMS;

/**
 * Deterministic monogram icon for a market or event, with an optional uploaded
 * image on top.
 *
 * `src` is expected to come from lib/marketImages, which only ever returns a
 * validated, re-encoded data URL — it is re-checked there on every read, so a
 * tampered storage entry cannot reach this <img>. When absent (the normal
 * case), the generated monogram is used: no network fetch, stable per market.
 */
export function MarketIcon({
  seed,
  text,
  size = 'md',
  src = null,
}: {
  seed: string;
  text: unknown;
  size?: IconSize;
  /** Validated data URL, or null to render the generated monogram. */
  src?: string | null;
}) {
  const dims = ICON_DIMS[size] ?? ICON_DIMS.md;

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- data: URL produced
      // by our own canvas re-encode; next/image cannot optimize a data URL.
      <img
        src={src}
        alt=""
        aria-hidden="true"
        className={`inline-block shrink-0 rounded-lg border border-edge object-cover ${dims}`}
      />
    );
  }

  const accent = accentFor(seed);
  const mono = monogramFor(text);
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-lg font-semibold ring-1 ${dims} ${accent.bg} ${accent.fg} ${accent.ring}`}
    >
      {mono}
    </span>
  );
}

/**
 * MarketIcon that looks up its own stored image by questionId.
 *
 * Use this inside lists: a row rendered in a `.map()` cannot call a hook
 * itself, so the lookup is encapsulated here instead of threading an image map
 * down through every card component.
 */
export function MarketAvatar({
  questionId,
  seed,
  text,
  size = 'md',
}: {
  questionId: bigint | null;
  seed: string;
  text: unknown;
  size?: IconSize;
}) {
  const src = useMarketImage(questionId);
  return <MarketIcon seed={seed} text={text} size={size} src={src} />;
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'yes' | 'no' | 'brand' | 'warn';
}) {
  const tones = {
    neutral: 'bg-surface-sunken text-content-muted',
    yes: 'bg-yes-soft text-yes',
    no: 'bg-no-soft text-no',
    brand: 'bg-brand-muted text-brand',
    warn: 'bg-surface-sunken text-warn',
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Horizontal YES/NO probability bar. The numeric value is always rendered as
 * text next to it, so the bar is decoration and colour is never the only cue.
 */
export function ProbabilityBar({ yesBps, showLabels = false }: { yesBps: number; showLabels?: boolean }) {
  const pct = Math.max(0, Math.min(100, yesBps / 100));
  return (
    <div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-no/25"
        role="img"
        aria-label={`YES ${formatProbPct(yesBps)}, NO ${formatProbPct(10000 - yesBps)}`}
      >
        <div className="h-full rounded-full bg-yes transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      {showLabels && (
        <div className="mt-1 flex justify-between text-2xs text-content-subtle">
          <span>YES {formatProbPct(yesBps)}</span>
          <span>NO {formatProbPct(10000 - yesBps)}</span>
        </div>
      )}
    </div>
  );
}

/** Neutral loading placeholder that respects reduced-motion via globals.css. */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div className={`relative overflow-hidden rounded bg-surface-sunken ${className}`}>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-black/5 to-transparent dark:via-white/5" />
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-card border border-dashed border-edge px-6 py-12 text-center">
      <p className="font-medium text-content">{title}</p>
      {hint && <p className="mx-auto mt-1 max-w-md text-sm text-content-muted">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Inline error panel. Message is plain text; callers sanitize before passing. */
export function ErrorNote({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-lg border border-no/30 bg-no-soft px-3 py-2 text-xs text-no"
    >
      {message}
    </p>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-content-muted">
      <span
        aria-hidden="true"
        className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-edge-strong border-t-brand"
      />
      <span>{label}</span>
    </span>
  );
}

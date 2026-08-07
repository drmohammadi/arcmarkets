/**
 * Centralized external + informational links.
 *
 * Single source of truth: nothing in the app hardcodes a social or policy URL.
 * Change a destination here and every render site follows.
 *
 * Each entry is env-overridable so a fork or a preview deployment can point at
 * its own community/docs without a code change. Values are resolved through
 * `safeExternalUrl`, which enforces an https-only allowlist — a malformed or
 * javascript:/data: URL yields `null` and the link is simply not rendered,
 * rather than shipping a clickable script sink.
 *
 * NEXT_PUBLIC_* is required for the value to reach the browser bundle. Next
 * inlines these at build time, so they must be referenced as full literal
 * property accesses (process.env.NEXT_PUBLIC_X), never computed.
 */

/**
 * Accept only absolute https URLs. Rejects javascript:, data:, vbscript:,
 * protocol-relative and malformed input.
 *
 * Total: never throws, returns null on anything it cannot vouch for.
 */
export function safeExternalUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Internal app routes are validated separately: they must be root-relative and
 * single-slash, which excludes "//evil.com" (protocol-relative, treated as
 * external by browsers) and any absolute URL.
 */
export function safeInternalPath(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  if (trimmed.startsWith('//')) return null;
  return trimmed;
}

export interface SiteLink {
  label: string;
  /** Resolved destination, or null when unset/invalid — caller skips rendering. */
  href: string | null;
  /** External links get target/rel treatment and a visual affordance. */
  external: boolean;
}

export interface LinkSection {
  heading: string;
  links: SiteLink[];
}

/** Brand/product identity, kept here so the footer and header agree. */
export const SITE = {
  name: 'Arc Markets',
  tagline: 'Binary prediction markets settled in USDC on Circle Arc L1.',
} as const;

function external(label: string, raw: string | undefined, fallback: string): SiteLink {
  return { label, href: safeExternalUrl(raw ?? fallback), external: true };
}

function internal(label: string, path: string): SiteLink {
  return { label, href: safeInternalPath(path), external: false };
}

/**
 * Community / social destinations.
 *
 * Defaults point at the real Arc + Circle properties rather than placeholder
 * URLs, so an unconfigured deployment still links somewhere truthful. Override
 * per-deployment with the corresponding env var.
 */
export const SOCIAL_LINKS: SiteLink[] = [
  external('Twitter / X', process.env.NEXT_PUBLIC_LINK_TWITTER, 'https://x.com/circle'),
  external('Discord', process.env.NEXT_PUBLIC_LINK_DISCORD, 'https://discord.com/invite/buildoncircle'),
];

/**
 * Informational pages.
 *
 * About/Rules currently resolve to the docs site rather than to app routes that
 * do not exist — a link that 404s is worse than one that lands on real material.
 * Point them at internal routes here once those pages are built.
 */
export const RESOURCE_LINKS: SiteLink[] = [
  external('About', process.env.NEXT_PUBLIC_LINK_ABOUT, 'https://www.arc.network'),
  external('Documentation', process.env.NEXT_PUBLIC_LINK_DOCS, 'https://developers.circle.com/arc'),
  external('Rules', process.env.NEXT_PUBLIC_LINK_RULES, 'https://developers.circle.com/arc'),
  external('Contact', process.env.NEXT_PUBLIC_LINK_CONTACT, 'https://developers.circle.com/support'),
];

/** Legal/policy destinations. */
export const LEGAL_LINKS: SiteLink[] = [
  external('Terms', process.env.NEXT_PUBLIC_LINK_TERMS, 'https://www.circle.com/legal/terms'),
  external('Privacy', process.env.NEXT_PUBLIC_LINK_PRIVACY, 'https://www.circle.com/legal/privacy'),
];

/** In-app navigation echoed in the footer. */
export const APP_LINKS: SiteLink[] = [
  internal('Markets', '/'),
  internal('Portfolio', '/portfolio'),
];

/**
 * Footer layout. Sections with no resolvable links are filtered at render time,
 * so an aggressively-overridden deployment degrades to fewer columns instead of
 * rendering empty headings.
 */
export const FOOTER_SECTIONS: LinkSection[] = [
  { heading: 'Markets', links: APP_LINKS },
  { heading: 'Resources', links: RESOURCE_LINKS },
  { heading: 'Community', links: SOCIAL_LINKS },
  { heading: 'Legal', links: LEGAL_LINKS },
];

/** Drop unresolvable links, then drop sections left empty. */
export function resolvedSections(sections: LinkSection[] = FOOTER_SECTIONS): LinkSection[] {
  return sections
    .map((s) => ({ heading: s.heading, links: s.links.filter((l) => l.href !== null) }))
    .filter((s) => s.links.length > 0);
}

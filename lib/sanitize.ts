/**
 * Output sanitization for user/chain-derived strings.
 *
 * Market questions, categories, and any string that originated off-chain or
 * from an untrusted caller are rendered in the UI. React escapes text nodes by
 * default, but we defense-in-depth here for: (1) values interpolated into
 * href/attributes, (2) any future dangerouslySetInnerHTML, (3) log output.
 *
 * Treat ALL contract-returned strings as untrusted — anyone can create a market
 * with an arbitrary question string.
 */

const MAX_DISPLAY_LEN = 500;

/**
 * Strip control chars, collapse whitespace, cap length. For plain-text display.
 * Does NOT allow any HTML — returns a safe text string.
 *
 * Regexes use explicit \x / \u escapes only (no literal control chars) so the
 * source survives transmission and never produces an out-of-order range.
 */
export function sanitizeText(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[\x00-\x1F\x7F]/g, '') // C0 controls + DEL
    .replace(/\uFFFD/g, '') // replacement char
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // zero-width space/joiner/BOM
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '') // bidi overrides (RTL spoofing)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DISPLAY_LEN);
}

/**
 * Escape a string for safe interpolation into an HTML attribute context.
 * Use when a value must go into an attribute we build manually.
 */
export function escapeHtmlAttr(input: unknown): string {
  return sanitizeText(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Validate that a string is a well-formed 0x-prefixed EVM address.
 * Returns the lowercase form, or null if invalid.
 * Never render an "address" from chain data without passing it through here.
 */
export function safeAddress(input: unknown): `0x${string}` | null {
  if (typeof input !== 'string') return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(input)) return null;
  return input.toLowerCase() as `0x${string}`;
}

/**
 * Truncate an address for display: 0x1234…abcd. Validates first.
 */
export function shortAddress(input: unknown): string {
  const addr = safeAddress(input);
  if (!addr) return 'unknown';
  return `${addr.slice(0, 6)}\u2026${addr.slice(-4)}`;
}

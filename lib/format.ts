/**
 * 6-decimal USDC formatting/parsing for Arc's native gas token.
 * NEVER use ethers.formatEther / parseEther (those are 18-decimal).
 */

export const USDC_DECIMALS = 6;

/**
 * Format a bigint USDC amount (raw 6-decimal units) to a human-readable string.
 * @example formatUsdc(1_500_000n) → "1.5"
 */
export function formatUsdc(amount: bigint): string {
  const str = amount.toString().padStart(USDC_DECIMALS + 1, '0');
  const intPart = str.slice(0, -USDC_DECIMALS) || '0';
  const fracPart = str.slice(-USDC_DECIMALS).replace(/0+$/, '');
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

/**
 * Parse a human-readable USDC string to a bigint (raw 6-decimal units).
 * @example parseUsdc("1.5") → 1_500_000n
 */
export function parseUsdc(value: string): bigint {
  // Defensive: reject anything that isn't a plain decimal number. Returns BigInt(0) on
  // invalid input so callers can use it directly in render without try/catch.
  const trimmed = (value ?? '').trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '' || trimmed === '.') return BigInt(0);
  const [intPart = '0', fracPart = ''] = trimmed.split('.');
  const safeInt = intPart === '' ? '0' : intPart;
  const paddedFrac = fracPart.padEnd(USDC_DECIMALS, '0').slice(0, USDC_DECIMALS);
  try {
    return BigInt(safeInt + paddedFrac);
  } catch {
    return BigInt(0);
  }
}

/**
 * Format a bigint USDC amount as a compact display string (e.g., "1.2K", "3.4M").
 */
export function formatUsdcCompact(amount: bigint): string {
  const num = Number(amount) / 10 ** USDC_DECIMALS;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return formatUsdc(amount);
}

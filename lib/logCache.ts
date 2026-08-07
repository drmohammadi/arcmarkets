/**
 * Persistent cache for replayed FPMM events.
 *
 * Historical logs below a confirmed block are immutable, so once a range is
 * fetched it never needs fetching again. The cache stores, per (chain, pool):
 * the block range already covered and the events found in it. A later load
 * resumes from `toBlock + 1` instead of rescanning.
 *
 * Two tiers:
 *  - **Module memory** — survives component unmount and route changes within a
 *    session, so navigating between markets costs nothing.
 *  - **sessionStorage** — survives a page reload. Deliberately NOT
 *    localStorage: a long-lived cache of chain state risks serving stale data
 *    after a testnet reset, and per-tab scope keeps the failure window short.
 *
 * BigInt does not survive JSON, so block numbers are persisted as decimal
 * strings and revived on read. A malformed or version-mismatched entry is
 * discarded rather than trusted.
 */

/** Bump when the stored shape changes, to invalidate old entries. */
const CACHE_VERSION = 1;
const KEY_PREFIX = 'arc-loghist-v' + CACHE_VERSION + ':';

/** Cap on persisted events per pool — beyond this, keep memory-only. */
const MAX_PERSISTED_EVENTS = 2000;

/** One decoded event, in the minimal form the replay needs. */
export interface CachedEvent {
  blockNumber: string;
  logIndex: number;
  name: string;
  /** Event args as decimal strings; bigint-safe across JSON. */
  args: Record<string, string>;
}

export interface CachedRange {
  /** First block covered by this cache entry. */
  fromBlock: string;
  /** Last block covered (inclusive). */
  toBlock: string;
  events: CachedEvent[];
}

const memory = new Map<string, CachedRange>();

function keyFor(chainId: number, pool: string): string {
  return `${KEY_PREFIX}${chainId}:${pool.toLowerCase()}`;
}

/** Narrow unknown parsed JSON into a CachedRange, or null if it doesn't fit. */
function validate(raw: unknown): CachedRange | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.fromBlock !== 'string' || typeof obj.toBlock !== 'string') return null;
  if (!Array.isArray(obj.events)) return null;

  const events: CachedEvent[] = [];
  for (const e of obj.events) {
    if (!e || typeof e !== 'object') return null;
    const ev = e as Record<string, unknown>;
    if (typeof ev.blockNumber !== 'string') return null;
    if (typeof ev.logIndex !== 'number') return null;
    if (typeof ev.name !== 'string') return null;
    if (!ev.args || typeof ev.args !== 'object') return null;
    const args: Record<string, string> = {};
    for (const [k, v] of Object.entries(ev.args as Record<string, unknown>)) {
      if (typeof v !== 'string') return null;
      args[k] = v;
    }
    events.push({
      blockNumber: ev.blockNumber,
      logIndex: ev.logIndex,
      name: ev.name,
      args,
    });
  }

  // Reject a range that cannot be interpreted as block numbers.
  try {
    if (BigInt(obj.fromBlock) > BigInt(obj.toBlock)) return null;
  } catch {
    return null;
  }

  return { fromBlock: obj.fromBlock, toBlock: obj.toBlock, events };
}

export function readCache(chainId: number, pool: string): CachedRange | null {
  const key = keyFor(chainId, pool);

  const hit = memory.get(key);
  if (hit) return hit;

  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = validate(JSON.parse(raw) as unknown);
    if (!parsed) {
      window.sessionStorage.removeItem(key);
      return null;
    }
    memory.set(key, parsed);
    return parsed;
  } catch {
    // Storage disabled, quota error, or bad JSON: memory-only is fine.
    return null;
  }
}

export function writeCache(chainId: number, pool: string, range: CachedRange): void {
  const key = keyFor(chainId, pool);
  memory.set(key, range);

  if (typeof window === 'undefined') return;
  if (range.events.length > MAX_PERSISTED_EVENTS) return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(range));
  } catch {
    // Over quota or storage blocked: the memory tier still works.
  }
}

/** Convert a decimal-string arg map back into bigints for the replay. */
export function reviveArgs(args: Record<string, string>): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const [k, v] of Object.entries(args)) {
    try {
      out[k] = BigInt(v);
    } catch {
      // Non-numeric arg (e.g. an address): the replay only reads numeric ones.
    }
  }
  return out;
}

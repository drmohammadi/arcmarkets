/**
 * Global RPC request queue with rate limiting and 429 backoff.
 *
 * Public Arc testnet RPC returns HTTP 429 when log queries arrive too fast. The
 * price chart is the heaviest caller (one getLogs per event type per block
 * chunk), so every one of its requests goes through here.
 *
 * Design:
 *  - **Module-level singleton.** The limit is a property of the RPC endpoint,
 *    not of a component, so the queue must be shared across every hook instance
 *    and survive re-renders. A per-hook limiter would let four mounted charts
 *    each fire at the full rate.
 *  - **Serial with a minimum gap.** Concurrency 1 plus MIN_GAP_MS between
 *    starts. Simpler than a token bucket and sufficient: the goal is to stay
 *    under a limit, not to maximize throughput.
 *  - **Exponential backoff on 429 only.** 1s, 2s, 4s, 8s then give up. Other
 *    errors fail immediately — retrying a malformed request just wastes budget.
 *  - **Global cooldown.** A 429 pauses the whole queue, not just the failing
 *    request, because the limit is endpoint-wide. Without this, queued requests
 *    would keep hitting a limit that is already tripped.
 */

/** Minimum spacing between request starts. */
const MIN_GAP_MS = 120;
/** Backoff schedule for 429s, in ms. Length also caps the retry count. */
const BACKOFF_MS = [1000, 2000, 4000, 8000] as const;

type Task<T> = () => Promise<T>;

interface QueueEntry {
  run: () => Promise<void>;
}

const pending: QueueEntry[] = [];
let draining = false;
let lastStart = 0;
/** Timestamp (ms) before which no request may start, set by a 429. */
let cooldownUntil = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detect a rate-limit rejection.
 *
 * viem wraps transport errors, so the status may appear as a numeric `status`,
 * as an HTTP code inside the message, or as a JSON-RPC -32005 ("limit
 * exceeded"). Checked broadly because a missed 429 means no backoff at all.
 */
export function isRateLimit(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;

  const anyErr = err as Record<string, unknown>;
  if (anyErr.status === 429 || anyErr.code === 429 || anyErr.code === -32005) return true;

  const nested = anyErr.cause;
  if (nested && nested !== err && isRateLimit(nested)) return true;

  const msg = typeof anyErr.message === 'string' ? anyErr.message.toLowerCase() : '';
  return (
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('rate limit') ||
    msg.includes('limit exceeded')
  );
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (pending.length > 0) {
      const entry = pending.shift();
      if (!entry) continue;

      // Respect both the inter-request gap and any active 429 cooldown.
      const now = Date.now();
      const waitFor = Math.max(cooldownUntil - now, lastStart + MIN_GAP_MS - now, 0);
      if (waitFor > 0) await sleep(waitFor);

      lastStart = Date.now();
      await entry.run();
    }
  } finally {
    draining = false;
  }
}

/**
 * Queue an RPC call. Resolves with the task's value, or rejects with the last
 * error after the backoff schedule is exhausted.
 *
 * The task is invoked fresh on each attempt, so it must be a thunk rather than
 * an already-started promise.
 */
export function enqueueRpc<T>(task: Task<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          resolve(await task());
          return;
        } catch (err) {
          if (!isRateLimit(err) || attempt >= BACKOFF_MS.length) {
            reject(err);
            return;
          }
          // Pause every queued request: the limit is endpoint-wide.
          const delay = BACKOFF_MS[attempt];
          cooldownUntil = Math.max(cooldownUntil, Date.now() + delay);
          await sleep(delay);
        }
      }
    };

    pending.push({ run });
    void drain();
  });
}

/** True while a 429 cooldown is active. Lets the UI explain a stall honestly. */
export function isCoolingDown(): boolean {
  return Date.now() < cooldownUntil;
}

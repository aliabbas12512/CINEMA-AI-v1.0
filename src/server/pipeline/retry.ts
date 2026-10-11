import { ProviderError } from "@/server/providers/errors";

export type RetryOptions = {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  /** Called before each retry; useful for logging + persisting attempt counts. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void | Promise<void>;
  /** Abort retries early (e.g. project cancelled). */
  shouldAbort?: () => Promise<boolean> | boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export class RetryAbortedError extends Error {
  constructor() {
    super("Retry aborted");
    this.name = "RetryAbortedError";
  }
}

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function isRetryable(err: unknown): boolean {
  if (err instanceof ProviderError) return err.retryable;
  // Unknown errors (bugs, validation) are not retried blindly.
  return false;
}

/** Exponential backoff with full jitter; honours provider Retry-After. */
export function computeDelay(attempt: number, opts: RetryOptions, err: unknown): number {
  const cap = opts.maxDelayMs ?? 120_000;
  const rand = opts.random ?? Math.random;
  const exp = Math.min(cap, opts.baseDelayMs * 2 ** (attempt - 1));
  const jittered = Math.round(exp / 2 + rand() * (exp / 2));
  const retryAfter = err instanceof ProviderError ? err.retryAfterMs : undefined;
  return Math.min(cap, Math.max(jittered, retryAfter ?? 0));
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt > opts.maxRetries || !isRetryable(err)) throw err;
      if (opts.shouldAbort && (await opts.shouldAbort())) throw new RetryAbortedError();
      const delayMs = computeDelay(attempt, opts, err);
      await opts.onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs);
    }
  }
}

/**
 * Small concurrency limiter. On the first rejection no further items are
 * started, and the call only settles after every in-flight item has settled,
 * so no work leaks past a pause/cancel into the next run.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i] as T, i);
      } catch (err) {
        if (!failed) firstError = err;
        failed = true;
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw firstError;
  return results;
}

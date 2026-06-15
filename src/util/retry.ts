export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  onRetry?: (attempt: number, err: unknown) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn`, retrying up to `attempts` times with exponential backoff. Throws the last error. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < opts.attempts) {
        opts.onRetry?.(attempt, err);
        await sleep(opts.baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }
  throw lastErr;
}

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export interface FixedWindowLimiterOptions {
  readonly limit: number;
  readonly windowMs: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export const isUnsafeMethod = (method: string): boolean => !safeMethods.has(method.toUpperCase());

export const hasExactOrigin = (origin: string | undefined, expectedOrigin: string): boolean => {
  if (origin === undefined) return false;
  try {
    return origin === new URL(origin).origin && origin === new URL(expectedOrigin).origin;
  } catch {
    return false;
  }
};

export const createFixedWindowLimiter = ({
  limit,
  windowMs,
  maxEntries = 10_000,
  now = Date.now,
}: FixedWindowLimiterOptions) => {
  const windows = new Map<string, { count: number; resetAt: number }>();

  return {
    consume(key: string): RateLimitResult {
      const currentTime = now();
      for (const [entryKey, entry] of windows) {
        if (entry.resetAt <= currentTime) windows.delete(entryKey);
      }

      const current = windows.get(key);
      if (current !== undefined) {
        if (current.count >= limit) {
          return {
            allowed: false,
            retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - currentTime) / 1_000)),
          };
        }
        current.count += 1;
        return { allowed: true, retryAfterSeconds: 0 };
      }

      if (windows.size >= maxEntries) {
        const earliestReset = Math.min(...[...windows.values()].map(({ resetAt }) => resetAt));
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((earliestReset - currentTime) / 1_000)),
        };
      }
      windows.set(key, { count: 1, resetAt: currentTime + windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    },
    get size() {
      return windows.size;
    },
  };
};

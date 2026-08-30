import { describe, expect, it } from "vitest";
import { createFixedWindowLimiter, hasExactOrigin, isUnsafeMethod } from "./http-security.js";

describe("HTTP security helpers", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])("classifies %s as unsafe", (method) => {
    expect(isUnsafeMethod(method)).toBe(true);
  });

  it.each(["GET", "HEAD", "OPTIONS"])("classifies %s as safe", (method) => {
    expect(isUnsafeMethod(method)).toBe(false);
  });

  it("requires an exact normalized origin", () => {
    expect(hasExactOrigin("https://mafia.example.test", "https://mafia.example.test/app")).toBe(
      true,
    );
    expect(hasExactOrigin("https://mafia.example.test:444", "https://mafia.example.test")).toBe(
      false,
    );
    expect(hasExactOrigin("http://mafia.example.test", "https://mafia.example.test")).toBe(false);
    expect(hasExactOrigin("https://attacker.example", "https://mafia.example.test")).toBe(false);
    expect(hasExactOrigin(undefined, "https://mafia.example.test")).toBe(false);
    expect(hasExactOrigin("not a URL", "https://mafia.example.test")).toBe(false);
  });

  it("limits one source independently, resets its window, and reports retry timing", () => {
    let now = 1_000;
    const limiter = createFixedWindowLimiter({ limit: 2, windowMs: 10_000, now: () => now });

    expect(limiter.consume("source-a")).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.consume("source-a")).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.consume("source-a")).toEqual({ allowed: false, retryAfterSeconds: 10 });
    expect(limiter.consume("source-b")).toEqual({ allowed: true, retryAfterSeconds: 0 });

    now += 9_001;
    expect(limiter.consume("source-a")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    now += 999;
    expect(limiter.consume("source-a")).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it("fails closed at capacity without resetting an active source window", () => {
    const limiter = createFixedWindowLimiter({
      limit: 2,
      windowMs: 10_000,
      maxEntries: 2,
      now: () => 1_000,
    });

    expect(limiter.consume("source-a")).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.consume("source-a")).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.consume("source-a")).toEqual({ allowed: false, retryAfterSeconds: 10 });
    expect(limiter.consume("source-b")).toEqual({ allowed: true, retryAfterSeconds: 0 });

    expect(limiter.consume("source-c")).toEqual({ allowed: false, retryAfterSeconds: 10 });
    expect(limiter.consume("source-a")).toEqual({ allowed: false, retryAfterSeconds: 10 });
    expect(limiter.size).toBe(2);
  });
});

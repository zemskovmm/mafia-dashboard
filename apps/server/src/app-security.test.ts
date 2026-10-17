import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import type { GoogleAuthPort } from "./google-auth.js";
import type { ApplicationStores } from "./storage-contracts.js";

const unexpectedAccess = vi.fn(async () => {
  throw new Error("HTTP security smoke tests must not access persistence");
});
const stores: ApplicationStores = {
  events: { read: unexpectedAccess },
  games: {
    create: unexpectedAccess,
    save: unexpectedAccess,
    clear: unexpectedAccess,
    get: unexpectedAccess,
    listActive: unexpectedAccess,
    listCompleted: unexpectedAccess,
    readStatisticsInputs: unexpectedAccess,
  },
  tournaments: { list: unexpectedAccess, create: unexpectedAccess, assign: unexpectedAccess },
  players: {
    list: unexpectedAccess,
    get: unexpectedAccess,
    create: unexpectedAccess,
    update: unexpectedAccess,
    delete: unexpectedAccess,
  },
  clubs: {
    listForUser: unexpectedAccess,
    getRole: unexpectedAccess,
    isMember: unexpectedAccess,
    create: unexpectedAccess,
    claimClubAccess: unexpectedAccess,
    update: unexpectedAccess,
    delete: unexpectedAccess,
  },
  ready: unexpectedAccess,
};

const buildLimitedAuthApp = async (trustedProxyHops: 0 | 1 = 0) => {
  const googleAuth: GoogleAuthPort = {
    configured: true,
    createAuthorizationUrl: vi.fn(
      (state: string) => `https://accounts.example.test?state=${state}`,
    ),
    completeAuthorization: unexpectedAccess,
    getUserForSession: vi.fn(async () => null),
    endSession: unexpectedAccess,
  };
  const app = await buildApp({
    stores,
    googleAuth,
    trustedProxyHops,
    authRateLimit: { limit: 1, windowMs: 10_000 },
  });
  await app.ready();
  return app;
};

const expectSecurityHeaders = (
  headers: Record<string, string | string[] | number | undefined>,
  label: string,
) => {
  const policy = headers["content-security-policy"];
  expect(policy, label).toContain("default-src 'self'");
  expect(policy, label).toContain("base-uri 'self'");
  expect(policy, label).toContain("object-src 'none'");
  expect(policy, label).toContain("frame-ancestors 'none'");
  expect(policy, label).toContain("script-src 'self' https://www.youtube.com");
  expect(policy, label).toContain(
    "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
  );
  expect(policy, label).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
  expect(policy, label).toContain("font-src 'self' https://fonts.gstatic.com");
  expect(policy, label).toContain("img-src 'self' data: blob: https:");
  expect(policy, label).toContain("connect-src 'self'");
  expect(policy, label).toContain("form-action 'self'");
  expect(headers["x-frame-options"], label).toBe("DENY");
  expect(headers["x-content-type-options"], label).toBe("nosniff");
  expect(headers["referrer-policy"], label).toBe("strict-origin-when-cross-origin");
  expect(headers["permissions-policy"], label).toBe("picture-in-picture=()");
};

describe("server HTTP security policy", () => {
  it("ignores forwarding headers from direct peers", async () => {
    const app = await buildLimitedAuthApp();

    const first = await app.inject({
      method: "GET",
      url: "/api/auth/google/start",
      remoteAddress: "192.0.2.10",
      headers: { "x-forwarded-for": "198.51.100.10" },
    });
    const spoofed = await app.inject({
      method: "GET",
      url: "/api/auth/google/start",
      remoteAddress: "192.0.2.10",
      headers: { "x-forwarded-for": "198.51.100.11" },
    });

    expect(first.statusCode).toBe(302);
    expect(spoofed.statusCode).toBe(429);
    await app.close();
  });

  it("distinguishes direct peers by socket address", async () => {
    const app = await buildLimitedAuthApp();

    const first = await app.inject({
      method: "GET",
      url: "/api/auth/google/start",
      remoteAddress: "192.0.2.10",
      headers: { "x-forwarded-for": "198.51.100.10" },
    });
    const second = await app.inject({
      method: "GET",
      url: "/api/auth/google/start",
      remoteAddress: "192.0.2.11",
      headers: { "x-forwarded-for": "198.51.100.10" },
    });

    expect(first.statusCode).toBe(302);
    expect(second.statusCode).toBe(302);
    await app.close();
  });

  it("gives clients behind one trusted proxy independent auth limiter buckets", async () => {
    const app = await buildLimitedAuthApp(1);

    const first = await app.inject({
      method: "GET",
      url: "/api/auth/google/start",
      remoteAddress: "10.0.0.5",
      headers: { "x-forwarded-for": "198.51.100.10" },
    });
    const second = await app.inject({
      method: "GET",
      url: "/api/auth/google/start",
      remoteAddress: "10.0.0.5",
      headers: { "x-forwarded-for": "198.51.100.11" },
    });

    expect(first.statusCode).toBe(302);
    expect(second.statusCode).toBe(302);
    await app.close();
  });

  it("ignores untrusted forwarding prefixes behind one proxy", async () => {
    const app = await buildLimitedAuthApp(1);

    const first = await app.inject({
      method: "GET",
      url: "/api/auth/google/start",
      remoteAddress: "10.0.0.5",
      headers: { "x-forwarded-for": "203.0.113.10, 198.51.100.10" },
    });
    const spoofed = await app.inject({
      method: "GET",
      url: "/api/auth/google/start",
      remoteAddress: "10.0.0.5",
      headers: { "x-forwarded-for": "203.0.113.11, 198.51.100.10" },
    });

    expect(first.statusCode).toBe(302);
    expect(spoofed.statusCode).toBe(429);
    expect(spoofed.headers["retry-after"]).toBe("10");
    expect(spoofed.json()).toEqual({ error: "auth_rate_limited" });
    await app.close();
  });

  it.each([
    ["http://mafia.example.test", false],
    ["https://mafia.example.test", true],
    ["HTTPS://mafia.example.test", true],
  ])("sets a compatible response baseline for %s", async (publicAppUrl, secure) => {
    const app = await buildApp({ stores, publicAppUrl });
    await app.ready();

    const live = await app.inject({ method: "GET", url: "/health/live" });
    const session = await app.inject({ method: "GET", url: "/api/auth/session" });

    expectSecurityHeaders(live.headers, "health");
    expectSecurityHeaders(session.headers, "session");
    expect(session.headers["cache-control"]).toBe("no-store");
    if (secure) {
      expect(live.headers["strict-transport-security"]).toBe("max-age=31536000");
      expect(live.headers["content-security-policy"]).toContain("upgrade-insecure-requests");
    } else {
      expect(live.headers["strict-transport-security"]).toBeUndefined();
      expect(live.headers["content-security-policy"]).not.toContain("upgrade-insecure-requests");
    }
    await app.close();
  });
});

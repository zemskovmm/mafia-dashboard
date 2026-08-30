import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";

const pool = { query: vi.fn() } as unknown as Pool;

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
  it.each([
    ["http://mafia.example.test", false],
    ["https://mafia.example.test", true],
    ["HTTPS://mafia.example.test", true],
  ])("sets a compatible response baseline for %s", async (publicAppUrl, secure) => {
    const app = await buildApp({ pool, publicAppUrl });
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

import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { composeAppVersion } from "./app-version.js";
import { loadConfig } from "./config.js";

describe("application version", () => {
  it("allows zero components and uses the local default build index", () => {
    expect(composeAppVersion("2.7.9", loadConfig({}).APP_BUILD_INDEX)).toBe("2.7.0");
    expect(composeAppVersion("0.0.0", 0)).toBe("0.0.0");
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
    "rejects invalid numeric components %s",
    (value) => {
      expect(() => composeAppVersion(`${value}.0.0`, 0)).toThrow();
      expect(() => composeAppVersion(`1.${value}.0`, 0)).toThrow();
      expect(() => composeAppVersion(`1.0.${value}`, 0)).toThrow();
      expect(() => composeAppVersion("1.0.0", value)).toThrow();
    },
  );

  it.each([null, {}, "", "2.7", "02.7.9", "2.7.9.1", "2.7.9-beta", " 2.7.9"])(
    "rejects malformed package version %j",
    (settings) => {
      expect(() => composeAppVersion(settings, 123)).toThrow();
    },
  );

  it("exposes the configured base and CI index without authentication or caching", async () => {
    const config = loadConfig({ APP_BUILD_INDEX: "123" });
    const pool = new Pool();
    const app = await buildApp({
      pool,
      releaseIdentity: {
        version: composeAppVersion("2.7.9", config.APP_BUILD_INDEX),
        commit: "a".repeat(40),
      },
    });
    try {
      const response = await app.inject({ method: "GET", url: "/health/version" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ version: "2.7.123", commit: "a".repeat(40) });
      expect(response.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
      await pool.end();
    }
  });
});

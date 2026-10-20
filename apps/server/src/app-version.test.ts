import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { composeAppVersion } from "./app-version.js";
import { loadConfig } from "./config.js";
import type { ApplicationStores } from "./storage-contracts.js";

const azureConfig = {
  AZURE_STORAGE_ACCOUNT_NAME: "mafiatest01",
  AZURE_STORAGE_PARTITION_KEY: "version-test",
};

describe("application version", () => {
  it("allows zero components and uses the local default build index", () => {
    expect(composeAppVersion("2.7.9", loadConfig(azureConfig).APP_BUILD_INDEX)).toBe("2.7.0");
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
    const config = loadConfig({ ...azureConfig, APP_BUILD_INDEX: "123" });
    const unexpectedAccess = vi.fn(async () => {
      throw new Error("Version endpoint must not access persistence");
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
        getRoleIcons: unexpectedAccess,
        list: unexpectedAccess,
        get: unexpectedAccess,
        create: unexpectedAccess,
        update: unexpectedAccess,
        delete: unexpectedAccess,
      },
      clubs: {
        listForUser: unexpectedAccess,
        getRole: unexpectedAccess,
        create: unexpectedAccess,
        claimClubAccess: unexpectedAccess,
        update: unexpectedAccess,
        delete: unexpectedAccess,
      },
      ready: unexpectedAccess,
    };
    const app = await buildApp({
      stores,
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
      expect(unexpectedAccess).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

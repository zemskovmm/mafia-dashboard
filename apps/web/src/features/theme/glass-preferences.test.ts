import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GLASS_SETTINGS,
  GLASS_STORAGE_KEY,
  readGlassSettings,
  validateGlassSettings,
  writeGlassSettings,
} from "./glass-preferences.js";

describe("device-local glass preferences", () => {
  it.each([null, "", "not JSON", "[]", "false", '{"version":2,"enabled":true}'])(
    "rejects malformed storage %s",
    (raw) => {
      expect(readGlassSettings(() => ({ getItem: () => raw }))).toEqual(DEFAULT_GLASS_SETTINGS);
    },
  );
  it.each([Number.NaN, Infinity, -1, 25, "10", null])(
    "rejects invalid refraction %s without corrupting valid gold",
    (refraction) => {
      expect(
        validateGlassSettings({ version: 1, enabled: true, refraction, goldLight: 70 }),
      ).toEqual({ version: 1, enabled: true, refraction: 10, goldLight: 70 });
    },
  );
  it.each([Number.NaN, Infinity, -1, 101, "25", null])(
    "rejects invalid gold %s without changing refraction",
    (goldLight) => {
      expect(
        validateGlassSettings({ version: 1, enabled: false, refraction: 24, goldLight }),
      ).toEqual({ version: 1, enabled: false, refraction: 24, goldLight: 25 });
    },
  );
  it.each([0, 24])("preserves refraction boundary %s", (refraction) => {
    expect(
      validateGlassSettings({ version: 1, enabled: "true", refraction, goldLight: 0 }),
    ).toEqual({ version: 1, enabled: false, refraction, goldLight: 0 });
  });
  it("persists only the versioned bounded appearance settings", () => {
    const setItem = vi.fn();
    const value = { version: 1, enabled: true, refraction: 24, goldLight: 100 } as const;
    writeGlassSettings(value, () => ({ setItem }));
    expect(setItem).toHaveBeenCalledExactlyOnceWith(GLASS_STORAGE_KEY, JSON.stringify(value));
    expect(readGlassSettings(() => ({ getItem: () => JSON.stringify(value) }))).toEqual(value);
  });
  it("guards blocked storage access, reads and writes", () => {
    const fail = () => {
      throw new DOMException("Denied", "SecurityError");
    };
    expect(readGlassSettings(fail)).toEqual(DEFAULT_GLASS_SETTINGS);
    expect(readGlassSettings(() => ({ getItem: fail }))).toEqual(DEFAULT_GLASS_SETTINGS);
    expect(() => writeGlassSettings(DEFAULT_GLASS_SETTINGS, fail)).not.toThrow();
    expect(() =>
      writeGlassSettings(DEFAULT_GLASS_SETTINGS, () => ({ setItem: fail })),
    ).not.toThrow();
  });
});

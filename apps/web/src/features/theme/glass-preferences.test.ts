import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GLASS_SETTINGS,
  GLASS_STORAGE_KEY,
  readGlassSettings,
  validateGlassSettings,
  writeGlassSettings,
} from "./glass-preferences.js";

const approvedDefaults = {
  version: 1,
  enabled: false,
  refraction: 10,
  goldLight: 25,
  nominationTint: 18,
  nominationColor: "#e6bc7e",
  nominationTreatment: "hybrid",
  nominationIcon: "vote",
  supportIcon: "hand",
  selectionStyle: "check-outline",
} as const;

const customizedSettings = {
  version: 1,
  enabled: false,
  refraction: 10,
  goldLight: 70,
  nominationTint: 35,
  nominationColor: "#39a9db",
  nominationTreatment: "tint",
  nominationIcon: "flag",
  supportIcon: "thumbs-up",
  selectionStyle: "check",
} as const;

const numericFields = [
  ["refraction", 24],
  ["goldLight", 100],
  ["nominationTint", 50],
] as const;

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
      ).toEqual({ ...approvedDefaults, enabled: true, refraction: 10, goldLight: 70 });
    },
  );
  it.each([Number.NaN, Infinity, -1, 101, "25", null])(
    "rejects invalid gold %s without changing refraction",
    (goldLight) => {
      expect(
        validateGlassSettings({ version: 1, enabled: false, refraction: 24, goldLight }),
      ).toEqual({ ...approvedDefaults, enabled: false, refraction: 24, goldLight: 25 });
    },
  );
  it.each([0, 24])("preserves refraction boundary %s", (refraction) => {
    expect(
      validateGlassSettings({ version: 1, enabled: "true", refraction, goldLight: 0 }),
    ).toEqual({ ...approvedDefaults, enabled: false, refraction, goldLight: 0 });
  });
  it("persists only the versioned bounded appearance settings", () => {
    const setItem = vi.fn();
    const value = customizedSettings;
    writeGlassSettings(value, () => ({ setItem }));
    expect(setItem).toHaveBeenCalledExactlyOnceWith(GLASS_STORAGE_KEY, JSON.stringify(value));
    expect(readGlassSettings(() => ({ getItem: () => JSON.stringify(value) }))).toEqual(value);
  });
  it.each(numericFields)("validates %s independently within 0..%s", (field, maximum) => {
    for (const value of [0, maximum / 2, maximum]) {
      expect(validateGlassSettings({ ...customizedSettings, [field]: value })).toEqual({
        ...customizedSettings,
        [field]: value,
      });
    }
    for (const value of [undefined, null, false, "10", Number.NaN, Infinity, -1, maximum + 1]) {
      expect(validateGlassSettings({ ...customizedSettings, [field]: value })).toEqual({
        ...customizedSettings,
        [field]: approvedDefaults[field],
      });
    }
  });
  it("validates the six player-card fields independently and accepts only six-digit hex colors", () => {
    const choices = {
      nominationTreatment: ["icons", "tint", "hybrid"],
      nominationIcon: ["vote", "flag"],
      supportIcon: ["hand", "thumbs-up"],
      selectionStyle: ["check-outline", "check"],
    } as const;
    for (const field of Object.keys(choices) as (keyof typeof choices)[]) {
      for (const value of choices[field]) {
        expect(validateGlassSettings({ ...customizedSettings, [field]: value })).toEqual({
          ...customizedSettings,
          [field]: value,
        });
      }
      for (const value of [undefined, null, false, 1, "", "unknown", "CHECK"]) {
        expect(validateGlassSettings({ ...customizedSettings, [field]: value })).toEqual({
          ...customizedSettings,
          [field]: approvedDefaults[field],
        });
      }
    }
    for (const nominationColor of ["#000000", "#FFFFFF", "#e6bc7e", "#39a9db"]) {
      expect(validateGlassSettings({ ...customizedSettings, nominationColor })).toEqual({
        ...customizedSettings,
        nominationColor,
      });
    }
    for (const nominationColor of [
      undefined,
      null,
      0,
      "red",
      "#fff",
      "#12345678",
      "123456",
      "#12345g",
      " #123456",
      "#123456\n",
      "url(x)",
    ]) {
      expect(validateGlassSettings({ ...customizedSettings, nominationColor })).toEqual({
        ...customizedSettings,
        nominationColor: approvedDefaults.nominationColor,
      });
    }
  });
  it("retains committed glass defaults and fills missing player-card settings", () => {
    expect(DEFAULT_GLASS_SETTINGS).toEqual(approvedDefaults);
    expect(
      validateGlassSettings({ version: 1, enabled: true, refraction: 24, goldLight: 70 }),
    ).toEqual({ ...approvedDefaults, enabled: true, refraction: 24, goldLight: 70 });
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

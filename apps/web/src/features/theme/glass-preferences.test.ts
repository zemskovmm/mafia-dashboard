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
  enabled: true,
  refraction: 14,
  goldLight: 25,
  matte: true,
  profile: "edge",
  frosting: 50,
  tint: 13,
  edgeHighlights: 100,
  caustics: 100,
  nominationTint: 18,
  nominationColor: "#e6bc7e",
  nominationTreatment: "hybrid",
  buttonFrosting: 70,
  buttonGold: 35,
} as const;

const customizedSettings = {
  version: 1,
  enabled: false,
  refraction: 10,
  goldLight: 70,
  matte: false,
  profile: "simple",
  frosting: 75,
  tint: 20,
  edgeHighlights: 80,
  caustics: 60,
  nominationTint: 35,
  nominationColor: "#39a9db",
  nominationTreatment: "tint",
  buttonFrosting: 20,
  buttonGold: 80,
} as const;

const numericFields = [
  ["refraction", 24],
  ["goldLight", 100],
  ["frosting", 100],
  ["tint", 30],
  ["edgeHighlights", 100],
  ["caustics", 100],
  ["nominationTint", 50],
  ["buttonFrosting", 100],
  ["buttonGold", 100],
] as const;

describe("device-local glass preferences", () => {
  it("discards retired glyph/check choices, including on persisted writes, without resetting retained values", () => {
    const old = {
      ...customizedSettings,
      nominationIcon: "flag",
      supportIcon: "thumbs-up",
      selectionStyle: "check-outline",
    };
    expect(validateGlassSettings(old)).toEqual(customizedSettings);
    const setItem = vi.fn();
    writeGlassSettings(old, () => ({ setItem }));
    expect(JSON.parse(setItem.mock.calls[0]![1])).toEqual(customizedSettings);
  });
  it("uses the approved expanded defaults for fresh and reset settings", () => {
    expect(DEFAULT_GLASS_SETTINGS).toEqual(approvedDefaults);
    expect(readGlassSettings(() => ({ getItem: () => null }))).toEqual(approvedDefaults);
    expect(validateGlassSettings({ version: 1 })).toEqual(approvedDefaults);
  });
  it("preserves valid old v1 OFF, strength, gold and Matte choices", () => {
    const stored = { version: 1, enabled: false, refraction: 10, goldLight: 70, matte: false };
    const settings = readGlassSettings(() => ({ getItem: () => JSON.stringify(stored) }));
    expect(settings).toEqual({ ...approvedDefaults, ...stored });
    expect(validateGlassSettings({ version: 1, enabled: false, refraction: 10 })).toEqual({
      ...approvedDefaults,
      enabled: false,
      refraction: 10,
    });
  });
  it.each([0, 40, 100, "invalid", null])(
    "discards retired Noir contrast %s while preserving and persisting every retained v1 choice",
    (noirContrast) => {
      const legacySettings = { ...customizedSettings, noirContrast };
      const settings = readGlassSettings(() => ({ getItem: () => JSON.stringify(legacySettings) }));
      expect(settings).toEqual(customizedSettings);
      expect(settings).not.toHaveProperty("noirContrast");
      expect(validateGlassSettings(legacySettings)).toEqual(customizedSettings);
      const setItem = vi.fn();
      writeGlassSettings(legacySettings, () => ({ setItem }));
      expect(setItem).toHaveBeenCalledExactlyOnceWith(GLASS_STORAGE_KEY, expect.any(String));
      expect(JSON.parse(setItem.mock.calls[0]![1])).toEqual(customizedSettings);
    },
  );
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
  it.each(["enabled", "matte"] as const)("validates %s as an independent boolean", (field) => {
    for (const value of [true, false]) {
      expect(validateGlassSettings({ ...customizedSettings, [field]: value })).toEqual({
        ...customizedSettings,
        [field]: value,
      });
    }
    for (const value of [undefined, null, 0, 1, "false"]) {
      expect(validateGlassSettings({ ...customizedSettings, [field]: value })).toEqual({
        ...customizedSettings,
        [field]: approvedDefaults[field],
      });
    }
  });
  it("accepts only the two global profiles without resetting other choices", () => {
    for (const profile of ["edge", "simple"]) {
      expect(validateGlassSettings({ ...customizedSettings, profile })).toEqual({
        ...customizedSettings,
        profile,
      });
    }
    for (const profile of [undefined, null, false, 0, "", "Edge", "unknown"]) {
      expect(validateGlassSettings({ ...customizedSettings, profile })).toEqual({
        ...customizedSettings,
        profile: "edge",
      });
    }
  });
  it.each([true, false, undefined, null, 0, "false"])(
    "round-trips matte %s independently of valid existing v1 settings",
    (matte) => {
      const stored = { version: 1, enabled: true, refraction: 24, goldLight: 70, matte };
      const settings = readGlassSettings(() => ({ getItem: () => JSON.stringify(stored) }));
      const expected = {
        ...approvedDefaults,
        ...stored,
        matte: typeof matte === "boolean" ? matte : true,
      };
      expect(settings).toEqual(expected);
      const setItem = vi.fn();
      writeGlassSettings(settings, () => ({ setItem }));
      expect(setItem).toHaveBeenCalledExactlyOnceWith(GLASS_STORAGE_KEY, expect.any(String));
      expect(JSON.parse(setItem.mock.calls[0]![1])).toEqual(expected);
      expect(DEFAULT_GLASS_SETTINGS).toHaveProperty("matte", true);
    },
  );
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
      ).toEqual({ ...DEFAULT_GLASS_SETTINGS, enabled: true, goldLight: 70 });
    },
  );
  it.each([Number.NaN, Infinity, -1, 101, "25", null])(
    "rejects invalid gold %s without changing refraction",
    (goldLight) => {
      expect(
        validateGlassSettings({ version: 1, enabled: false, refraction: 24, goldLight }),
      ).toEqual({ ...DEFAULT_GLASS_SETTINGS, enabled: false, refraction: 24 });
    },
  );
  it.each([0, 24])("preserves refraction boundary %s", (refraction) => {
    expect(
      validateGlassSettings({ version: 1, enabled: "true", refraction, goldLight: 0 }),
    ).toEqual({ ...DEFAULT_GLASS_SETTINGS, refraction, goldLight: 0 });
  });
  it("persists only the versioned bounded appearance settings", () => {
    const setItem = vi.fn();
    const value = customizedSettings;
    const withDerivedState = { ...value, active: true, resolvedTint: 0.2, status: "ready" };
    writeGlassSettings(withDerivedState, () => ({ setItem }));
    expect(setItem).toHaveBeenCalledExactlyOnceWith(GLASS_STORAGE_KEY, expect.any(String));
    expect(JSON.parse(setItem.mock.calls[0]![1])).toEqual(value);
    expect(readGlassSettings(() => ({ getItem: () => JSON.stringify(value) }))).toEqual(value);
  });
  it("validates the six player-card fields independently and accepts only six-digit hex colors", () => {
    const choices = {
      nominationTreatment: ["icons", "tint", "hybrid"],
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

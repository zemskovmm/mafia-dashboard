import { describe, expect, it } from "vitest";
import {
  DEFAULT_GLASS_SETTINGS,
  GLASS_SETTINGS_BOUNDS,
  GLASS_SETTINGS_STORAGE_KEY,
  readGlassSettings,
  sanitizeGlassSettings,
  writeGlassSettings,
} from "./glass-settings.js";

describe("glass settings", () => {
  it("uses the exact safe defaults when no settings are stored", () => {
    const seenKeys: string[] = [];

    const settings = readGlassSettings({
      getItem: (key) => {
        seenKeys.push(key);
        return null;
      },
    });

    expect(GLASS_SETTINGS_STORAGE_KEY).toBe("mafia-dashboard.glass-settings.v1");
    expect(seenKeys).toEqual([GLASS_SETTINGS_STORAGE_KEY]);
    expect(settings).toEqual({
      enabled: true,
      blur: 4,
      glassThickness: 70,
      bezelWidth: 10,
      refractiveIndex: 1.5,
      specularOpacity: 0.28,
      specularAngle: 45,
      fallbackOpacity: 0.62,
    });
    expect(settings).toEqual(DEFAULT_GLASS_SETTINGS);
  });

  it("reads valid stored appearance settings", () => {
    const stored = {
      enabled: false,
      blur: 8,
      glassThickness: 90,
      bezelWidth: 6,
      refractiveIndex: 1.7,
      specularOpacity: 0.4,
      specularAngle: 120,
      fallbackOpacity: 0.75,
    };

    expect(readGlassSettings({ getItem: () => JSON.stringify(stored) })).toEqual(stored);
  });

  it("clamps effect values to safe bounds and keeps the bezel below the smallest surface", () => {
    expect(
      sanitizeGlassSettings(
        {
          enabled: "yes",
          blur: -100,
          glassThickness: 10_000,
          bezelWidth: 100,
          refractiveIndex: -50,
          specularOpacity: 3,
          specularAngle: -45,
          fallbackOpacity: -4,
        },
        8,
      ),
    ).toEqual({
      enabled: true,
      blur: GLASS_SETTINGS_BOUNDS.blur.min,
      glassThickness: GLASS_SETTINGS_BOUNDS.glassThickness.max,
      bezelWidth: 7,
      refractiveIndex: GLASS_SETTINGS_BOUNDS.refractiveIndex.min,
      specularOpacity: GLASS_SETTINGS_BOUNDS.specularOpacity.max,
      specularAngle: 315,
      fallbackOpacity: GLASS_SETTINGS_BOUNDS.fallbackOpacity.min,
    });
  });

  it("recovers from corrupt and non-finite settings without violating the radius bound", () => {
    expect(readGlassSettings({ getItem: () => "{bad json" }, 8)).toEqual({
      ...DEFAULT_GLASS_SETTINGS,
      bezelWidth: 7,
    });
    expect(
      sanitizeGlassSettings(
        {
          blur: Number.NaN,
          glassThickness: Number.POSITIVE_INFINITY,
          specularAngle: Number.NEGATIVE_INFINITY,
        },
        8,
      ),
    ).toEqual({ ...DEFAULT_GLASS_SETTINGS, bezelWidth: 7 });
  });

  it("writes only sanitized appearance fields to the versioned key", () => {
    let storedKey = "";
    let storedValue = "";

    const written = writeGlassSettings(
      {
        setItem: (key, value) => {
          storedKey = key;
          storedValue = value;
        },
      },
      {
        ...DEFAULT_GLASS_SETTINGS,
        bezelWidth: 50,
        secret: "must-not-persist",
        playerState: { seat: 4 },
        bezelHeightFn: "must-not-persist",
      },
      8,
    );

    expect(storedKey).toBe(GLASS_SETTINGS_STORAGE_KEY);
    expect(JSON.parse(storedValue)).toEqual({ ...DEFAULT_GLASS_SETTINGS, bezelWidth: 7 });
    expect(written).toEqual({ ...DEFAULT_GLASS_SETTINGS, bezelWidth: 7 });
  });
});

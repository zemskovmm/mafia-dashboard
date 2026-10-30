import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PLAYER_EXIT_SETTINGS,
  PLAYER_EXIT_STORAGE_KEY,
  readPlayerExitSettings,
  validatePlayerExitSettings,
  writePlayerExitSettings,
} from "./player-exit-preferences.js";

describe("player exit preferences", () => {
  it("uses the selected screenshot defaults and round-trips independent local tuning", () => {
    expect(DEFAULT_PLAYER_EXIT_SETTINGS).toEqual({
      version: 1,
      enabled: true,
      liftMs: 100,
      landingMs: 480,
      overlap: 100,
      lift: { easing: "out", strength: 100 },
      flip: { easing: "out", strength: 100 },
      drop: { easing: "out", strength: 100 },
      impactMs: 420,
      tearMs: 360,
      fadeMs: 360,
      disciplineMs: 600,
      gap: 6,
      finalOpacity: 45,
    });
    const storage = { getItem: vi.fn(() => null as string | null), setItem: vi.fn() };
    expect(readPlayerExitSettings(() => storage)).toEqual(DEFAULT_PLAYER_EXIT_SETTINGS);
    const changed = {
      ...DEFAULT_PLAYER_EXIT_SETTINGS,
      enabled: false,
      liftMs: 700,
      landingMs: 200,
      overlap: 0,
      flip: { easing: "in" as const, strength: 55 },
    };
    writePlayerExitSettings(changed, () => storage);
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(
      PLAYER_EXIT_STORAGE_KEY,
      JSON.stringify(changed),
    );
    storage.getItem.mockReturnValue(JSON.stringify(changed));
    expect(readPlayerExitSettings(() => storage)).toEqual(changed);
  });

  it("defaults invalid fields independently without losing saved OFF or valid tuning", () => {
    expect(
      validatePlayerExitSettings({
        ...DEFAULT_PLAYER_EXIT_SETTINGS,
        enabled: false,
        liftMs: 79,
        landingMs: 1401,
        overlap: Infinity,
        lift: { easing: "unknown", strength: 45 },
        flip: { easing: "linear", strength: NaN },
        drop: { easing: "original", strength: -1 },
      }),
    ).toEqual({
      ...DEFAULT_PLAYER_EXIT_SETTINGS,
      enabled: false,
      lift: { easing: "out", strength: 45 },
      flip: { easing: "linear", strength: 100 },
      drop: { easing: "original", strength: 100 },
    });
    for (const value of [null, [], "bad", { version: 2 }, { enabled: false }]) {
      expect(validatePlayerExitSettings(value)).toEqual(DEFAULT_PLAYER_EXIT_SETTINGS);
    }
  });

  it("migrates a stored v1 OFF record without resetting turn timing or independent curves", () => {
    const legacy = {
      version: 1,
      enabled: false,
      liftMs: 350,
      landingMs: 820,
      overlap: 35,
      lift: { easing: "original", strength: 15 },
      flip: { easing: "linear", strength: 0 },
      drop: { easing: "in-out", strength: 75 },
    };
    const storage = { getItem: vi.fn(() => JSON.stringify(legacy)), setItem: vi.fn() };
    const migrated = readPlayerExitSettings(() => storage);
    expect(migrated).toEqual({ ...DEFAULT_PLAYER_EXIT_SETTINGS, ...legacy });
    expect(storage.getItem).toHaveBeenCalledExactlyOnceWith(PLAYER_EXIT_STORAGE_KEY);
    expect(storage.setItem).not.toHaveBeenCalled();
    writePlayerExitSettings(migrated, () => storage);
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(
      PLAYER_EXIT_STORAGE_KEY,
      JSON.stringify(migrated),
    );
  });

  it.each([
    ["liftMs", 80, 700],
    ["landingMs", 200, 1400],
    ["overlap", 0, 100],
    ["impactMs", 240, 900],
    ["tearMs", 200, 800],
    ["fadeMs", 200, 900],
    ["disciplineMs", 300, 1000],
    ["gap", 2, 12],
    ["finalOpacity", 25, 70],
  ] as const)(
    "bounds %s independently, accepting edges and defaulting outside them",
    (key, min, max) => {
      const saved = {
        ...DEFAULT_PLAYER_EXIT_SETTINGS,
        enabled: false,
        flip: { easing: "original" as const, strength: 45 },
      };
      for (const value of [min, max, (min + max) / 2]) {
        expect(validatePlayerExitSettings({ ...saved, [key]: value })).toEqual({
          ...saved,
          [key]: value,
        });
      }
      // This v1 validator defaults invalid fields; it does not coerce or silently clamp them.
      for (const value of [min - 1, max + 1, NaN, Infinity, -Infinity, "300", null, undefined]) {
        expect(validatePlayerExitSettings({ ...saved, [key]: value })).toEqual(saved);
      }
    },
  );

  it("round-trips the new phases and endpoints without changing OFF or the stored curves", () => {
    const saved = {
      ...DEFAULT_PLAYER_EXIT_SETTINGS,
      enabled: false,
      impactMs: 900,
      tearMs: 200,
      fadeMs: 900,
      disciplineMs: 300,
      gap: 12,
      finalOpacity: 25,
      lift: { easing: "in" as const, strength: 0 },
      drop: { easing: "original" as const, strength: 100 },
    };
    let value: string | null = null;
    const storage = {
      getItem: () => value,
      setItem: (_key: string, next: string) => {
        value = next;
      },
    };
    writePlayerExitSettings(saved, () => storage);
    expect(readPlayerExitSettings(() => storage)).toEqual(saved);
  });

  it("remains usable with malformed or denied browser storage", () => {
    expect(readPlayerExitSettings(() => ({ getItem: () => "{bad" }))).toEqual(
      DEFAULT_PLAYER_EXIT_SETTINGS,
    );
    const denied = () => {
      throw new Error("Storage denied");
    };
    expect(readPlayerExitSettings(denied)).toEqual(DEFAULT_PLAYER_EXIT_SETTINGS);
    expect(() => writePlayerExitSettings(DEFAULT_PLAYER_EXIT_SETTINGS, denied)).not.toThrow();
    expect(() =>
      writePlayerExitSettings(DEFAULT_PLAYER_EXIT_SETTINGS, () => ({ setItem: denied })),
    ).not.toThrow();
  });
});

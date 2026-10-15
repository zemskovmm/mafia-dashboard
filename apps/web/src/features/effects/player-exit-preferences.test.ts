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

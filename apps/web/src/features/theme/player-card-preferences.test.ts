import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PLAYER_CARD_PREFERENCES,
  PLAYER_CARD_PREFERENCES_KEY,
  readPlayerCardPreferences,
  validatePlayerCardPreferences,
  writePlayerCardPreferences,
  type PlayerCardPreferences,
} from "./player-card-preferences.js";

const storageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage")!;
const styles = ["glass", "classic", "heritage", "noir"] as const;
const placements = ["below", "ribbon", "top"] as const;
const denied = () => {
  throw new DOMException("Storage denied", "SecurityError");
};

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, "localStorage", storageDescriptor);
});

describe("browser-local player-card preferences", () => {
  it("uses Glass and below-name defaults without writing a missing preference", () => {
    const setItem = vi.spyOn(window.localStorage, "setItem");
    expect(DEFAULT_PLAYER_CARD_PREFERENCES).toEqual({ style: "glass", rolePlacement: "below" });
    expect(readPlayerCardPreferences()).toEqual(DEFAULT_PLAYER_CARD_PREFERENCES);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("round-trips all choices using only the dedicated key and strips unrelated state", () => {
    const getItem = vi.spyOn(window.localStorage, "getItem");
    const setItem = vi.spyOn(window.localStorage, "setItem");
    for (const style of styles) {
      for (const rolePlacement of placements) {
        const settings: PlayerCardPreferences = { style, rolePlacement };
        const withUnrelatedState = { ...settings, game: "not a preference" };
        writePlayerCardPreferences(withUnrelatedState);
        expect(setItem).toHaveBeenLastCalledWith(
          PLAYER_CARD_PREFERENCES_KEY,
          JSON.stringify(settings),
        );
        expect(readPlayerCardPreferences()).toEqual(settings);
        expect(getItem).toHaveBeenLastCalledWith(PLAYER_CARD_PREFERENCES_KEY);
      }
    }
    expect(new Set(setItem.mock.calls.map(([key]) => key))).toEqual(
      new Set([PLAYER_CARD_PREFERENCES_KEY]),
    );
    expect(window.localStorage.length).toBe(1);
  });

  it("defaults each invalid field independently and preserves the other valid choice", () => {
    for (const style of styles) {
      for (const rolePlacement of [undefined, null, 0, false, "", "Below", "unknown"]) {
        expect(validatePlayerCardPreferences({ style, rolePlacement })).toEqual({
          style,
          rolePlacement: "below",
        });
      }
    }
    for (const rolePlacement of placements) {
      for (const style of [undefined, null, 0, false, "", "Glass", "unknown"]) {
        expect(validatePlayerCardPreferences({ style, rolePlacement })).toEqual({
          style: "glass",
          rolePlacement,
        });
      }
    }
    expect(validatePlayerCardPreferences({ style: "noir" })).toEqual({
      style: "noir",
      rolePlacement: "below",
    });
    expect(validatePlayerCardPreferences({ rolePlacement: "top" })).toEqual({
      style: "glass",
      rolePlacement: "top",
    });
  });

  it.each([undefined, null, false, 3, "noir", [], ["classic"], {}])(
    "defaults non-record or missing settings: %j",
    (value) => {
      expect(validatePlayerCardPreferences(value)).toEqual(DEFAULT_PLAYER_CARD_PREFERENCES);
    },
  );

  it("defaults malformed storage without rewriting it and validates partial saved fields", () => {
    for (const raw of ["{broken", "null", "false", "3", '"noir"', "[]", "{}"] as const) {
      window.localStorage.setItem(PLAYER_CARD_PREFERENCES_KEY, raw);
      const setItem = vi.spyOn(window.localStorage, "setItem");
      expect(readPlayerCardPreferences()).toEqual(DEFAULT_PLAYER_CARD_PREFERENCES);
      expect(setItem).not.toHaveBeenCalled();
      setItem.mockRestore();
      expect(window.localStorage.getItem(PLAYER_CARD_PREFERENCES_KEY)).toBe(raw);
    }
    window.localStorage.setItem(
      PLAYER_CARD_PREFERENCES_KEY,
      JSON.stringify({ style: "invalid", rolePlacement: "ribbon" }),
    );
    expect(readPlayerCardPreferences()).toEqual({ style: "glass", rolePlacement: "ribbon" });
    writePlayerCardPreferences({ style: "noir", rolePlacement: "invalid" } as never);
    expect(readPlayerCardPreferences()).toEqual({ style: "noir", rolePlacement: "below" });
  });

  it("does not access or change Glass, icons, game or profile data", () => {
    const unrelated = [
      ["mafia-dashboard.glass.v1", '{"version":1,"matte":false}'],
      ["mafia-dashboard.custom-role-icons.v1", "saved icons"],
      ["mafia-dashboard.game-session.v5", "saved game"],
      ["mafia-dashboard.player-profile.v1", "saved profile"],
    ] as const;
    for (const [key, value] of unrelated) window.localStorage.setItem(key, value);
    const getItem = vi.spyOn(window.localStorage, "getItem");
    const setItem = vi.spyOn(window.localStorage, "setItem");
    writePlayerCardPreferences({ style: "heritage", rolePlacement: "ribbon" });
    writePlayerCardPreferences({ style: "glass", rolePlacement: "ribbon" });
    expect(readPlayerCardPreferences()).toEqual({ style: "glass", rolePlacement: "ribbon" });
    expect(getItem).toHaveBeenCalledExactlyOnceWith(PLAYER_CARD_PREFERENCES_KEY);
    expect(setItem.mock.calls.map(([key]) => key)).toEqual([
      PLAYER_CARD_PREFERENCES_KEY,
      PLAYER_CARD_PREFERENCES_KEY,
    ]);
    for (const [key, value] of unrelated) expect(window.localStorage.getItem(key)).toBe(value);
    expect(window.localStorage.length).toBe(unrelated.length + 1);
  });

  it("catches denial when resolving global localStorage", () => {
    Object.defineProperty(window, "localStorage", { configurable: true, get: denied });
    expect(readPlayerCardPreferences()).toEqual(DEFAULT_PLAYER_CARD_PREFERENCES);
    expect(() => writePlayerCardPreferences({ style: "noir", rolePlacement: "top" })).not.toThrow();
  });

  it("catches denied getItem and setItem calls", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(denied);
    vi.spyOn(window.localStorage, "setItem").mockImplementation(denied);
    expect(readPlayerCardPreferences()).toEqual(DEFAULT_PLAYER_CARD_PREFERENCES);
    expect(() =>
      writePlayerCardPreferences({ style: "classic", rolePlacement: "top" }),
    ).not.toThrow();
  });
});

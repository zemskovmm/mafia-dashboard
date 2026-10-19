import { describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_OPTIONS,
  BACKGROUND_STORAGE_KEY,
  backgroundAsset,
  readBackground,
  writeBackground,
} from "./background-preferences.js";

describe("device-local app backgrounds", () => {
  it("round-trips every supported city and plain shade without touching other preferences", () => {
    const values = new Map([["mafia-dashboard.glass.v1", "unchanged"]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    expect(readBackground(() => storage)).toBe("noir-skyline");
    for (const { id } of BACKGROUND_OPTIONS) {
      writeBackground(id, () => storage);
      expect(readBackground(() => storage)).toBe(id);
      expect(JSON.parse(values.get(BACKGROUND_STORAGE_KEY)!)).toEqual({
        version: 1,
        background: id,
      });
    }
    expect(values.get("mafia-dashboard.glass.v1")).toBe("unchanged");
    expect(values.size).toBe(2);
    expect(BACKGROUND_OPTIONS.map(({ id }) => backgroundAsset(id))).toEqual([
      "/backgrounds/noir-skyline.svg",
      "/backgrounds/old-town.svg",
      "/backgrounds/harbour.svg",
      null,
      null,
      null,
      null,
    ]);
  });

  it("defaults invalid records and denied storage without writing a replacement", () => {
    for (const value of [
      null,
      "{broken",
      "null",
      "[]",
      '"harbour"',
      '{"version":2,"background":"white"}',
      '{"version":1,"background":"foreign"}',
      '{"version":1,"background":42}',
    ]) {
      const getItem = vi.fn(() => value);
      expect(readBackground(() => ({ getItem }))).toBe("noir-skyline");
      expect(getItem).toHaveBeenCalledExactlyOnceWith(BACKGROUND_STORAGE_KEY);
    }
    const denied = () => {
      throw new Error("Storage denied");
    };
    expect(readBackground(denied)).toBe("noir-skyline");
    expect(readBackground(() => ({ getItem: denied }))).toBe("noir-skyline");
    expect(() => writeBackground("harbour", denied)).not.toThrow();
    expect(() => writeBackground("harbour", () => ({ setItem: denied }))).not.toThrow();
  });
});

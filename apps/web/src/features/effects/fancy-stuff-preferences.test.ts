import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FANCY_STUFF_SETTINGS,
  FANCY_STUFF_STORAGE_KEY,
  readFancyStuffSettings,
  writeFancyStuffSettings,
} from "./fancy-stuff-preferences.js";

describe("fancy stuff preferences", () => {
  it("defaults on and round-trips an explicit saved OFF independently", () => {
    const values = new Map<string, string>([["unrelated", "unchanged"]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => {
        values.set(key, value);
      }),
    };
    expect(readFancyStuffSettings(() => storage)).toEqual({ version: 1, clubEntryEffects: true });
    const off = { ...DEFAULT_FANCY_STUFF_SETTINGS, clubEntryEffects: false };
    writeFancyStuffSettings(off, () => storage);
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(
      FANCY_STUFF_STORAGE_KEY,
      JSON.stringify(off),
    );
    expect(readFancyStuffSettings(() => storage)).toEqual(off);
    expect(values.get("unrelated")).toBe("unchanged");
  });

  it.each([
    null,
    "{bad",
    "null",
    "[]",
    '"false"',
    '{"clubEntryEffects":false}',
    '{"version":2,"clubEntryEffects":false}',
    '{"version":1,"clubEntryEffects":"false"}',
  ])("defaults safely for absent or malformed stored data: %s", (raw) => {
    expect(readFancyStuffSettings(() => ({ getItem: () => raw }))).toEqual(
      DEFAULT_FANCY_STUFF_SETTINGS,
    );
  });

  it("tolerates denied storage access, reads and writes", () => {
    const denied = () => {
      throw new DOMException("Denied", "SecurityError");
    };
    expect(readFancyStuffSettings(denied)).toEqual(DEFAULT_FANCY_STUFF_SETTINGS);
    expect(readFancyStuffSettings(() => ({ getItem: denied }))).toEqual(
      DEFAULT_FANCY_STUFF_SETTINGS,
    );
    expect(() => writeFancyStuffSettings(DEFAULT_FANCY_STUFF_SETTINGS, denied)).not.toThrow();
    expect(() =>
      writeFancyStuffSettings(DEFAULT_FANCY_STUFF_SETTINGS, () => ({ setItem: denied })),
    ).not.toThrow();
  });
});

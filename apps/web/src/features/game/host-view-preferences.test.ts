import { describe, expect, it, vi } from "vitest";
import { HOST_VIEW_STORAGE_KEY, readHostView, writeHostView } from "./host-view-preferences.js";

describe("host view preference", () => {
  it("remembers only the view and falls back safely without game storage", () => {
    const values = new Map<string, string>();
    const storage = () => ({
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    });
    expect(readHostView(storage)).toBe("table");
    writeHostView("ledger", storage);
    expect(readHostView(storage)).toBe("ledger");
    expect([...values.keys()]).toEqual([HOST_VIEW_STORAGE_KEY]);
    values.set(HOST_VIEW_STORAGE_KEY, "invalid");
    expect(readHostView(storage)).toBe("table");
    const unavailable = vi.fn(() => {
      throw new Error("Denied");
    });
    expect(readHostView(unavailable)).toBe("table");
    expect(() => writeHostView("ledger", unavailable)).not.toThrow();
  });
});

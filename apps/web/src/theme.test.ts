import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  applyThemeColor,
  DEFAULT_THEME_COLOR,
  readThemeColor,
  THEME_COLOR_STORAGE_KEY,
} from "./theme.js";

describe("glass theme color", () => {
  it("defaults malformed preferences to the glass gold", () => {
    expect(readThemeColor({ getItem: () => "unknown" })).toBe(DEFAULT_THEME_COLOR);
  });

  it("normalizes a stored six-digit color", () => {
    expect(readThemeColor({ getItem: () => "#A1B2C3" })).toBe("#a1b2c3");
  });

  it("ignores obsolete theme keys without reading them", () => {
    const getItem = vi.fn((key: string) =>
      key === "mafia-dashboard.color-theme" ? "midnight" : null,
    );

    expect(readThemeColor({ getItem })).toBe(DEFAULT_THEME_COLOR);
    expect(getItem).toHaveBeenCalledExactlyOnceWith(THEME_COLOR_STORAGE_KEY);
  });

  it("applies and persists one base color without modifying obsolete preferences", () => {
    const root = document.createElement("html");
    root.dataset.theme = "malaga";
    const storage = new Map([
      ["mafia-dashboard.color-theme", "midnight"],
      ["mafia-dashboard.glass-settings.v1", '{"opacity":"high"}'],
    ]);
    const setItem = vi.fn((key: string, value: string) => storage.set(key, value));
    const removeItem = vi.fn((key: string) => storage.delete(key));
    const themeStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem,
      removeItem,
    };

    expect(applyThemeColor(root, themeStorage, "#A1B2C3")).toBe("#a1b2c3");

    expect(root.style.getPropertyValue("--theme-base")).toBe("#a1b2c3");
    expect(root).not.toHaveAttribute("data-theme");
    expect(setItem).toHaveBeenCalledWith(THEME_COLOR_STORAGE_KEY, "#a1b2c3");
    expect(removeItem).not.toHaveBeenCalled();
    expect(storage.get("mafia-dashboard.color-theme")).toBe("midnight");
    expect(storage.get("mafia-dashboard.glass-settings.v1")).toBe('{"opacity":"high"}');
  });

  it("does not apply an invalid picker value", () => {
    const root = document.createElement("html");
    const setItem = vi.fn();

    expect(applyThemeColor(root, { getItem: () => null, setItem }, "red")).toBe(
      DEFAULT_THEME_COLOR,
    );
    expect(root.style.getPropertyValue("--theme-base")).toBe(DEFAULT_THEME_COLOR);
    expect(setItem).toHaveBeenCalledWith(THEME_COLOR_STORAGE_KEY, DEFAULT_THEME_COLOR);
  });

  it("derives the ambient glass field from the selected color", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles/app.css"), "utf8");
    const ambientField = css.slice(
      css.indexOf(".app-shell::before"),
      css.indexOf(".live-side-panel :is"),
    );

    expect(ambientField).toContain("rgb(from var(--theme-base) r g b /");
    expect(ambientField).not.toMatch(/255 219 146|40 139 104|225 177 91|48 128 99/);
  });
});

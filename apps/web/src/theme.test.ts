import { describe, expect, it } from "vitest";
import { applyColorTheme, readColorTheme } from "./theme.js";

describe("color themes", () => {
  it("defaults unknown preferences to the midnight scheme", () => {
    expect(readColorTheme({ getItem: () => "unknown" })).toBe("midnight");
  });

  it("applies and persists the Málaga scheme", () => {
    const root = document.createElement("html");
    let stored = "";

    applyColorTheme(root, { setItem: (_key: string, value: string) => (stored = value) }, "malaga");

    expect(root.dataset.theme).toBe("malaga");
    expect(stored).toBe("malaga");
  });
});

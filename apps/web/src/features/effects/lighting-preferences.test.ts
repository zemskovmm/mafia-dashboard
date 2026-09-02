import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LIGHTING_RENDERER,
  LIGHTING_RENDERER_STORAGE_KEY,
  PLAYER_LIGHTING_STORAGE_KEY,
  readLightingRenderer,
  readPlayerLightingEnabled,
  writeLightingRenderer,
  writePlayerLightingEnabled,
} from "./lighting-preferences.js";

describe("lighting preferences", () => {
  it.each([null, "", "canvas", "SVG"])("defaults an invalid renderer value %s to SVG", (value) => {
    expect(readLightingRenderer({ getItem: () => value })).toBe(DEFAULT_LIGHTING_RENDERER);
  });

  it.each(["legacy", "svg", "vgpu"] as const)(
    "restores and persists the %s renderer",
    (renderer) => {
      const setItem = vi.fn();

      expect(
        readLightingRenderer({
          getItem: (key) => (key === LIGHTING_RENDERER_STORAGE_KEY ? renderer : null),
        }),
      ).toBe(renderer);
      writeLightingRenderer({ setItem }, renderer);
      expect(setItem).toHaveBeenCalledWith(LIGHTING_RENDERER_STORAGE_KEY, renderer);
    },
  );

  it("defaults player lighting to enabled and restores exact stored values", () => {
    expect(readPlayerLightingEnabled({ getItem: () => null })).toBe(true);
    expect(readPlayerLightingEnabled({ getItem: () => "enabled" })).toBe(true);
    expect(readPlayerLightingEnabled({ getItem: () => "disabled" })).toBe(false);
    expect(readPlayerLightingEnabled({ getItem: () => "false" })).toBe(true);
  });

  it.each([
    [true, "enabled"],
    [false, "disabled"],
  ] as const)("persists player lighting %s", (enabled, stored) => {
    const setItem = vi.fn();
    writePlayerLightingEnabled({ setItem }, enabled);
    expect(setItem).toHaveBeenCalledWith(PLAYER_LIGHTING_STORAGE_KEY, stored);
  });
});

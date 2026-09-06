import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LIGHTING_RENDERER,
  DEFAULT_PLAYER_PULSE,
  LIGHTING_RENDERER_STORAGE_KEY,
  PLAYER_PULSE_STORAGE_KEY,
  readLightingRenderer,
  readPlayerPulse,
  writeLightingRenderer,
  writePlayerPulse,
} from "./lighting-preferences.js";

describe("lighting preferences", () => {
  it.each([null, "", "canvas", "SVG"])(
    "defaults an invalid renderer value %s to V-GPU",
    (value) => {
      expect(readLightingRenderer({ getItem: () => value })).toBe(DEFAULT_LIGHTING_RENDERER);
    },
  );

  it("resolves the historical SVG preference to the V-GPU default", () => {
    expect(
      readLightingRenderer({
        getItem: (key) => (key === LIGHTING_RENDERER_STORAGE_KEY ? "svg" : null),
      }),
    ).toBe("vgpu");
  });

  it.each(["legacy", "vgpu"] as const)("restores and persists the %s renderer", (renderer) => {
    const setItem = vi.fn();

    expect(
      readLightingRenderer({
        getItem: (key) => (key === LIGHTING_RENDERER_STORAGE_KEY ? renderer : null),
      }),
    ).toBe(renderer);
    writeLightingRenderer({ setItem }, renderer);
    expect(setItem).toHaveBeenCalledWith(LIGHTING_RENDERER_STORAGE_KEY, renderer);
  });

  it("defaults player pulse and rejects malformed or out-of-range storage", () => {
    expect(readPlayerPulse({ getItem: () => null })).toEqual(DEFAULT_PLAYER_PULSE);
    for (const value of [
      "not JSON",
      JSON.stringify({ enabled: true, speed: Number.NaN, strength: 0.05 }),
      JSON.stringify({ enabled: true, speed: 0.2, strength: 0.05 }),
      JSON.stringify({ enabled: true, speed: 1, strength: 0.51 }),
      JSON.stringify({ enabled: "true", speed: 1, strength: 0.05 }),
    ]) {
      expect(readPlayerPulse({ getItem: () => value })).toEqual(DEFAULT_PLAYER_PULSE);
    }
  });

  it("restores and persists bounded GPU player pulse settings", () => {
    const settings = { enabled: false, speed: 2.5, strength: 0.4 } as const;
    const setItem = vi.fn();

    expect(
      readPlayerPulse({
        getItem: (key) => (key === PLAYER_PULSE_STORAGE_KEY ? JSON.stringify(settings) : null),
      }),
    ).toEqual(settings);
    writePlayerPulse({ setItem }, settings);
    expect(setItem).toHaveBeenCalledWith(PLAYER_PULSE_STORAGE_KEY, JSON.stringify(settings));
  });
});

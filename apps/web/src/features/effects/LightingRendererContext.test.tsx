import { describe, expect, it } from "vitest";
import { createLightingRendererState, lightingRendererReducer } from "./LightingRendererContext.js";

describe("lighting renderer state", () => {
  it("starts SVG and player lighting enabled on fresh storage", () => {
    expect(createLightingRendererState({ getItem: () => null })).toEqual({
      requestedRenderer: "svg",
      effectiveRenderer: "svg",
      playerLightingEnabled: true,
      vgpuGeneration: 0,
      vgpuStatus: "idle",
    });
  });

  it("keeps SVG effective while V-GPU initializes, then switches atomically when ready", () => {
    const initializing = lightingRendererReducer(
      createLightingRendererState({ getItem: () => null }),
      { type: "select", renderer: "vgpu" },
    );

    expect(initializing).toMatchObject({
      requestedRenderer: "vgpu",
      effectiveRenderer: "svg",
      vgpuGeneration: 1,
      vgpuStatus: "initializing",
    });
    expect(
      lightingRendererReducer(initializing, { type: "vgpu-ready", generation: 1 }),
    ).toMatchObject({ effectiveRenderer: "vgpu", vgpuStatus: "ready" });
  });

  it("falls back without changing the requested V-GPU renderer", () => {
    const initializing = createLightingRendererState({ getItem: () => "vgpu" });

    expect(
      lightingRendererReducer(initializing, {
        type: "vgpu-failed",
        generation: initializing.vgpuGeneration,
      }),
    ).toMatchObject({
      requestedRenderer: "vgpu",
      effectiveRenderer: "svg",
      vgpuStatus: "fallback",
    });
  });

  it("ignores stale V-GPU completion after selecting another renderer", () => {
    const initializing = lightingRendererReducer(
      createLightingRendererState({ getItem: () => null }),
      { type: "select", renderer: "vgpu" },
    );
    const legacy = lightingRendererReducer(initializing, { type: "select", renderer: "legacy" });

    expect(
      lightingRendererReducer(legacy, {
        type: "vgpu-ready",
        generation: initializing.vgpuGeneration,
      }),
    ).toBe(legacy);
  });

  it("toggles player lighting without changing the table renderer", () => {
    const svg = createLightingRendererState({ getItem: () => null });
    expect(lightingRendererReducer(svg, { type: "set-player-lighting", enabled: false })).toEqual({
      ...svg,
      playerLightingEnabled: false,
    });
  });
});

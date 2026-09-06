import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  createLightingRendererState,
  lightingRendererReducer,
  useLightingRenderer,
} from "./LightingRendererContext.js";
import { DEFAULT_PLAYER_PULSE } from "./lighting-preferences.js";

const DefaultContextProbe = () => {
  const lighting = useLightingRenderer();
  return <output data-testid="lighting-context">{JSON.stringify(lighting)}</output>;
};

describe("lighting renderer state", () => {
  it("starts V-GPU requested with legacy CSS effective on fresh storage", () => {
    expect(createLightingRendererState({ getItem: () => null })).toEqual({
      requestedRenderer: "vgpu",
      effectiveRenderer: "legacy",
      playerPulse: DEFAULT_PLAYER_PULSE,
      vgpuGeneration: 1,
      vgpuStatus: "initializing",
    });
  });

  it("exposes the same V-GPU request and legacy CSS initialization fallback by default", () => {
    render(<DefaultContextProbe />);

    expect(JSON.parse(screen.getByTestId("lighting-context").textContent ?? "null")).toEqual({
      requestedRenderer: "vgpu",
      effectiveRenderer: "legacy",
      playerPulse: DEFAULT_PLAYER_PULSE,
      vgpuGeneration: 1,
      vgpuStatus: "initializing",
    });
  });

  it("keeps legacy CSS effective while V-GPU initializes, then switches atomically when ready", () => {
    const initializing = lightingRendererReducer(
      createLightingRendererState({ getItem: () => "legacy" }),
      { type: "select", renderer: "vgpu" },
    );

    expect(initializing).toMatchObject({
      requestedRenderer: "vgpu",
      effectiveRenderer: "legacy",
      vgpuGeneration: 1,
      vgpuStatus: "initializing",
    });
    expect(
      lightingRendererReducer(initializing, { type: "vgpu-ready", generation: 1 }),
    ).toMatchObject({ effectiveRenderer: "vgpu", vgpuStatus: "ready" });
  });

  it("uses legacy CSS on V-GPU failure without changing the requested renderer", () => {
    const initializing = createLightingRendererState({ getItem: () => "vgpu" });

    expect(
      lightingRendererReducer(initializing, {
        type: "vgpu-failed",
        generation: initializing.vgpuGeneration,
      }),
    ).toMatchObject({
      requestedRenderer: "vgpu",
      effectiveRenderer: "legacy",
      vgpuStatus: "fallback",
    });
  });

  it("keeps an explicit legacy renderer selected", () => {
    expect(createLightingRendererState({ getItem: () => "legacy" })).toMatchObject({
      requestedRenderer: "legacy",
      effectiveRenderer: "legacy",
      vgpuGeneration: 0,
      vgpuStatus: "idle",
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

  it("ignores the retired player-lighting preference while restoring renderer and pulse", () => {
    const playerPulse = { enabled: false, speed: 1.75, strength: 0.2 };
    const stored = new Map([
      ["mafia-dashboard.player-lighting.v1", "disabled"],
      ["mafia-dashboard.lighting-renderer.v1", "vgpu"],
      ["mafia-dashboard.player-pulse.v1", JSON.stringify(playerPulse)],
    ]);
    const getItem = vi.fn((key: string) => stored.get(key) ?? null);

    expect(createLightingRendererState({ getItem })).toEqual({
      requestedRenderer: "vgpu",
      effectiveRenderer: "legacy",
      playerPulse,
      vgpuGeneration: 1,
      vgpuStatus: "initializing",
    });
    expect(getItem).not.toHaveBeenCalledWith("mafia-dashboard.player-lighting.v1");
  });

  it("updates GPU player pulse settings without changing the selected renderer", () => {
    const lighting = createLightingRendererState({ getItem: () => null });
    const playerPulse = { enabled: false, speed: 1.75, strength: 0.2 } as const;

    expect(
      lightingRendererReducer(lighting, { type: "set-player-pulse", settings: playerPulse }),
    ).toEqual({ ...lighting, playerPulse });
  });
});

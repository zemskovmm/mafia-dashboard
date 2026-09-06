import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LightingRendererContext,
  createLightingRendererState,
  type LightingRendererContextValue,
} from "../LightingRendererContext.js";
import { VgpuPlayerLightingCanvas, VgpuTableLightingCanvas } from "./VgpuLightingCanvas.js";
import { VgpuLightingProvider } from "./VgpuLightingProvider.js";
import type { VgpuLightingRuntime } from "./VgpuLightingRuntime.js";

const lighting: LightingRendererContextValue = {
  requestedRenderer: "vgpu",
  effectiveRenderer: "legacy",
  playerPulse: { enabled: true, speed: 1, strength: 0.05 },
  vgpuGeneration: 1,
  vgpuStatus: "initializing",
};

const setupRuntime = () => {
  const disposers: Array<ReturnType<typeof vi.fn>> = [];
  const register = vi.fn(() => {
    const dispose = vi.fn();
    disposers.push(dispose);
    return { ready: Promise.resolve(), dispose };
  });
  const runtime: VgpuLightingRuntime = {
    ready: Promise.resolve(),
    register,
    setReducedMotion: vi.fn(),
    setPlayerPulse: vi.fn(),
    dispose: vi.fn(),
  };
  return { runtime, register, disposers };
};

const Harness = ({
  runtime,
  children,
}: Readonly<{ runtime: VgpuLightingRuntime; children: React.ReactNode }>) => (
  <LightingRendererContext.Provider value={lighting}>
    <VgpuLightingProvider
      enabled
      generation={1}
      createRuntime={() => Promise.resolve(runtime)}
      onReady={vi.fn()}
      onFailure={vi.fn()}
    >
      {children}
    </VgpuLightingProvider>
  </LightingRendererContext.Provider>
);

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("V-GPU lighting canvases", () => {
  it("registers the selected player palette and marks the compiled canvas ready", async () => {
    const env = setupRuntime();
    const { container } = render(
      <Harness runtime={env.runtime}>
        <VgpuPlayerLightingCanvas kind="speaker" />
      </Harness>,
    );

    const canvas = container.querySelector(".vgpu-player-lighting");
    await waitFor(() => expect(canvas).toHaveAttribute("data-vgpu-ready", "true"));
    expect(env.register).toHaveBeenCalledWith(canvas, {
      kind: "player",
      primary: [1, 0.74, 0.3],
      secondary: [1, 0.9, 0.64],
      fire: false,
    });
  });

  it.each([
    ["mafia", [1, 0.19, 0.15]],
    ["sheriff", [0.24, 0.67, 1]],
    ["attention", [1, 0.82, 0.2]],
  ] as const)("maps %s to its single-colour V-GPU palette", async (kind, colour) => {
    const env = setupRuntime();
    const { container } = render(
      <Harness runtime={env.runtime}>
        <VgpuPlayerLightingCanvas kind={kind} />
      </Harness>,
    );

    const canvas = container.querySelector(".vgpu-player-lighting");
    await waitFor(() => expect(canvas).toHaveAttribute("data-vgpu-ready", "true"));
    expect(env.register).toHaveBeenCalledWith(canvas, {
      kind: "player",
      primary: colour,
      secondary: colour,
      fire: kind === "mafia",
    });
  });

  it("renders player lighting despite a retired disabled preference", async () => {
    const env = setupRuntime();
    const restored = createLightingRendererState({
      getItem: (key) => (key === "mafia-dashboard.player-lighting.v1" ? "disabled" : null),
    });
    const { container } = render(
      <LightingRendererContext.Provider value={restored}>
        <VgpuLightingProvider
          enabled
          generation={restored.vgpuGeneration}
          createRuntime={() => Promise.resolve(env.runtime)}
          onReady={vi.fn()}
          onFailure={vi.fn()}
        >
          <VgpuPlayerLightingCanvas kind="mafia" />
        </VgpuLightingProvider>
      </LightingRendererContext.Provider>,
    );

    await waitFor(() =>
      expect(container.querySelector(".vgpu-player-lighting")).toHaveAttribute(
        "data-vgpu-ready",
        "true",
      ),
    );
    expect(env.register).toHaveBeenCalledWith(
      container.querySelector("canvas"),
      expect.objectContaining({ kind: "player", fire: true }),
    );
  });

  it("leaves player lighting to CSS when the legacy renderer is selected", () => {
    const { container } = render(
      <LightingRendererContext.Provider value={{ ...lighting, requestedRenderer: "legacy" }}>
        <VgpuPlayerLightingCanvas kind="mafia" />
      </LightingRendererContext.Provider>,
    );
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("re-registers table lighting when the existing day/night class changes", async () => {
    const env = setupRuntime();
    const { container, rerender } = render(
      <Harness runtime={env.runtime}>
        <main className="game-shell is-table-cycle-night">
          <VgpuTableLightingCanvas />
        </main>
      </Harness>,
    );
    const canvas = container.querySelector(".vgpu-table-lighting");
    await waitFor(() =>
      expect(env.register).toHaveBeenLastCalledWith(canvas, { kind: "table", cycle: "night" }),
    );

    rerender(
      <Harness runtime={env.runtime}>
        <main className="game-shell is-table-cycle-day">
          <VgpuTableLightingCanvas />
        </main>
      </Harness>,
    );
    await waitFor(() =>
      expect(env.register).toHaveBeenLastCalledWith(canvas, { kind: "table", cycle: "day" }),
    );
    expect(env.disposers[0]).toHaveBeenCalledOnce();
  });

  it("reads the current night class when V-GPU is selected after mount", async () => {
    const env = setupRuntime();
    const createRuntime = () => Promise.resolve(env.runtime);
    const tree = (requestedRenderer: "legacy" | "vgpu") => (
      <LightingRendererContext.Provider value={{ ...lighting, requestedRenderer }}>
        <VgpuLightingProvider
          enabled={requestedRenderer === "vgpu"}
          generation={1}
          createRuntime={createRuntime}
          onReady={vi.fn()}
          onFailure={vi.fn()}
        >
          <main className="game-shell is-table-cycle-night">
            <VgpuTableLightingCanvas />
          </main>
        </VgpuLightingProvider>
      </LightingRendererContext.Provider>
    );
    const { container, rerender } = render(tree("legacy"));

    rerender(tree("vgpu"));

    const canvas = container.querySelector(".vgpu-table-lighting");
    await waitFor(() =>
      expect(env.register).toHaveBeenLastCalledWith(canvas, { kind: "table", cycle: "night" }),
    );
  });
});

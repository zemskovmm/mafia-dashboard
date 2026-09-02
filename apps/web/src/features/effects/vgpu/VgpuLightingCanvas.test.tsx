import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LightingRendererContext,
  type LightingRendererContextValue,
} from "../LightingRendererContext.js";
import { VgpuPlayerLightingCanvas, VgpuTableLightingCanvas } from "./VgpuLightingCanvas.js";
import { VgpuLightingProvider } from "./VgpuLightingProvider.js";
import type { VgpuLightingRuntime } from "./VgpuLightingRuntime.js";

const lighting: LightingRendererContextValue = {
  requestedRenderer: "vgpu",
  effectiveRenderer: "svg",
  playerLightingEnabled: true,
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
      primary: [1, 0.89, 0.29],
      secondary: [0.31, 0.72, 1],
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
    });
  });

  it("does not mount a player canvas when player lighting is disabled", () => {
    const env = setupRuntime();
    const { container } = render(
      <LightingRendererContext.Provider value={{ ...lighting, playerLightingEnabled: false }}>
        <VgpuPlayerLightingCanvas kind="mafia" />
      </LightingRendererContext.Provider>,
    );

    expect(container.querySelector("canvas")).toBeNull();
    expect(env.register).not.toHaveBeenCalled();
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
    const tree = (requestedRenderer: "svg" | "vgpu") => (
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
    const { container, rerender } = render(tree("svg"));

    rerender(tree("vgpu"));

    const canvas = container.querySelector(".vgpu-table-lighting");
    await waitFor(() =>
      expect(env.register).toHaveBeenLastCalledWith(canvas, { kind: "table", cycle: "night" }),
    );
  });
});

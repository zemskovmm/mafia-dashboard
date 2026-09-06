import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PLAYER_PULSE } from "../lighting-preferences.js";
import { VgpuLightingProvider, useVgpuLightingRuntime } from "./VgpuLightingProvider.js";
import type { VgpuLightingRuntime } from "./VgpuLightingRuntime.js";

const runtime = (): VgpuLightingRuntime => ({
  ready: Promise.resolve(),
  register: vi.fn(),
  setPlayerPulse: vi.fn(),
  setReducedMotion: vi.fn(),
  dispose: vi.fn(),
});

const Probe = () => (
  <output data-testid="runtime">{useVgpuLightingRuntime() === null ? "none" : "ready"}</output>
);

describe("VgpuLightingProvider", () => {
  it("ignores a late runtime after the selected generation changes", async () => {
    let resolve!: (value: VgpuLightingRuntime) => void;
    const pending = new Promise<VgpuLightingRuntime>((done) => {
      resolve = done;
    });
    const createRuntime = vi.fn(() => pending);
    const onReady = vi.fn();
    const onFailure = vi.fn();
    const { rerender } = render(
      <VgpuLightingProvider
        enabled
        generation={1}
        createRuntime={createRuntime}
        onReady={onReady}
        onFailure={onFailure}
      >
        <Probe />
      </VgpuLightingProvider>,
    );

    rerender(
      <VgpuLightingProvider
        enabled={false}
        generation={2}
        createRuntime={createRuntime}
        onReady={onReady}
        onFailure={onFailure}
      >
        <Probe />
      </VgpuLightingProvider>,
    );
    const staleRuntime = runtime();
    await act(async () => resolve(staleRuntime));

    expect(staleRuntime.dispose).toHaveBeenCalledOnce();
    expect(onReady).not.toHaveBeenCalled();
    expect(screen.getByTestId("runtime")).toHaveTextContent("none");
  });

  it("reports ready, tracks reduced motion, and disposes on disable", async () => {
    const activeRuntime = runtime();
    const createRuntime = vi.fn().mockResolvedValue(activeRuntime);
    const onReady = vi.fn();
    const onFailure = vi.fn();
    const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: (_name: string, listener: (event: MediaQueryListEvent) => void) =>
          mediaListeners.add(listener),
        removeEventListener: (_name: string, listener: (event: MediaQueryListEvent) => void) =>
          mediaListeners.delete(listener),
      })),
    );
    const { rerender } = render(
      <VgpuLightingProvider
        enabled
        generation={3}
        createRuntime={createRuntime}
        onReady={onReady}
        onFailure={onFailure}
      >
        <Probe />
      </VgpuLightingProvider>,
    );

    await waitFor(() => expect(onReady).toHaveBeenCalledWith(3));
    expect(screen.getByTestId("runtime")).toHaveTextContent("ready");
    expect(activeRuntime.setReducedMotion).toHaveBeenCalledWith(false);

    act(() => {
      for (const listener of mediaListeners) listener({ matches: true } as MediaQueryListEvent);
    });
    expect(activeRuntime.setReducedMotion).toHaveBeenCalledWith(true);

    rerender(
      <VgpuLightingProvider
        enabled={false}
        generation={4}
        createRuntime={createRuntime}
        onReady={onReady}
        onFailure={onFailure}
      >
        <Probe />
      </VgpuLightingProvider>,
    );
    expect(activeRuntime.dispose).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("applies the latest player pulse after async initialization without recreating runtime", async () => {
    let resolve!: (value: VgpuLightingRuntime) => void;
    const pending = new Promise<VgpuLightingRuntime>((done) => {
      resolve = done;
    });
    const activeRuntime = runtime();
    const createRuntime = vi.fn(() => pending);
    const onReady = vi.fn();
    const onFailure = vi.fn();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const { rerender } = render(
      <VgpuLightingProvider
        enabled
        generation={7}
        createRuntime={createRuntime}
        onReady={onReady}
        onFailure={onFailure}
      >
        <Probe />
      </VgpuLightingProvider>,
    );

    const latestPulse = { enabled: false, speed: 2, strength: 0.3 } as const;
    rerender(
      <VgpuLightingProvider
        enabled
        generation={7}
        playerPulse={latestPulse}
        createRuntime={createRuntime}
        onReady={onReady}
        onFailure={onFailure}
      >
        <Probe />
      </VgpuLightingProvider>,
    );
    await act(async () => resolve(activeRuntime));

    await waitFor(() => expect(activeRuntime.setPlayerPulse).toHaveBeenCalledWith(latestPulse));
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(activeRuntime.dispose).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("uses the default player pulse for callers without the optional setting", async () => {
    const activeRuntime = runtime();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    render(
      <VgpuLightingProvider
        enabled
        generation={8}
        createRuntime={() => Promise.resolve(activeRuntime)}
        onReady={vi.fn()}
        onFailure={vi.fn()}
      >
        <Probe />
      </VgpuLightingProvider>,
    );

    await waitFor(() =>
      expect(activeRuntime.setPlayerPulse).toHaveBeenCalledWith(DEFAULT_PLAYER_PULSE),
    );
    vi.unstubAllGlobals();
  });

  it("publishes readiness only after the first runtime surface is ready", async () => {
    let markReady!: () => void;
    const firstSurface = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const activeRuntime = { ...runtime(), ready: firstSurface } as VgpuLightingRuntime;
    const onReady = vi.fn();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    render(
      <VgpuLightingProvider
        enabled
        generation={4}
        createRuntime={() => Promise.resolve(activeRuntime)}
        onReady={onReady}
        onFailure={vi.fn()}
      >
        <Probe />
      </VgpuLightingProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("runtime")).toHaveTextContent("ready"));
    expect(onReady).not.toHaveBeenCalled();
    await act(async () => markReady());
    expect(onReady).toHaveBeenCalledWith(4);
    vi.unstubAllGlobals();
  });

  it("reports initialization failure for the current generation", async () => {
    const onFailure = vi.fn();
    render(
      <VgpuLightingProvider
        enabled
        generation={5}
        createRuntime={() => Promise.reject(new Error("no WebGPU"))}
        onReady={vi.fn()}
        onFailure={onFailure}
      >
        <Probe />
      </VgpuLightingProvider>,
    );

    await waitFor(() => expect(onFailure).toHaveBeenCalledWith(5));
    expect(screen.getByTestId("runtime")).toHaveTextContent("none");
  });

  it("falls back when runtime initialization does not settle promptly", async () => {
    vi.useFakeTimers();
    const onFailure = vi.fn();
    render(
      <VgpuLightingProvider
        enabled
        generation={6}
        createRuntime={() => new Promise<VgpuLightingRuntime>(() => undefined)}
        onReady={vi.fn()}
        onFailure={onFailure}
      >
        <Probe />
      </VgpuLightingProvider>,
    );

    await act(() => vi.advanceTimersByTimeAsync(8_000));
    expect(onFailure).toHaveBeenCalledWith(6);
    expect(screen.getByTestId("runtime")).toHaveTextContent("none");
    vi.useRealTimers();
  });
});

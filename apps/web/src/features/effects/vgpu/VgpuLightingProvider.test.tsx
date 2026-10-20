import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PLAYER_PULSE } from "../lighting-preferences.js";
import { VgpuLightingProvider, useVgpuLightingRuntime } from "./VgpuLightingProvider.js";
import type { VgpuLightingRuntime } from "./VgpuLightingRuntime.js";
import { FancyFeaturesContext } from "../FancyFeaturesContext.js";

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
  it("rejects stale initialization and readiness across rapid Fancy toggles", async () => {
    vi.useFakeTimers();
    let resolveFirst!: (value: VgpuLightingRuntime) => void;
    let resolveSecond!: (value: VgpuLightingRuntime) => void;
    let markSecondReady!: () => void;
    const pendingFirst = new Promise<VgpuLightingRuntime>((resolve) => {
      resolveFirst = resolve;
    });
    const pendingSecond = new Promise<VgpuLightingRuntime>((resolve) => {
      resolveSecond = resolve;
    });
    const secondReady = new Promise<void>((resolve) => {
      markSecondReady = resolve;
    });
    const first = runtime();
    const second = { ...runtime(), ready: secondReady };
    const third = runtime();
    const createRuntime = vi
      .fn()
      .mockReturnValueOnce(pendingFirst)
      .mockReturnValueOnce(pendingSecond)
      .mockResolvedValueOnce(third);
    const onReady = vi.fn();
    const onFailure = vi.fn();
    const fixture = (fancy: boolean) => (
      <FancyFeaturesContext.Provider value={fancy}>
        <VgpuLightingProvider
          enabled
          generation={12}
          createRuntime={createRuntime}
          onReady={onReady}
          onFailure={onFailure}
        >
          <Probe />
        </VgpuLightingProvider>
      </FancyFeaturesContext.Provider>
    );
    try {
      const { rerender, unmount } = render(fixture(true));
      rerender(fixture(false));
      expect(vi.getTimerCount()).toBe(0);
      rerender(fixture(true));
      await act(async () => resolveSecond(second));
      expect(screen.getByTestId("runtime")).toHaveTextContent("ready");
      await act(async () => resolveFirst(first));
      expect(first.dispose).toHaveBeenCalledOnce();
      expect(second.dispose).not.toHaveBeenCalled();
      expect(onReady).not.toHaveBeenCalled();
      rerender(fixture(false));
      expect(second.dispose).toHaveBeenCalledOnce();
      await act(async () => markSecondReady());
      expect(onReady).not.toHaveBeenCalled();
      expect(screen.getByTestId("runtime")).toHaveTextContent("none");
      await act(() => vi.advanceTimersByTimeAsync(9_000));
      expect(onFailure).not.toHaveBeenCalled();
      await act(async () => rerender(fixture(true)));
      expect(onReady).toHaveBeenCalledExactlyOnceWith(12);
      expect(createRuntime).toHaveBeenCalledTimes(3);
      unmount();
      expect(third.dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does no runtime work with Fancy off and disposes on opt-out without remounting children", async () => {
    vi.useFakeTimers();
    const first = runtime();
    const second = runtime();
    const createRuntime = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const onReady = vi.fn();
    const onFailure = vi.fn();
    const preference = Object.assign(new EventTarget(), { matches: false });
    const remove = vi.spyOn(preference, "removeEventListener");
    const matchMedia = vi.fn(() => preference);
    vi.stubGlobal("matchMedia", matchMedia);
    const mounted = vi.fn();
    const Child = () => {
      useEffect(() => {
        mounted();
      }, []);
      return (
        <>
          <Probe />
          <input aria-label="Draft" defaultValue="preserved" />
        </>
      );
    };
    const fixture = (fancy: boolean, playerPulse = DEFAULT_PLAYER_PULSE) => (
      <FancyFeaturesContext.Provider value={fancy}>
        <VgpuLightingProvider
          enabled
          generation={11}
          createRuntime={createRuntime}
          onReady={onReady}
          onFailure={onFailure}
          playerPulse={playerPulse}
        >
          <Child />
        </VgpuLightingProvider>
      </FancyFeaturesContext.Provider>
    );
    try {
      const { rerender, unmount } = render(fixture(false));
      const draft = screen.getByRole("textbox", { name: "Draft" });
      expect(createRuntime).not.toHaveBeenCalled();
      expect(matchMedia).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(screen.getByTestId("runtime")).toHaveTextContent("none");

      await act(async () => rerender(fixture(true)));
      expect(createRuntime).toHaveBeenCalledOnce();
      expect(screen.getByTestId("runtime")).toHaveTextContent("ready");
      expect(onReady).toHaveBeenCalledOnce();
      const updates = vi.mocked(first.setPlayerPulse).mock.calls.length;
      const retainedPulse = { ...DEFAULT_PLAYER_PULSE, enabled: false, strength: 0.3 };
      rerender(fixture(false, retainedPulse));
      expect(first.dispose).toHaveBeenCalledOnce();
      expect(first.setPlayerPulse).toHaveBeenCalledTimes(updates);
      expect(remove).toHaveBeenCalledWith("change", expect.any(Function));
      expect(screen.getByTestId("runtime")).toHaveTextContent("none");
      expect(vi.getTimerCount()).toBe(0);
      await act(() => vi.advanceTimersByTimeAsync(9_000));
      expect(onFailure).not.toHaveBeenCalled();

      await act(async () => rerender(fixture(true, retainedPulse)));
      expect(createRuntime).toHaveBeenCalledTimes(2);
      expect(second.setPlayerPulse).toHaveBeenCalledWith(retainedPulse);
      expect(mounted).toHaveBeenCalledOnce();
      expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
      expect(draft).toHaveValue("preserved");
      unmount();
      expect(second.dispose).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

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

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FancyFeaturesContext } from "../effects/FancyFeaturesContext.js";
import { DEFAULT_GLASS_SETTINGS } from "./glass-preferences.js";
import { createGlassRenderer, type GlassRenderer } from "./glass-renderer.js";
import { GlassScene } from "./GlassScene.js";
import { LiquidCardGlass } from "./LiquidCardGlass.js";
import { SharedGlassContext } from "./SharedGlassContext.js";
import { loadVisualImage } from "../effects/image-assets.js";
import type { BackgroundId } from "./background-preferences.js";

vi.mock("./glass-renderer.js", () => ({ createGlassRenderer: vi.fn() }));

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }
}
class TestMutationObserver {
  static instances: TestMutationObserver[] = [];
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(readonly callback: MutationCallback) {
    TestMutationObserver.instances.push(this);
  }
}
const frames = new Map<number, FrameRequestCallback>();
const renderers: GlassRenderer[] = [];
const media = new Map<string, MediaQueryList>();
const lose = () => vi.mocked(createGlassRenderer).mock.lastCall?.[2]?.();
let serial = 0;
const paint = () => {
  const batch = [...frames.values()];
  frames.clear();
  act(() => {
    for (const callback of batch) callback(performance.now());
  });
};

beforeEach(() => {
  frames.clear();
  renderers.length = 0;
  media.clear();
  TestResizeObserver.instances = [];
  TestMutationObserver.instances = [];
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("MutationObserver", TestMutationObserver);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++serial, callback);
      return serial;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => frames.delete(id)),
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      const result = media.get(query) ?? Object.assign(new EventTarget(), { matches: false });
      media.set(query, result as MediaQueryList);
      return result;
    }),
  );
  vi.mocked(createGlassRenderer).mockImplementation(async () => {
    const renderer = { draw: vi.fn(), dispose: vi.fn() };
    renderers.push(renderer);
    return renderer;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10,
    y: 10,
    width: 120,
    height: 100,
    top: 10,
    left: 10,
    right: 130,
    bottom: 110,
    toJSON: () => ({}),
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(120);
});
afterEach(async () => {
  cleanup();
  await act(async () => undefined);
  vi.mocked(createGlassRenderer).mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("GlassScene Fancy policy", () => {
  it.each(["departure", "role"])(
    "blends a planar %s back into shared optics without a one-frame material switch",
    async (kind) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      render(
        <div className="app-shell">
          <GlassScene settings={DEFAULT_GLASS_SETTINGS} onStatus={vi.fn()} />
          <button
            data-player-glass="table"
            data-player-exit={kind === "departure" ? "1" : undefined}
            className={kind === "role" ? "role-draw-card is-role-flipping" : undefined}
          >
            Ada
          </button>
          <button data-player-glass="table">Boris</button>
        </div>,
      );
      await act(async () => undefined);
      const card = screen.getByRole("button", { name: "Ada" });
      const scene = () => vi.mocked(renderers[0]!.draw).mock.lastCall![0];
      paint();
      card.style.rotate = "y 90deg";
      paint();
      expect(scene().surfaces).toHaveLength(1);
      expect(card).not.toHaveAttribute("data-glass-painted");
      const handoffs: Array<readonly [number, string]> = [];
      vi.mocked(renderers[0]!.draw).mockImplementation((value) => {
        handoffs.push([
          value.surfaces[0]!.opacity,
          card.style.getPropertyValue("--glass-local-weight"),
        ]);
      });
      now = 50;
      card.style.rotate = kind === "role" ? "none" : "y 180deg";
      card.classList.remove("is-role-flipping");
      paint();
      expect(card).toHaveAttribute("data-glass-painted", "true");
      expect(card).toHaveAttribute("data-glass-blending", "true");
      expect(scene().surfaces[0]?.opacity).toBe(0);
      expect(card.style.getPropertyValue("--glass-local-weight")).toBe("1");
      now = 110;
      paint();
      expect(scene().surfaces[0]?.opacity).toBeCloseTo(0.5);
      expect(card.style.getPropertyValue("--glass-local-weight")).toBe("0.5");
      expect(scene().surfaces[1]?.opacity).toBe(1);
      now = 170;
      paint();
      expect(scene().surfaces[0]?.opacity).toBe(1);
      expect(card).not.toHaveAttribute("data-glass-blending");
      expect(card.style.getPropertyValue("--glass-local-weight")).toBe("");
      expect(handoffs).toEqual([
        [0, ""],
        [0.5, "1"],
        [1, "0.5"],
      ]);
      now = 1100;
      paint();
      expect(frames.size).toBe(0);
    },
  );

  it("hands off only a nonplanar departure after drawing and reacquires planar tear, fade and settlement", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    render(
      <SharedGlassContext.Provider value={true}>
        <div className="app-shell">
          <GlassScene settings={DEFAULT_GLASS_SETTINGS} onStatus={vi.fn()} />
          <button data-player-glass="table" data-player-exit="1">
            <LiquidCardGlass />
            Ada
          </button>
          <button data-player-glass="table">Boris</button>
        </div>
      </SharedGlassContext.Provider>,
    );
    await act(async () => undefined);
    const card = screen.getByRole("button", { name: "Ada" });
    const neighbor = screen.getByRole("button", { name: "Boris" });
    const fallback = card.firstElementChild;
    expect(fallback).toHaveClass("liquid-card-glass");
    expect(fallback).toHaveAttribute("data-liquid-card-lens", "fallback");
    const handoffs: Array<readonly [number, boolean, boolean]> = [];
    vi.mocked(renderers[0]!.draw).mockImplementation((scene) => {
      handoffs.push([
        scene.surfaces.length,
        card.getAttribute("data-glass-painted") === "true",
        neighbor.getAttribute("data-glass-painted") === "true",
      ]);
    });
    for (const [degrees, included] of [
      [0, true],
      [45, false],
      [90, false],
      [135, false],
      [180, true],
    ] as const) {
      card.style.rotate = `y ${degrees}deg`;
      act(() => {
        card.dispatchEvent(
          new CustomEvent("player-exit-motion", { bubbles: true, detail: { duration: 100 } }),
        );
      });
      paint();
      expect(vi.mocked(renderers[0]!.draw).mock.lastCall![0].surfaces).toHaveLength(
        included ? 2 : 1,
      );
      expect(card.getAttribute("data-glass-painted") === "true").toBe(included);
      expect(neighbor).toHaveAttribute("data-glass-painted", "true");
      expect(card.firstElementChild).toBe(fallback);
    }
    // Old shared paint remains suppressed until its removal draw completes;
    // local paint remains exposed until the planar reacquisition draw completes.
    expect(handoffs).toEqual([
      [2, false, false],
      [1, true, true],
      [2, false, true],
    ]);
    now = 120;
    card.style.setProperty("--player-exit-tear", "0.5");
    paint();
    expect(vi.mocked(renderers[0]!.draw).mock.lastCall![0].surfaces[0]).toMatchObject({
      tear: { progress: 0.5, gap: 6 },
      opacity: 1,
    });
    expect(card).toHaveAttribute("data-glass-painted", "true");
    card.style.setProperty("--player-exit-tear", "1");
    card.style.setProperty("--player-exit-fade", "0.45");
    paint();
    expect(vi.mocked(renderers[0]!.draw).mock.lastCall![0].surfaces[0]?.opacity).toBeCloseTo(0.45);
    expect(card).toHaveAttribute("data-glass-painted", "true");
    card.removeAttribute("data-player-exit");
    card.style.rotate = "none";
    paint();
    expect(vi.mocked(renderers[0]!.draw).mock.lastCall![0].surfaces[0]).toMatchObject({
      tear: { progress: 1, gap: 6 },
      opacity: 0.45,
    });
    expect(card).toHaveAttribute("data-glass-painted", "true");
    expect(card.firstElementChild).toBe(fallback);
    expect(card).toHaveAccessibleName("Ada");
    expect(createGlassRenderer).toHaveBeenCalledOnce();
    expect(renderers[0]!.dispose).not.toHaveBeenCalled();
  });

  it.each(["reduced", "settled", "context-lost"] as const)(
    "releases a partial optical handoff on %s without fading public content",
    async (interruption) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      render(
        <div className="app-shell">
          <GlassScene settings={DEFAULT_GLASS_SETTINGS} onStatus={vi.fn()} />
          <button data-player-glass="table" data-player-exit="1">
            Ada
          </button>
        </div>,
      );
      await act(async () => undefined);
      const card = screen.getByRole("button", { name: "Ada" });
      card.style.setProperty("--player-exit-fade", "0.45");
      card.style.rotate = "y 90deg";
      paint();
      card.style.rotate = "y 180deg";
      paint();
      now = 60;
      paint();
      expect(vi.mocked(renderers[0]!.draw).mock.lastCall![0].surfaces[0]?.opacity).toBeCloseTo(
        0.45 * 0.5,
      );
      expect(card.style.getPropertyValue("--glass-local-weight")).toBe("0.5");
      expect(card.style.opacity).toBe("");
      if (interruption === "context-lost") {
        act(lose);
        expect(card).not.toHaveAttribute("data-glass-painted");
        expect(frames.size).toBe(0);
      } else {
        if (interruption === "reduced")
          Object.assign(media.get("(prefers-reduced-motion: reduce)")!, { matches: true });
        else card.removeAttribute("data-player-exit");
        paint();
        expect(vi.mocked(renderers[0]!.draw).mock.lastCall![0].surfaces[0]?.opacity).toBe(0.45);
        expect(card).toHaveAttribute("data-glass-painted", "true");
      }
      expect(card).not.toHaveAttribute("data-glass-blending");
      expect(card.style.getPropertyValue("--glass-local-weight")).toBe("");
      expect(card).toHaveAccessibleName("Ada");
    },
  );

  it("collects one torn material from resolved host properties without fading public content", async () => {
    render(
      <div className="app-shell">
        <GlassScene settings={DEFAULT_GLASS_SETTINGS} onStatus={vi.fn()} />
        <button data-player-glass="table" style={{ opacity: 0.8 }}>
          Ada
        </button>
        <button data-player-glass="table">Boris</button>
      </div>,
    );
    await act(async () => undefined);
    const card = screen.getByRole("button", { name: "Ada" });
    card.style.setProperty("--player-exit-tear", "0.5");
    card.style.setProperty("--player-exit-gap", "99");
    card.style.setProperty("--player-exit-fade", "0.45");
    paint();
    const scene = vi.mocked(renderers[0]!.draw).mock.lastCall![0];
    expect(scene.surfaces).toHaveLength(2);
    expect(scene.surfaces[0]).toMatchObject({
      tear: { progress: 0.5, gap: 12 },
    });
    expect(scene.surfaces[0]?.opacity).toBeCloseTo(0.36);
    expect(scene.surfaces[1]).not.toHaveProperty("tear");
    expect(card.style.opacity).toBe("0.8");
    expect(card).toHaveAccessibleName("Ada");
    card.style.setProperty("--player-exit-tear", "0");
    card.style.setProperty("--player-exit-fade", "NaN");
    paint();
    expect(vi.mocked(renderers[0]!.draw).mock.lastCall![0].surfaces[0]).not.toHaveProperty("tear");
    expect(vi.mocked(renderers[0]!.draw).mock.lastCall![0].surfaces[0]?.opacity).toBe(0.8);
  });

  it("wakes for finite player motion beyond the ordinary settle window and paints the endpoint", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { unmount } = render(
      <div className="app-shell">
        <GlassScene settings={DEFAULT_GLASS_SETTINGS} onStatus={vi.fn()} />
        <button data-player-glass="table" data-player-exit="1">
          Ada
        </button>
      </div>,
    );
    paint();
    now = 1000;
    paint();
    expect(frames.size).toBe(0);
    await act(async () => undefined);
    const card = screen.getByRole("button", { name: "Ada" });
    card.style.rotate = "y 45deg";
    act(() => {
      card.dispatchEvent(
        new CustomEvent("player-exit-motion", { bubbles: true, detail: { duration: 2200 } }),
      );
    });
    expect(frames.size).toBe(1);
    now = 2500;
    paint();
    expect(frames.size).toBe(1);
    expect(vi.mocked(renderers[0]!.draw).mock.lastCall![0].surfaces).toHaveLength(0);
    expect(card).not.toHaveAttribute("data-glass-painted");
    now = 2800;
    card.style.rotate = "y 180deg";
    card.style.setProperty("--player-exit-tear", "0.5");
    paint();
    expect(frames.size).toBe(1);
    expect(card).toHaveAttribute("data-glass-painted", "true");
    expect(vi.mocked(renderers[0]!.draw).mock.lastCall![0].surfaces[0]).toMatchObject({
      tear: { progress: 0.5, gap: 6 },
    });
    now = 3201;
    card.style.setProperty("--player-exit-tear", "1");
    card.style.setProperty("--player-exit-fade", "0.45");
    paint();
    expect(frames.size).toBe(0);
    expect(vi.mocked(renderers[0]!.draw).mock.lastCall![0].surfaces[0]?.opacity).toBe(0.45);
    const draws = vi.mocked(renderers[0]!.draw).mock.calls.length;
    paint();
    expect(renderers[0]!.draw).toHaveBeenCalledTimes(draws);
    unmount();
    act(() => {
      card.dispatchEvent(
        new CustomEvent("player-exit-motion", { bubbles: true, detail: { duration: 2200 } }),
      );
    });
    expect(frames.size).toBe(0);
  });

  it("clears painted ownership before context disposal and recovers on a fresh canvas across a departure turn", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const onStatus = vi.fn();
    const fixture = (enabled: boolean) => (
      <SharedGlassContext.Provider value={true}>
        <div className="app-shell">
          <GlassScene settings={{ ...DEFAULT_GLASS_SETTINGS, enabled }} onStatus={onStatus} />
          <button data-player-glass="table" data-player-exit="1">
            <LiquidCardGlass />
            Ada
          </button>
        </div>
      </SharedGlassContext.Provider>
    );
    const { container, rerender, unmount } = render(fixture(true));
    await act(async () => undefined);
    const canvas = container.querySelector("canvas")!;
    const card = screen.getByRole("button", { name: "Ada" });
    const fallback = card.firstElementChild;
    const disposals: Array<readonly [boolean, boolean, number]> = [];
    const disposed = (target: HTMLCanvasElement) => () => {
      disposals.push([
        target.style.visibility === "hidden",
        card.hasAttribute("data-glass-painted"),
        frames.size,
      ]);
    };
    vi.mocked(renderers[0]!.dispose).mockImplementation(disposed(canvas));
    paint();
    expect(card).toHaveAttribute("data-glass-painted", "true");
    const staleFrame = [...frames.values()][0]!;
    act(lose);
    expect(onStatus).toHaveBeenLastCalledWith("context-lost");
    expect(renderers[0]!.dispose).toHaveBeenCalledExactlyOnceWith();
    expect(disposals).toEqual([[true, false, 0]]);
    act(() => staleFrame(performance.now()));
    expect(renderers[0]!.draw).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);

    card.style.rotate = "y 90deg";
    rerender(fixture(false));
    await act(async () => rerender(fixture(true)));
    const restoredCanvas = container.querySelector("canvas")!;
    expect(restoredCanvas).not.toBe(canvas);
    expect(createGlassRenderer).toHaveBeenCalledTimes(2);
    vi.mocked(renderers[1]!.dispose).mockImplementation(disposed(restoredCanvas));
    paint();
    expect(onStatus).toHaveBeenLastCalledWith("ready");
    expect(vi.mocked(renderers[1]!.draw).mock.lastCall![0].surfaces).toHaveLength(0);
    expect(card).not.toHaveAttribute("data-glass-painted");
    expect(card.firstElementChild).toBe(fallback);

    const acquired: boolean[] = [];
    vi.mocked(renderers[1]!.draw).mockImplementation(() => {
      acquired.push(card.hasAttribute("data-glass-painted"));
    });
    card.style.rotate = "y 180deg";
    card.style.setProperty("--player-exit-tear", "1");
    card.style.setProperty("--player-exit-fade", "0.45");
    paint();
    expect(acquired).toEqual([false]);
    expect(card).toHaveAttribute("data-glass-painted", "true");
    expect(card).toHaveAttribute("data-glass-blending", "true");
    now = 120;
    paint();
    expect(vi.mocked(renderers[1]!.draw).mock.lastCall![0].surfaces[0]).toMatchObject({
      tear: { progress: 1, gap: 6 },
      opacity: 0.45,
    });
    await act(async () => unmount());
    expect(renderers[0]!.dispose).toHaveBeenCalledExactlyOnceWith();
    expect(renderers[1]!.dispose).toHaveBeenCalledExactlyOnceWith();
    expect(disposals).toEqual([
      [true, false, 0],
      [true, false, 0],
    ]);
    expect(frames.size).toBe(0);
    expect(card).not.toHaveAttribute("data-glass-painted");
  });

  it("keeps reduced-transparency constraints and does not inherit an old canvas context loss after opt-out", async () => {
    const onStatus = vi.fn();
    const fixture = (fancy: boolean) => (
      <FancyFeaturesContext.Provider value={fancy}>
        <div className="app-shell">
          <GlassScene settings={DEFAULT_GLASS_SETTINGS} onStatus={onStatus} />
        </div>
      </FancyFeaturesContext.Provider>
    );
    const { container, rerender, unmount } = render(fixture(true));
    await act(async () => undefined);
    const preference = media.get("(prefers-reduced-transparency: reduce)")!;
    act(() => {
      Object.assign(preference, { matches: true });
      preference.dispatchEvent(new Event("change"));
    });
    expect(renderers[0]?.dispose).toHaveBeenCalledOnce();
    expect(onStatus).toHaveBeenLastCalledWith("reduced-transparency");
    await act(async () => rerender(fixture(false)));
    await act(async () => rerender(fixture(true)));
    expect(createGlassRenderer).toHaveBeenCalledOnce();
    await act(async () => {
      Object.assign(preference, { matches: false });
      preference.dispatchEvent(new Event("change"));
    });
    expect(createGlassRenderer).toHaveBeenCalledTimes(2);
    const oldCanvas = container.querySelector("canvas")!;
    act(lose);
    expect(renderers[1]?.dispose).toHaveBeenCalledOnce();
    expect(onStatus).toHaveBeenLastCalledWith("context-lost");
    await act(async () => rerender(fixture(false)));
    await act(async () => rerender(fixture(true)));
    expect(container.querySelector("canvas")).not.toBe(oldCanvas);
    expect(createGlassRenderer).toHaveBeenCalledTimes(3);
    paint();
    expect(onStatus).toHaveBeenLastCalledWith("ready");
    await act(async () => unmount());
  });

  it.each(["foreground", "hidden", "backgrounded"] as const)(
    "falls back after device loss (%s), bounds retries and repaints only from the current canvas",
    async (when) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
      const status = vi.fn();
      const { container, unmount } = render(
        <div className="app-shell">
          <GlassScene settings={DEFAULT_GLASS_SETTINGS} onStatus={status} />
          <button data-player-glass="table">Ada</button>
        </div>,
      );
      const visibility = () => document.dispatchEvent(new Event("visibilitychange"));
      const show = () => window.dispatchEvent(new Event("pageshow"));
      const elapse = () => act(async () => vi.advanceTimersByTimeAsync(5000));
      const card = screen.getByRole("button", { name: "Ada" });
      const calls = vi.mocked(createGlassRenderer).mock.calls;
      await act(async () => undefined);
      paint();
      expect(card).toHaveAttribute("data-glass-painted", "true");

      // Losing again before the retry can paint must not start another timer.
      const obsolete = { draw: vi.fn(), dispose: vi.fn() };
      vi.mocked(createGlassRenderer).mockImplementationOnce(async (_target, _image, onLost) => {
        onLost?.();
        return obsolete;
      });
      if (when === "hidden") hidden.mockReturnValue(true);
      act(lose);
      expect(status).toHaveBeenLastCalledWith("context-lost");
      expect(card).not.toHaveAttribute("data-glass-painted");
      expect(container.querySelector("canvas")).toBeNull();
      expect(createGlassRenderer).toHaveBeenCalledOnce();
      if (when === "backgrounded") {
        hidden.mockReturnValue(true);
        act(visibility);
        expect(vi.getTimerCount()).toBe(0);
      }
      await elapse();
      if (when !== "foreground") {
        expect(createGlassRenderer).toHaveBeenCalledOnce();
        hidden.mockReturnValue(false);
        await act(async () => visibility());
      }
      expect(createGlassRenderer).toHaveBeenCalledTimes(2);
      expect(calls[1]![0]).not.toBe(calls[0]![0]);
      expect(obsolete.dispose).toHaveBeenCalledOnce();
      expect(obsolete.draw).not.toHaveBeenCalled();
      expect(card).not.toHaveAttribute("data-glass-painted");
      await act(async () => show()); // A subsequent event for the same return cannot retry.
      await elapse();
      expect(createGlassRenderer).toHaveBeenCalledTimes(2);

      // A new foreground visit can retry; paired return events must share it.
      act(() => window.dispatchEvent(new Event("pagehide")));
      await act(async () => {
        show();
        visibility();
      });
      expect(createGlassRenderer).toHaveBeenCalledTimes(3);
      act(() => calls[0]![2]?.());
      expect(card).not.toHaveAttribute("data-glass-painted");
      expect(calls[2]![0]).toHaveStyle({ visibility: "hidden" });
      paint();
      expect(status).toHaveBeenLastCalledWith("ready");
      expect(card).toHaveAttribute("data-glass-painted", "true");

      // A successful repaint re-arms recovery; unmount cancels it again.
      act(lose);
      expect(vi.getTimerCount()).toBe(1);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
      act(show);
      act(visibility);
      await elapse();
      expect(createGlassRenderer).toHaveBeenCalledTimes(3);
      expect(frames.size).toBe(0);
    },
  );

  it("disposes a superseded pending renderer without revoking its successor", async () => {
    let finish!: (renderer: GlassRenderer) => void;
    const late = { draw: vi.fn(), dispose: vi.fn() };
    vi.mocked(createGlassRenderer).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const onStatus = vi.fn();
    const fixture = (enabled: boolean) => (
      <div className="app-shell">
        <GlassScene settings={{ ...DEFAULT_GLASS_SETTINGS, enabled }} onStatus={onStatus} />
        <button data-player-glass="profile">Ada</button>
      </div>
    );
    const { container, rerender } = render(fixture(true));
    await act(async () => undefined);
    const first = vi.mocked(createGlassRenderer).mock.calls[0]!;
    const card = screen.getByRole("button", { name: "Ada" });
    expect(onStatus).toHaveBeenLastCalledWith("initializing");
    expect(card).not.toHaveAttribute("data-glass-painted");
    rerender(fixture(false));
    await act(async () => rerender(fixture(true)));
    paint();
    expect(container.querySelector("canvas")).not.toBe(first[0]);
    await act(async () => {
      first[2]?.();
      finish(late);
    });
    expect(late.dispose).toHaveBeenCalledOnce();
    expect(late.draw).not.toHaveBeenCalled();
    expect(renderers[0]?.dispose).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenLastCalledWith("ready");
    expect(card).toHaveAttribute("data-glass-painted", "true");
  });

  it("reuses shared decoded images and ignores obsolete background preparation without mutating images", async () => {
    vi.useFakeTimers();
    const images: { image: HTMLImageElement; resolve: () => void }[] = [];
    const createImage = vi.fn(function () {
      const image = document.createElement("img");
      let resolve!: () => void;
      const decoded = new Promise<void>((done) => {
        resolve = done;
      });
      Object.defineProperty(image, "decode", { value: () => decoded });
      images.push({ image, resolve });
      return image;
    });
    vi.stubGlobal("Image", createImage);
    const onStatus = vi.fn();
    const fixture = (fancy: boolean, background: BackgroundId = "old-town") => (
      <FancyFeaturesContext.Provider value={fancy}>
        <div className="app-shell">
          <GlassScene
            settings={DEFAULT_GLASS_SETTINGS}
            onStatus={onStatus}
            background={background}
          />
        </div>
      </FancyFeaturesContext.Provider>
    );
    const { rerender, unmount } = render(fixture(false));
    expect(createImage).not.toHaveBeenCalled();
    const prepared = loadVisualImage("/backgrounds/old-town.svg");
    const oldTown = images[0]!;
    const removeSource = vi.spyOn(oldTown.image, "removeAttribute");
    rerender(fixture(true));
    expect(createImage).toHaveBeenCalledOnce();
    expect(createGlassRenderer).not.toHaveBeenCalled();
    rerender(fixture(false));
    await act(async () => {
      oldTown.resolve();
      await prepared;
    });
    expect(createGlassRenderer).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(HTMLCanvasElement.prototype.getContext)
        .mock.calls.filter(([kind]) => kind === "webgl"),
    ).toHaveLength(0);
    expect(oldTown.image).toHaveAttribute("src", "/backgrounds/old-town.svg");
    expect(removeSource).not.toHaveBeenCalled();
    expect(loadVisualImage("/backgrounds/old-town.svg")).toBe(prepared);

    await act(async () => rerender(fixture(true, "harbour")));
    expect(createImage).toHaveBeenCalledTimes(2);
    const harbour = images[1]!;
    await act(async () => rerender(fixture(true)));
    expect(createGlassRenderer).toHaveBeenCalledOnce();
    expect(createGlassRenderer).toHaveBeenLastCalledWith(
      expect.any(HTMLCanvasElement),
      oldTown.image,
      expect.any(Function),
    );
    await act(async () => harbour.resolve());
    expect(createGlassRenderer).toHaveBeenCalledOnce();
    paint();
    await act(async () => rerender(fixture(false)));
    await act(async () => rerender(fixture(true)));
    expect(createGlassRenderer).toHaveBeenCalledTimes(2);
    expect(createImage).toHaveBeenCalledTimes(2);
    expect(createGlassRenderer).toHaveBeenLastCalledWith(
      expect.any(HTMLCanvasElement),
      oldTown.image,
      expect.any(Function),
    );
    await act(async () => unmount());
    expect(removeSource).not.toHaveBeenCalled();
    expect(harbour.image).toHaveAttribute("src", "/backgrounds/harbour.svg");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("creates no renderer or observers while off and releases active ownership without replacing content", async () => {
    const onStatus = vi.fn();
    const fixture = (fancy: boolean) => (
      <FancyFeaturesContext.Provider value={fancy}>
        <div className="app-shell">
          <GlassScene settings={DEFAULT_GLASS_SETTINGS} onStatus={onStatus} />
          <button data-player-glass="profile">Ada</button>
          <input aria-label="Draft" defaultValue="preserved" />
        </div>
      </FancyFeaturesContext.Provider>
    );
    const { container, rerender, unmount } = render(fixture(false));
    const draft = screen.getByRole("textbox", { name: "Draft" });
    const card = screen.getByRole("button", { name: "Ada" });
    expect(createGlassRenderer).not.toHaveBeenCalled();
    expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled();
    expect(TestResizeObserver.instances).toHaveLength(0);
    expect(TestMutationObserver.instances).toHaveLength(0);
    expect(window.matchMedia).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(container.querySelector("canvas")).toBeNull();

    await act(async () => rerender(fixture(true)));
    expect(createGlassRenderer).toHaveBeenCalledOnce();
    const firstCanvas = container.querySelector("canvas");
    const observer = TestResizeObserver.instances[0]!;
    paint();
    expect(renderers[0]?.draw).toHaveBeenCalledOnce();
    expect(card).toHaveAttribute("data-glass-painted", "true");
    const staleFrame = [...frames.values()][0]!;
    await act(async () => rerender(fixture(false)));
    expect(renderers[0]?.dispose).toHaveBeenCalledOnce();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    for (const mutation of TestMutationObserver.instances)
      expect(mutation.disconnect).toHaveBeenCalledOnce();
    expect(card).not.toHaveAttribute("data-glass-painted");
    expect(container.querySelector("canvas")).toBeNull();
    expect(frames.size).toBe(0);
    act(() => staleFrame(performance.now()));
    expect(renderers[0]?.draw).toHaveBeenCalledOnce();

    await act(async () => rerender(fixture(true)));
    expect(createGlassRenderer).toHaveBeenCalledTimes(2);
    expect(container.querySelector("canvas")).not.toBe(firstCanvas);
    paint();
    expect(renderers[1]?.draw).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
    expect(screen.getByRole("button", { name: "Ada" })).toBe(card);
    expect(draft).toHaveValue("preserved");
    await act(async () => unmount());
    expect(renderers[1]?.dispose).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });
});

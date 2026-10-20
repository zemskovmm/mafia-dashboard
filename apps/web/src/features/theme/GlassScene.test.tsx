import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FancyFeaturesContext } from "../effects/FancyFeaturesContext.js";
import { DEFAULT_GLASS_SETTINGS } from "./glass-preferences.js";
import { createGlassRenderer, type GlassRenderer } from "./glass-renderer.js";
import { GlassScene } from "./GlassScene.js";
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
const loseContext = vi.fn();
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
  loseContext.mockClear();
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
  vi.mocked(createGlassRenderer).mockImplementation(() => {
    const renderer = { draw: vi.fn(), dispose: vi.fn() };
    renderers.push(renderer);
    return renderer;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((type: string) =>
    type === "webgl"
      ? ({ getExtension: () => ({ loseContext }) } as unknown as WebGLRenderingContext)
      : null,
  );
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
    const preference = media.get("(prefers-reduced-transparency: reduce)")!;
    act(() => {
      Object.assign(preference, { matches: true });
      preference.dispatchEvent(new Event("change"));
    });
    expect(renderers[0]?.dispose).toHaveBeenCalledOnce();
    expect(onStatus).toHaveBeenLastCalledWith("reduced-transparency");
    await act(async () => rerender(fixture(false)));
    rerender(fixture(true));
    expect(createGlassRenderer).toHaveBeenCalledOnce();
    act(() => {
      Object.assign(preference, { matches: false });
      preference.dispatchEvent(new Event("change"));
    });
    expect(createGlassRenderer).toHaveBeenCalledTimes(2);
    const oldCanvas = container.querySelector("canvas")!;
    act(() => {
      oldCanvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    });
    expect(renderers[1]?.dispose).toHaveBeenCalledOnce();
    expect(onStatus).toHaveBeenLastCalledWith("context-lost");
    await act(async () => rerender(fixture(false)));
    rerender(fixture(true));
    expect(container.querySelector("canvas")).not.toBe(oldCanvas);
    expect(createGlassRenderer).toHaveBeenCalledTimes(3);
    paint();
    expect(onStatus).toHaveBeenLastCalledWith("ready");
    await act(async () => unmount());
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
    expect(loseContext).not.toHaveBeenCalled();
    expect(oldTown.image).toHaveAttribute("src", "/backgrounds/old-town.svg");
    expect(removeSource).not.toHaveBeenCalled();
    expect(loadVisualImage("/backgrounds/old-town.svg")).toBe(prepared);

    rerender(fixture(true, "harbour"));
    expect(createImage).toHaveBeenCalledTimes(2);
    const harbour = images[1]!;
    await act(async () => rerender(fixture(true)));
    expect(createGlassRenderer).toHaveBeenCalledOnce();
    expect(createGlassRenderer).toHaveBeenLastCalledWith(
      expect.any(HTMLCanvasElement),
      oldTown.image,
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

    rerender(fixture(true));
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
    expect(loseContext).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    act(() => staleFrame(performance.now()));
    expect(renderers[0]?.draw).toHaveBeenCalledOnce();

    rerender(fixture(true));
    expect(createGlassRenderer).toHaveBeenCalledTimes(2);
    expect(container.querySelector("canvas")).not.toBe(firstCanvas);
    paint();
    expect(renderers[1]?.draw).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
    expect(screen.getByRole("button", { name: "Ada" })).toBe(card);
    expect(draft).toHaveValue("preserved");
    await act(async () => unmount());
    expect(renderers[1]?.dispose).toHaveBeenCalledOnce();
    expect(loseContext).toHaveBeenCalledTimes(2);
    expect(frames.size).toBe(0);
  });
});

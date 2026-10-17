import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiquidCardGlass } from "./LiquidCardGlass.js";
import { SharedGlassContext } from "./SharedGlassContext.js";
import { PlayerCardAppearanceContext } from "./PlayerCardAppearanceContext.js";
import { DEFAULT_GLASS_SETTINGS } from "./glass-preferences.js";

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  target: Element | null = null;
  readonly disconnect = vi.fn();
  constructor(readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.target = target;
  }
  resize(width: number, height: number) {
    this.callback(
      [{ target: this.target, contentRect: { width, height } }] as ResizeObserverEntry[],
      this as unknown as ResizeObserver,
    );
  }
}

class TestMediaQueryList extends EventTarget {
  matches = false;
  constructor(readonly media: string) {
    super();
  }
  change(matches: boolean) {
    this.matches = matches;
    this.dispatchEvent(new Event("change"));
  }
}

const mediaQueries = new Map<string, TestMediaQueryList>();
const animations: Animation[] = [];
const animate = vi.fn(() => {
  const animation = { cancel: vi.fn(), onfinish: null } as unknown as Animation;
  animations.push(animation);
  return animation;
});
const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");

beforeEach(() => {
  vi.useFakeTimers();
  animations.length = 0;
  animate.mockClear();
  mediaQueries.clear();
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  TestResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("matchMedia", (query: string) => {
    const media = mediaQueries.get(query) ?? new TestMediaQueryList(query);
    mediaQueries.set(query, media);
    return media as unknown as MediaQueryList;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return Number(this.parentElement?.getAttribute("data-width") ?? 124);
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(108);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    createImageData: (width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/png;base64,mocked-lens-map",
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (originalAnimate === undefined) Reflect.deleteProperty(HTMLElement.prototype, "animate");
  else Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
});

describe("LiquidCardGlass", () => {
  it("exposes live nomination material variables independently of glass readiness without rebuilding optics", () => {
    const fixture = (
      nominationTint = 18,
      nominationTreatment: "icons" | "tint" | "hybrid" = "hybrid",
      shared = false,
    ) => (
      <PlayerCardAppearanceContext.Provider
        value={{
          ...DEFAULT_GLASS_SETTINGS,
          nominationTint,
          nominationColor: "#88c7e3",
          nominationTreatment,
        }}
      >
        <SharedGlassContext.Provider value={shared}>
          <button className="player-seat is-nominated">
            <LiquidCardGlass />
            Ada
          </button>
        </SharedGlassContext.Provider>
      </PlayerCardAppearanceContext.Provider>
    );
    const { container, rerender } = render(fixture());
    const surface = container.querySelector<HTMLElement>(".liquid-card-glass")!;
    const filter = container.querySelector("filter");
    expect(surface.style.getPropertyValue("--card-nomination-color")).toBe("#88c7e3");
    expect(surface.style.getPropertyValue("--card-nomination-rgb")).toBe("136 199 227");
    expect(surface.style.getPropertyValue("--card-nomination-tint")).toBe("0.18");
    rerender(fixture(50, "tint"));
    expect(surface.style.getPropertyValue("--card-nomination-tint")).toBe("0.5");
    expect(container.querySelector("filter")).toBe(filter);
    rerender(fixture(50, "icons"));
    expect(surface.style.getPropertyValue("--card-nomination-tint")).toBe("0");
    rerender(fixture(0, "tint", true));
    expect(surface.style.getPropertyValue("--card-nomination-tint")).toBe("0");
    expect(screen.getByRole("button", { name: "Ada" })).toBeInTheDocument();
  });
  it("retains a readable local fallback until this surface is painted by the shared scene", () => {
    const { container } = render(
      <SharedGlassContext.Provider value={true}>
        <button data-player-glass="profile">
          <LiquidCardGlass />
          Ada
        </button>
      </SharedGlassContext.Provider>,
    );
    expect(screen.getByRole("button", { name: "Ada" })).toBeInTheDocument();
    expect(container.querySelector(".liquid-card-glass__backdrop")).toBeInTheDocument();
    expect(container.querySelector("filter")).toBeNull();
  });

  it("keeps card semantics/content outside unique, locally measured background filters", () => {
    const { container, unmount } = render(
      <>
        <button className="player-seat is-voted" style={{ borderRadius: "14px" }}>
          <LiquidCardGlass />
          <span>Ada</span>
        </button>
        <div className="player-seat" role="group" aria-label="Boris" data-width="146">
          <LiquidCardGlass />
          <span>Boris</span>
        </div>
      </>,
    );
    const card = screen.getByRole("button", { name: "Ada" });
    expect(screen.getByRole("group", { name: "Boris" })).toHaveTextContent("Boris");
    const decorations = container.querySelectorAll<HTMLElement>(".liquid-card-glass");
    for (const decoration of decorations) {
      expect(decoration).toHaveAttribute("aria-hidden", "true");
      expect(decoration.querySelector("[tabindex], button, a, input")).toBeNull();
      expect(decoration).not.toContainElement(screen.getByText("Ada"));
      expect(decoration.querySelector("svg")).toHaveAttribute("focusable", "false");
    }
    const filters = Array.from(container.querySelectorAll("filter"));
    expect(new Set(filters.map((filter) => filter.id)).size).toBe(2);
    expect(filters[0]).toHaveAttribute("width", "124");
    expect(filters[1]).toHaveAttribute("width", "146");
    expect(filters[0]).toHaveAttribute("filterUnits", "userSpaceOnUse");
    expect(filters[0]?.querySelector("feImage")).toHaveAttribute("width", "124");
    expect(decorations[0]?.style.getPropertyValue("--liquid-card-refraction")).toContain(
      `#${filters[0]?.id}`,
    );
    expect(card).toHaveAccessibleName("Ada");

    const observer = TestResizeObserver.instances[0];
    if (observer === undefined) throw new Error("Expected local size observation");
    act(() => {
      observer.resize(138.5, 106);
      observer.resize(142.5, 106);
    });
    // During a layout transition the old map survives; work happens only once
    // the local size settles, not at animation-frame cadence.
    expect(filters[0]).toHaveAttribute("width", "124");
    act(() => vi.advanceTimersByTime(150));
    expect(container.querySelector("filter")).toHaveAttribute("width", "142.5");
    expect(container.querySelector("filter")).toHaveAttribute("height", "106");

    unmount();
    expect(observer.disconnect).toHaveBeenCalled();
  });

  it("runs finite, replaceable sweeps on real interactions without consuming card events", async () => {
    const onClick = vi.fn();
    const onKeyDown = vi.fn();
    const { unmount } = render(
      <button className="player-seat" onClick={onClick} onKeyDown={onKeyDown}>
        <LiquidCardGlass />
        <span>Ada</span>
      </button>,
    );
    const card = screen.getByRole("button", { name: "Ada" });
    fireEvent.pointerEnter(card);
    expect(animate).toHaveBeenCalledWith(expect.any(Array), {
      duration: 1050,
      easing: "ease-in-out",
      iterations: 1,
      fill: "none",
    });
    const firstSweep = animations[0];
    fireEvent.pointerMove(card);
    act(() => vi.advanceTimersByTime(10_000));
    expect(animations).toHaveLength(1);
    fireEvent.pointerDown(card);
    expect(firstSweep?.cancel).toHaveBeenCalled();
    fireEvent.click(card);
    expect(onClick).toHaveBeenCalledOnce();
    fireEvent.focusIn(card);
    fireEvent.keyDown(card, { key: " " });
    expect(onKeyDown).toHaveBeenCalledOnce();
    expect(animations).toHaveLength(2);

    await act(async () => card.classList.add("is-voted"));
    expect(animations).toHaveLength(3);
    await act(async () => card.classList.add("is-current"));
    expect(animations).toHaveLength(3);
    await act(async () => card.classList.remove("is-voted"));
    expect(animations).toHaveLength(4);
    const lastSweep = animations[3];
    const observer = TestResizeObserver.instances[0];
    act(() => observer?.resize(140, 108));
    unmount();
    expect(lastSweep?.cancel).toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(10_000);
      fireEvent.pointerEnter(card);
    });
    await act(async () => card.classList.add("is-voted"));
    expect(animations).toHaveLength(4);
  });

  it("recovers from zero geometry through the resize fallback without retaining window listeners", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const { container, unmount } = render(
      <button className="player-seat" data-width="0">
        <LiquidCardGlass />
        Ada
      </button>,
    );
    const card = screen.getByRole("button", { name: "Ada" });
    expect(container.querySelector("filter")).toBeNull();
    expect(container.querySelector(".liquid-card-glass__backdrop")).toBeInTheDocument();
    card.setAttribute("data-width", "143");
    act(() => {
      fireEvent(window, new Event("resize"));
      vi.advanceTimersByTime(150);
    });
    expect(container.querySelector("filter")).toHaveAttribute("width", "143");
    unmount();
    const contextCalls = vi.mocked(HTMLCanvasElement.prototype.getContext).mock.calls.length;
    card.setAttribute("data-width", "144");
    act(() => {
      fireEvent(window, new Event("resize"));
      vi.advanceTimersByTime(150);
    });
    expect(vi.mocked(HTMLCanvasElement.prototype.getContext).mock.calls).toHaveLength(contextCalls);
  });

  it("honours live reduced-motion/transparency changes and disabled cards", () => {
    const { container, rerender } = render(
      <button className="player-seat" disabled>
        <LiquidCardGlass />
        Ada
      </button>,
    );
    const card = screen.getByRole("button", { name: "Ada" });
    fireEvent.pointerEnter(card);
    fireEvent.pointerDown(card);
    expect(animate).not.toHaveBeenCalled();
    rerender(
      <button className="player-seat">
        <LiquidCardGlass />
        Ada
      </button>,
    );
    fireEvent.pointerEnter(card);
    expect(animations).toHaveLength(1);
    const motion = mediaQueries.get("(prefers-reduced-motion: reduce)");
    if (motion === undefined) throw new Error("Expected a motion preference subscription");
    act(() => motion.change(true));
    expect(animations[0]?.cancel).toHaveBeenCalled();
    fireEvent.focusIn(card);
    fireEvent.pointerDown(card);
    expect(animations).toHaveLength(1);
    act(() => motion.change(false));
    const transparency = mediaQueries.get("(prefers-reduced-transparency: reduce)");
    if (transparency === undefined)
      throw new Error("Expected a transparency preference subscription");
    act(() => transparency.change(true));
    expect(container.querySelector(".liquid-card-glass")).toHaveAttribute(
      "data-liquid-card-lens",
      "fallback",
    );
    expect(container.querySelector("filter")).toBeNull();
    fireEvent.pointerEnter(card);
    expect(animations).toHaveLength(1);
    act(() => transparency.change(false));
    expect(container.querySelector(".liquid-card-glass")).toHaveAttribute(
      "data-liquid-card-lens",
      "ready",
    );
  });
});

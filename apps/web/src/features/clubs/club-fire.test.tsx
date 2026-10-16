import { act, cleanup, render } from "@testing-library/react";
import { createRef, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClubEntryTransition } from "./ClubEntryTransition.js";
import { ClubFire } from "./ClubFire.js";
import { computeBurnGeometry } from "./club-fire-renderer.js";
import type * as RendererModule from "./club-fire-renderer.js";

const fake = vi.hoisted(() => ({
  unavailable: false,
  instances: [] as {
    draw: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock("./club-fire-renderer.js", async (original) => ({
  ...(await original<typeof RendererModule>()),
  createClubFireRenderer: vi.fn(() => {
    if (fake.unavailable) throw new Error("GPU unavailable");
    const instance = { draw: vi.fn(), clear: vi.fn(), dispose: vi.fn() };
    fake.instances.push(instance);
    return instance;
  }),
}));
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let reduceMotion = false;
let hidden: ReturnType<typeof vi.spyOn>;
let media: EventTarget;

beforeEach(() => {
  vi.useFakeTimers();
  reduceMotion = false;
  fake.unavailable = false;
  fake.instances = [];
  frames = new Map();
  nextFrame = 0;
  hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  media = new EventTarget();
  Object.defineProperty(media, "matches", { configurable: true, get: () => reduceMotion });
  vi.stubGlobal("matchMedia", () => media);
  vi.stubGlobal("CSS", { supports: () => true });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "DOMMatrixReadOnly",
    class {
      a = 1;
      b = 0;
      c = 0;
      d = 1;
    },
  );
});
const frameAt = (time: number) =>
  act(() => {
    const current = [...frames.values()];
    frames.clear();
    current.forEach((callback) => callback(time));
  });

// Geometry, rather than a screenshot, is the contract between real DOM clipping
// and the independently drawn hot edge.
afterEach(async () => {
  cleanup();
  vi.runAllTicks();
  await Promise.resolve();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("club burn geometry", () => {
  it("retains the full card at ignition and consumes it in the first fifth of the outer burn", () => {
    const origin = {
      x: 220,
      y: 370,
      front: [
        [340, 200],
        [360, 220],
        [360, 520],
        [340, 540],
        [120, 540],
        [100, 520],
        [100, 220],
        [120, 200],
      ] as const,
    };
    const start = computeBurnGeometry(1280, 720, origin, 0);
    expect(start.holePath).not.toBe("");
    expect(Math.min(...start.front.map(([x]) => x))).toBe(100);
    expect(Math.max(...start.front.map(([x]) => x))).toBe(360);
    expect(Math.min(...start.front.map(([, y]) => y))).toBe(200);
    expect(Math.max(...start.front.map(([, y]) => y))).toBe(540);
    for (const point of origin.front) expect(start.front).toContainEqual(point);
    expect(start.cardFront).toEqual(start.front);
    expect(start.cardPath).toBe(start.holePath);
    let previous = start.front;
    let previousCard = start.cardFront;
    for (const progress of [0.01, 0.1, 0.199, 0.2, 0.5, 1]) {
      const current = computeBurnGeometry(1280, 720, origin, progress);
      expect(current.front).toHaveLength(start.front.length);
      current.front.forEach(([x, y], i) => {
        expect(Math.hypot(x - origin.x, y - origin.y)).toBeGreaterThan(
          Math.hypot(previous[i]![0] - origin.x, previous[i]![1] - origin.y),
        );
      });
      if (progress < 0.2) {
        expect(current.cardFront).toHaveLength(start.front.length);
        current.cardFront.forEach(([x, y], i) => {
          expect(Math.hypot(x - origin.x, y - origin.y)).toBeLessThan(
            Math.hypot(previousCard[i]![0] - origin.x, previousCard[i]![1] - origin.y),
          );
        });
        previousCard = current.cardFront;
      } else {
        expect(current.cardFront).toEqual([]);
        expect(current.cardPath).toBe("");
      }
      expect(current.maskPath).toBe(`M0 0H1280V720H0Z${current.holePath}${current.cardPath}`);
      previous = current.front;
    }
    expect(
      Math.min(...previous.map(([x, y]) => Math.hypot(x - origin.x, y - origin.y))),
    ).toBeGreaterThan(Math.hypot(1280 - origin.x, origin.y));
  });

  it.each([
    { x: 12, y: 16 },
    { x: 1190, y: 680 },
    { x: 640, y: 360 },
  ])("expands monotonically from $x,$y and clears every viewport corner", (origin) => {
    let previous: readonly (readonly [number, number])[] = [];
    for (const progress of [0.1, 0.3, 0.6, 0.9, 1]) {
      const current = computeBurnGeometry(1280, 720, origin, progress).front;
      current.forEach(([x, y], i) => {
        if (previous[i])
          expect(Math.hypot(x - origin.x, y - origin.y)).toBeGreaterThan(
            Math.hypot(previous[i]![0] - origin.x, previous[i]![1] - origin.y),
          );
      });
      previous = current;
    }
    const farthestCorner = Math.max(
      ...[
        [0, 0],
        [1280, 0],
        [0, 720],
        [1280, 720],
      ].map(([x, y]) => Math.hypot(x! - origin.x, y! - origin.y)),
    );
    expect(
      Math.min(...previous.map(([x, y]) => Math.hypot(x - origin.x, y - origin.y))),
    ).toBeGreaterThan(farthestCorner);
  });
  it("starts with an intact source and uses its exact front in an even-odd hole", () => {
    const origin = { x: 240, y: 330 };
    const start = computeBurnGeometry(1280, 720, origin, 0);
    expect(start.holePath).toBe("");
    const burning = computeBurnGeometry(1280, 720, origin, 0.4);
    expect(burning.front.length).toBeGreaterThan(200);
    expect(burning.maskPath).toBe(`M0 0H1280V720H0Z${burning.holePath}`);
    expect(burning.holePath).toContain(
      `${burning.front[0]![0].toFixed(2)} ${burning.front[0]![1].toFixed(2)}`,
    );
    const radii = burning.front.map(([x, y]) => Math.hypot(x - origin.x, y - origin.y));
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(12);
  });
});

describe("real outgoing DOM transition lifecycle", () => {
  it("keeps the real card aligned with both burn fronts and restores its styles on teardown", () => {
    const source = document.createElement("div");
    source.getBoundingClientRect = () => new DOMRect(20, 30, 1280, 720);
    const card = document.createElement("article");
    card.textContent = "Real club logo and text";
    card.style.setProperty("transform", "scale(0.97)", "important");
    card.style.transition = "transform 180ms ease";
    source.append(card);
    document.body.append(source);
    const origin = {
      x: 220,
      y: 370,
      card,
      cardTransform: "matrix(1, 0, 0, 1, 0, -8)",
      front: [
        [360, 200],
        [360, 540],
        [100, 540],
        [100, 200],
      ] as const,
    };
    const view = render(
      <ClubEntryTransition
        sourceRef={{ current: source }}
        origin={origin}
        ready
        onComplete={vi.fn()}
      />,
    );
    const geometry = computeBurnGeometry(
      1280,
      720,
      {
        x: 200,
        y: 340,
        front: origin.front.map(([x, y]) => [x - 20, y - 30] as const),
      },
      0,
    );
    expect(geometry.holePath).not.toBe("");
    expect(view.container.querySelector("clipPath path")!.getAttribute("d")).toBe(
      geometry.maskPath,
    );
    expect(fake.instances.at(-1)!.draw).toHaveBeenCalled();
    expect(fake.instances.at(-1)!.draw.mock.calls.at(-1)![3][0].front).toEqual(
      geometry.front.map(([x, y]) => [x + 20, y + 30]),
    );
    expect(source.firstElementChild).toBe(card);
    expect(card.style.transform).toBe(origin.cardTransform);
    expect(card.style.transition).toBe("none");
    frameAt(180);
    const burning = computeBurnGeometry(
      1280,
      720,
      {
        x: 200,
        y: 340,
        front: origin.front.map(([x, y]) => [x - 20, y - 30] as const),
      },
      0.1,
    );
    const surfaces = fake.instances.at(-1)!.draw.mock.calls.at(-1)![3];
    expect(surfaces).toHaveLength(2);
    expect(surfaces[1]).toMatchObject({
      inward: true,
      front: burning.cardFront.map(([x, y]) => [x + 20, y + 30]),
    });
    expect(view.container.querySelector("clipPath path")!.getAttribute("d")).toBe(burning.maskPath);
    frameAt(360);
    expect(fake.instances.at(-1)!.draw.mock.calls.at(-1)![3]).toHaveLength(1);
    expect(view.container.querySelector(".club-entry-effect")).toHaveAttribute(
      "data-phase",
      "burning",
    );
    view.unmount();
    expect(card.style.transform).toBe("scale(0.97)");
    expect(card.style.getPropertyPriority("transform")).toBe("important");
    expect(card.style.transition).toBe("transform 180ms ease");
    source.remove();
  });

  it("gates on readiness, clips the retained node with the drawn front, completes once and restores styles", () => {
    const sourceRef = createRef<HTMLDivElement>();
    const firstCallback = vi.fn(),
      latestCallback = vi.fn();
    const scene = (ready: boolean, callback: () => void, visible = true) => (
      <StrictMode>
        <div ref={sourceRef} style={{ clipPath: "inset(2px)", opacity: ".8" }}>
          <button>Real outgoing club</button>
        </div>
        <div>Real incoming workspace</div>
        {visible && (
          <ClubEntryTransition
            sourceRef={sourceRef}
            origin={{ x: 240, y: 330 }}
            ready={ready}
            onComplete={callback}
          />
        )}
      </StrictMode>
    );
    const view = render(scene(false, firstCallback));
    const source = sourceRef.current!;
    expect(fake.instances).toHaveLength(0);
    expect(source.style.clipPath).toBe("inset(2px)");
    view.rerender(scene(true, latestCallback));
    expect(sourceRef.current).toBe(source);
    expect(source.style.clipPath).toContain("url(");
    expect(source.getAttribute("data-club-burn-mask")).toBe("svg-evenodd");
    frameAt(900);
    const wrapper = view.container.querySelector<HTMLElement>(".club-entry-effect")!;
    expect(Number(wrapper.dataset.clubBurnProgress)).toBeCloseTo(0.5);
    const geometry = computeBurnGeometry(
      window.innerWidth,
      window.innerHeight,
      { x: 240, y: 330 },
      0.5,
    );
    expect(view.container.querySelector("clipPath path")!.getAttribute("d")).toBe(
      geometry.maskPath,
    );
    expect(fake.instances.at(-1)!.draw.mock.calls.at(-1)![3][0].front).toEqual(geometry.front);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(latestCallback).toHaveBeenCalledTimes(1);
    expect(firstCallback).not.toHaveBeenCalled();
    expect(source.style.visibility).toBe("hidden");
    act(() => vi.advanceTimersByTime(5000));
    expect(latestCallback).toHaveBeenCalledTimes(1);
    view.rerender(scene(true, latestCallback, false));
    expect(source.style.clipPath).toBe("inset(2px)");
    expect(source.style.opacity).toBe("0.8");
    expect(source.style.visibility).toBe("");
    expect(frames.size).toBe(0);
    expect(fake.instances.at(-1)!.dispose).toHaveBeenCalledWith(false);
  });

  it("finishes a normal 1.8s burn and cancels all StrictMode work", () => {
    const sourceRef = createRef<HTMLDivElement>();
    const callback = vi.fn();
    const view = render(
      <StrictMode>
        <div ref={sourceRef}>Outgoing portal</div>
        <ClubEntryTransition
          sourceRef={sourceRef}
          origin={{ x: 600, y: 300 }}
          ready
          onComplete={callback}
        />
      </StrictMode>,
    );
    expect(fake.instances).toHaveLength(2);
    expect(fake.instances[0]!.dispose).toHaveBeenCalledWith(false);
    frameAt(1000);
    expect(callback).not.toHaveBeenCalled();
    frameAt(1800);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector(".club-entry-effect")).toHaveAttribute(
      "data-club-burn-progress",
      "1",
    );
    view.unmount();
    act(() => vi.advanceTimersByTime(5000));
    expect(callback).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });

  it.each(["graphics", "motion", "hidden", "timeout", "context-loss"])(
    "has bounded completion for %s without consuming a workspace network signal",
    async (reason) => {
      fake.unavailable = reason === "graphics";
      reduceMotion = reason === "motion";
      const sourceRef = createRef<HTMLDivElement>();
      const callback = vi.fn();
      const view = render(
        <>
          <div ref={sourceRef}>Outgoing portal</div>
          <ClubEntryTransition
            sourceRef={sourceRef}
            origin={{ x: 120, y: 200 }}
            ready={reason !== "timeout"}
            onComplete={callback}
          />
        </>,
      );
      if (reason === "hidden")
        act(() => {
          hidden.mockReturnValue(true);
          document.dispatchEvent(new Event("visibilitychange"));
        });
      if (reason === "context-loss")
        act(() => {
          view.container
            .querySelector("canvas")!
            .dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
        });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3300);
      });
      expect(callback).toHaveBeenCalledTimes(1);
      expect(frames.size).toBe(0);
      expect(view.container.querySelector(".club-entry-effect")).toHaveAttribute(
        "data-phase",
        "complete",
      );
      if (reason === "timeout")
        expect(view.container.querySelector(".club-entry-effect")).toHaveAttribute(
          "data-readiness-timeout",
          "true",
        );
    },
  );

  it("unmounting while waiting never calls the stale completion callback", () => {
    const sourceRef = createRef<HTMLDivElement>(),
      callback = vi.fn();
    const view = render(
      <>
        <div ref={sourceRef} />
        <ClubEntryTransition
          sourceRef={sourceRef}
          origin={{ x: 0, y: 0 }}
          ready={false}
          onComplete={callback}
        />
      </>,
    );
    view.unmount();
    act(() => vi.advanceTimersByTime(10000));
    expect(callback).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });
});

describe("shared ambient fire lifecycle", () => {
  it("draws the transformed visible perimeter, clips to scroll viewport, and increases focused heat", () => {
    const rootRef = createRef<HTMLDivElement>();
    const view = render(
      <div ref={rootRef}>
        <div className="club-portal-content">
          <article className="club-playing-card" style={{ opacity: 1, borderRadius: "16px" }}>
            <button>Club</button>
          </article>
          <article className="club-playing-card" style={{ opacity: 1 }}>
            <button>Offscreen</button>
          </article>
          <button className="club-playing-card new-club-card">New club</button>
        </div>
        <ClubFire rootRef={rootRef} />
      </div>,
    );
    vi.stubGlobal(
      "DOMMatrixReadOnly",
      class {
        a = 0;
        b = 1;
        c = -1;
        d = 0;
      },
    );
    const port = view.container.querySelector<HTMLElement>(".club-portal-content")!;
    const cards = view.container.querySelectorAll<HTMLElement>("article");
    Object.defineProperties(port, { clientWidth: { value: 500 }, clientHeight: { value: 400 } });
    port.getBoundingClientRect = () => new DOMRect(50, 40, 500, 400);
    Object.defineProperties(cards[0]!, {
      offsetWidth: { value: 243 },
      offsetHeight: { value: 340 },
    });
    cards[0]!.getBoundingClientRect = () => new DOMRect(100, 100, 340, 243);
    cards[1]!.getBoundingClientRect = () => new DOMRect(100, 1200, 243, 340);
    frameAt(0);
    const first = fake.instances[0]!.draw.mock.calls.at(-1)![3];
    expect(first).toHaveLength(1);
    expect(first[0].clip).toEqual([50, 40, 500, 400]);
    // Local bottom-right arc start, transformed by the real quarter turn.
    expect(first[0].front[0]).toEqual([
      100 + 340 / 2 - (340 - 16 - 340 / 2),
      100 + 243 / 2 + 243 / 2,
    ]);
    const restingEnergy = first[0].energy;
    act(() => cards[0]!.querySelector("button")!.focus());
    frameAt(100);
    expect(fake.instances[0]!.draw.mock.calls.at(-1)![3][0].energy).toBeGreaterThan(restingEnergy);
    expect(view.container.querySelector("canvas")).toHaveAttribute("data-club-fire-active", "1");
  });

  it("uses a still cue for reduced motion, leaves the new card alone and restores attributes", () => {
    reduceMotion = true;
    const rootRef = createRef<HTMLDivElement>();
    const view = render(
      <div ref={rootRef}>
        <div className="club-portal-content">
          <article className="club-playing-card">
            <button>Club</button>
          </article>
          <button className="club-playing-card new-club-card">New club</button>
        </div>
        <ClubFire rootRef={rootRef} />
      </div>,
    );
    const card = view.container.querySelector<HTMLElement>("article")!;
    expect(card).toHaveAttribute("data-club-fire-static", "true");
    expect(view.container.querySelector(".new-club-card")).not.toHaveAttribute(
      "data-club-fire-static",
    );
    expect(fake.instances).toHaveLength(0);
    expect(frames.size).toBe(0);
    view.unmount();
    expect(card).not.toHaveAttribute("data-club-fire-static");
  });

  it("pauses hidden, resumes, and disposes its single scene under StrictMode", () => {
    const rootRef = createRef<HTMLDivElement>();
    const view = render(
      <StrictMode>
        <div ref={rootRef}>
          <div className="club-portal-content">
            <article className="club-playing-card">
              <button>Club</button>
            </article>
          </div>
          <ClubFire rootRef={rootRef} />
        </div>
      </StrictMode>,
    );
    expect(fake.instances).toHaveLength(2);
    expect(fake.instances[0]!.dispose).toHaveBeenCalledWith(false);
    expect(frames.size).toBe(1);
    act(() => {
      hidden.mockReturnValue(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(frames.size).toBe(0);
    act(() => {
      hidden.mockReturnValue(false);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(frames.size).toBe(1);
    view.unmount();
    expect(fake.instances.at(-1)!.dispose).toHaveBeenCalledWith(false);
    expect(frames.size).toBe(0);
  });
});

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@mafia/game-domain";
import { FancyFeaturesContext } from "../effects/FancyFeaturesContext.js";
import { RoleDrawPresentation, type RoleDrawRequest } from "./RoleDrawPresentation.js";

const request = (id = 1): RoleDrawRequest => ({
  id,
  startedAt: performance.now(),
  previousRole: "citizen",
});
const face = (role: Role | undefined) => <span>{role ?? "Draw role"}</span>;
const fixture = (motion: RoleDrawRequest | undefined, complete: (id: number) => void) => (
  <button className="player-seat role-draw-card" aria-label="Current role: sheriff">
    <RoleDrawPresentation role="sheriff" request={motion} onComplete={complete}>
      {face}
    </RoleDrawPresentation>
  </button>
);

describe("RoleDrawPresentation", () => {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
  const timelineDescriptor = Object.getOwnPropertyDescriptor(document, "timeline");
  let animations: Array<{
    cancel: ReturnType<typeof vi.fn>;
    resolve: () => void;
    startTime: number | null;
    currentTime: number | null;
  }>;
  let animate: ReturnType<typeof vi.fn>;
  let reduced: boolean;
  let change: (() => void) | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    animations = [];
    reduced = false;
    change = undefined;
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        get matches() {
          return reduced;
        },
        addEventListener: (_event: string, listener: () => void) => {
          change = listener;
        },
        removeEventListener: vi.fn(),
      })),
    );
    animate = vi.fn(() => {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const finished = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      const animation = {
        finished,
        cancel: vi.fn(() => reject(new Error("Animation cancelled"))),
        resolve,
        startTime: null as number | null,
        currentTime: null as number | null,
      };
      animations.push(animation);
      return animation;
    });
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  });
  afterEach(() => {
    cleanup();
    if (descriptor) Object.defineProperty(HTMLElement.prototype, "animate", descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, "animate");
    if (timelineDescriptor) Object.defineProperty(document, "timeline", timelineDescriptor);
    else Reflect.deleteProperty(document, "timeline");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("anchors every reveal track to the accepted request's native epoch", () => {
    vi.spyOn(performance, "now").mockReturnValue(100);
    Object.defineProperty(document, "timeline", {
      configurable: true,
      value: { currentTime: 100 },
    });
    render(fixture({ ...request(), startedAt: 80 }, vi.fn()));
    expect(animations).toHaveLength(4);
    expect(animations.map(({ startTime }) => startTime)).toEqual(Array(4).fill(80));
    expect(animations.every(({ currentTime }) => currentTime === null)).toBe(true);
  });

  it("commits the retained request's upright current face before releasing filled effects", async () => {
    const snapshots: boolean[] = [];
    let retainedAtCompletion = false;
    const complete = vi.fn(() => {
      retainedAtCompletion = animations.every(({ cancel }) => cancel.mock.calls.length === 0);
    });
    const motion = request(91);
    const { container, rerender } = render(fixture(motion, complete));
    const current = container.querySelector(".role-draw-face--back");
    const host = container.querySelector("button");
    for (const animation of animations) {
      const cancel = animation.cancel.getMockImplementation() as () => void;
      animation.cancel.mockImplementation(() => {
        snapshots.push(
          container.querySelector(".role-draw-face--front,.role-draw-face--back") === null,
        );
        cancel();
      });
    }
    await act(async () => animations.forEach(({ resolve }) => resolve()));
    expect(complete).toHaveBeenCalledExactlyOnceWith(91);
    expect(retainedAtCompletion).toBe(true);
    expect(snapshots).toEqual(Array(4).fill(true));
    expect(container.querySelector("button")).toBe(host);
    expect(container.querySelector(".role-draw-face")).toBe(current);
    expect(animations.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    rerender(fixture(motion, complete));
    expect(animate).toHaveBeenCalledTimes(4);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("commits static reveal after partial startup before cancellation without replay", async () => {
    const snapshots: boolean[] = [];
    let retainedAtCompletion = false;
    const complete = vi.fn(() => {
      retainedAtCompletion = animations.every(({ cancel }) => cancel.mock.calls.length === 0);
    });
    const start = animate.getMockImplementation() as () => (typeof animations)[number];
    animate.mockImplementationOnce(() => {
      const animation = start();
      const cancel = animation.cancel.getMockImplementation() as () => void;
      animation.cancel.mockImplementation(() => {
        snapshots.push(
          document.querySelector(".role-draw-face--front,.role-draw-face--back") === null,
        );
        cancel();
      });
      return animation;
    });
    animate.mockImplementationOnce(() => {
      throw new Error("Unsupported rotation");
    });
    const motion = request(92);
    const { container, rerender } = render(fixture(motion, complete));
    expect(complete).toHaveBeenCalledExactlyOnceWith(92);
    expect(retainedAtCompletion).toBe(true);
    expect(snapshots).toEqual([true]);
    expect(animations[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".role-draw-face")).toHaveTextContent("sheriff");
    rerender(fixture(motion, complete));
    expect(animate).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {});
  });

  it("does not animate an initial or ordinary rerendered role", () => {
    const complete = vi.fn();
    const { rerender } = render(fixture(undefined, complete));
    rerender(fixture(undefined, complete));
    expect(screen.getByRole("button")).toHaveTextContent("sheriff");
    expect(animate).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("bypasses disabled Fancy motion, settles once and never replays a completed request on re-enable", () => {
    const complete = vi.fn();
    const motion = request();
    const view = (enabled: boolean) => (
      <FancyFeaturesContext.Provider value={enabled}>
        {fixture(motion, complete)}
      </FancyFeaturesContext.Provider>
    );
    const { container, rerender } = render(view(false));
    expect(animate).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledExactlyOnceWith(1);
    expect(container.querySelector(".role-draw-face--front,.role-draw-face--back")).toBeNull();
    const current = container.querySelector(".role-draw-face");
    expect(current).toHaveTextContent("sheriff");
    rerender(view(true));
    expect(animate).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".role-draw-face")).toBe(current);
    expect(container.querySelector(".role-draw-face--back")).toBeNull();
  });

  it("cancels a live flip immediately on Fancy OFF with no stale callback, remount or replay", async () => {
    const complete = vi.fn();
    const motion = request();
    const view = (enabled: boolean) => (
      <FancyFeaturesContext.Provider value={enabled}>
        {fixture(motion, complete)}
      </FancyFeaturesContext.Provider>
    );
    const { container, rerender } = render(view(true));
    expect(animate).toHaveBeenCalledTimes(4);
    const current = container.querySelector(".role-draw-face--back");
    rerender(view(false));
    expect(complete).toHaveBeenCalledExactlyOnceWith(1);
    expect(animations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(container.querySelector(".role-draw-face")).toBe(current);
    expect(container.querySelector(".role-draw-face--front,.role-draw-face--back")).toBeNull();
    await act(async () => animations.forEach((animation) => animation.resolve()));
    rerender(view(true));
    expect(animate).toHaveBeenCalledTimes(4);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".role-draw-face")).toBe(current);
    expect(container.querySelector(".role-draw-face--back")).toBeNull();
    rerender(
      <FancyFeaturesContext.Provider value={true}>
        {fixture(request(2), complete)}
      </FancyFeaturesContext.Provider>,
    );
    expect(animate).toHaveBeenCalledTimes(8);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("switches old/new faces at the edge without opacity/death effects and settles upright", async () => {
    const complete = vi.fn();
    const motion = request();
    const { container, rerender } = render(fixture(motion, complete));
    expect(animate).toHaveBeenCalledTimes(4);
    const frames = animate.mock.calls.map(([keyframes]) => keyframes as Keyframe[]);
    expect(frames[1]!.at(-1)).toMatchObject({ rotate: "y 180deg" });
    const frontEdge = frames[2]![1]!.offset;
    expect(frames[3]![1]).toMatchObject({ offset: frontEdge, visibility: "visible" });
    expect(frames.flat().every((frame) => frame.opacity === undefined)).toBe(true);
    expect(container.querySelector(".role-draw-face--front")).toHaveTextContent("citizen");
    expect(container.querySelector(".role-draw-face--back")).toHaveTextContent("sheriff");
    const currentFace = container.querySelector(".role-draw-face--back");
    expect(container.querySelector(".deceased-cross")).toBeNull();
    rerender(fixture(motion, complete));
    expect(animate).toHaveBeenCalledTimes(4);
    await act(async () => {
      animations.forEach((animation) => animation.resolve());
    });
    expect(complete).toHaveBeenCalledExactlyOnceWith(1);
    expect(animations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true);
    rerender(fixture(undefined, complete));
    expect(container.querySelector(".role-draw-face--front")).toBeNull();
    expect(container.querySelector(".role-draw-face")).toBe(currentFace);
    expect(animations.every((animation) => animation.cancel.mock.calls.length > 0)).toBe(true);
    expect(screen.getByRole("button").style.rotate).toBe("");
    expect(screen.getByRole("button")).toHaveTextContent("sheriff");
  });

  it("supersedes rapid requests and cancels all motion on unmount without stale completion", async () => {
    const complete = vi.fn();
    const { rerender, unmount } = render(fixture(request(), complete));
    const old = [...animations];
    rerender(fixture(request(2), complete));
    expect(old.every((animation) => animation.cancel.mock.calls.length > 0)).toBe(true);
    expect(animate).toHaveBeenCalledTimes(8);
    await act(async () => {
      old.forEach((animation) => animation.resolve());
    });
    expect(complete).not.toHaveBeenCalled();
    unmount();
    expect(animations.every((animation) => animation.cancel.mock.calls.length > 0)).toBe(true);
    await act(async () => {
      animations.forEach((animation) => animation.resolve());
    });
    expect(complete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["reduced", "hidden", "missing", "expired"])(
    "settles %s motion without starting a flip",
    (mode) => {
      if (mode === "reduced") reduced = true;
      if (mode === "hidden") vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      if (mode === "missing") Reflect.deleteProperty(HTMLElement.prototype, "animate");
      const complete = vi.fn();
      const motion =
        mode === "expired" ? { ...request(), startedAt: performance.now() - 1000 } : request();
      render(fixture(motion, complete));
      expect(complete).toHaveBeenCalledExactlyOnceWith(1);
      expect(animate).not.toHaveBeenCalled();
    },
  );

  it.each(["hidden", "reduced"])("cancels in-flight motion when %s", (mode) => {
    const complete = vi.fn();
    const { unmount, rerender } = render(fixture(request(), complete));
    act(() => {
      if (mode === "hidden") {
        vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        document.dispatchEvent(new Event("visibilitychange"));
      } else {
        reduced = true;
        change?.();
      }
    });
    expect(complete).toHaveBeenCalledExactlyOnceWith(1);
    rerender(fixture(undefined, complete));
    expect(animations.every((animation) => animation.cancel.mock.calls.length > 0)).toBe(true);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans partial WAAPI failure and bounds completion even if finished never resolves", () => {
    const complete = vi.fn();
    const { unmount } = render(fixture(request(), complete));
    act(() => {
      vi.runAllTimers();
    });
    expect(complete).toHaveBeenCalledExactlyOnceWith(1);
    unmount();
    animate.mockImplementationOnce(animate.getMockImplementation()!);
    animate.mockImplementationOnce(() => {
      throw new Error("Animation unavailable");
    });
    render(fixture(request(2), complete));
    expect(complete).toHaveBeenLastCalledWith(2);
    expect(animations.at(-1)!.cancel).toHaveBeenCalled();
  });
});

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
  let animations: Array<{ cancel: ReturnType<typeof vi.fn>; resolve: () => void }>;
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
      const finished = new Promise<void>((done) => {
        resolve = done;
      });
      const animation = { finished, cancel: vi.fn(), resolve };
      animations.push(animation);
      return animation;
    });
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  });
  afterEach(() => {
    cleanup();
    if (descriptor) Object.defineProperty(HTMLElement.prototype, "animate", descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, "animate");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
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
    expect(animations.every((animation) => animation.cancel.mock.calls.length === 0)).toBe(true);
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

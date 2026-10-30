import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FancyFeaturesContext } from "../effects/FancyFeaturesContext.js";
import { DEFAULT_PLAYER_EXIT_SETTINGS } from "../effects/player-exit-preferences.js";
import type { PlayerExitRequest } from "../game/PlayerExitProvider.js";
import { PlayerExitAnimation } from "./PlayerExitAnimation.js";

const fixture = (request: PlayerExitRequest, complete: (id: number) => void) => (
  <FancyFeaturesContext.Provider value={true}>
    <div className="player-seat status-eliminated">
      <PlayerExitAnimation
        request={request}
        deceased
        departureCause={request.cause}
        onComplete={complete}
        reverse={<span className="card-index">7</span>}
      >
        <span className="seat-name">Sample player</span>
      </PlayerExitAnimation>
    </div>
  </FancyFeaturesContext.Provider>
);

describe("Glass departure reverse presentation", () => {
  afterEach(cleanup);

  it.each(["unknown", "mafia", "vote", "discipline"] as const)(
    "keeps the %s endpoint free of nested reverse frames without losing its public cues",
    (cause) => {
      const { container } = render(
        <PlayerExitAnimation
          deceased
          departureCause={cause}
          onComplete={vi.fn()}
          reverse={<span className="card-discipline-status">Public status</span>}
        >
          <span className="seat-name">Sample player</span>
          <span className="person-icon" />
        </PlayerExitAnimation>,
      );
      expect(container.querySelector(".player-exit-neutral-pattern")).toBeNull();
      expect(container.querySelectorAll(".seat-name")).toHaveLength(cause === "unknown" ? 1 : 0);
      expect(container.querySelectorAll(".player-torn-fragment")).toHaveLength(
        cause === "vote" ? 2 : 0,
      );
      expect(container.querySelectorAll(".player-bullet-hole")).toHaveLength(
        cause === "mafia" ? 3 : 0,
      );
      expect(container.querySelectorAll(".player-disciplinary-ribbon")).toHaveLength(
        cause === "discipline" ? 1 : 0,
      );
      expect(container.querySelectorAll(".deceased-cross")).toHaveLength(
        cause === "unknown" ? 1 : 0,
      );
    },
  );
});

describe("PlayerExitAnimation effective Fancy lifecycle", () => {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
  const timelineDescriptor = Object.getOwnPropertyDescriptor(document, "timeline");
  let animations: Array<{
    target: HTMLElement;
    frames: Keyframe[];
    cancel: ReturnType<typeof vi.fn>;
    finish: () => void;
    startTime: number | null;
    currentTime: number | null;
  }>;
  let animate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    animations = [];
    animate = vi.fn(function (this: HTMLElement, frames: Keyframe[]) {
      let finish!: () => void;
      let reject!: (error: Error) => void;
      const finished = new Promise<void>((resolve, fail) => {
        finish = resolve;
        reject = fail;
      });
      const animation = {
        target: this,
        frames,
        finished,
        cancel: vi.fn(() => reject(new Error("Animation cancelled"))),
        finish,
        startTime: null as number | null,
        currentTime: null as number | null,
      };
      animations.push(animation);
      return animation;
    });
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate,
    });
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

  it.each(["unknown", "mafia", "vote", "discipline"] as const)(
    "anchors every %s departure track to one epoch without fading the semantic host",
    (cause) => {
      vi.spyOn(performance, "now").mockReturnValue(100);
      Object.defineProperty(document, "timeline", {
        configurable: true,
        value: { currentTime: 100 },
      });
      render(
        fixture(
          { id: 70, startedAt: 80, settings: DEFAULT_PLAYER_EXIT_SETTINGS, hideRole: true, cause },
          vi.fn(),
        ),
      );
      expect(animations.length).toBe(cause === "mafia" ? 7 : cause === "unknown" ? 5 : 6);
      expect(document.querySelector(".player-exit-neutral-pattern")).toBeNull();
      expect(animations.map(({ startTime }) => startTime)).toEqual(
        Array(animations.length).fill(80),
      );
      expect(animations.flatMap(({ frames }) => frames).some((frame) => "opacity" in frame)).toBe(
        false,
      );
      expect(
        animations.filter(({ frames }) => frames.some((frame) => "--player-exit-fade" in frame)),
      ).toHaveLength(1);
    },
  );

  it("commits a retained request's static endpoint before cancelling filled tracks", async () => {
    const snapshots: boolean[] = [];
    let retainedAtCompletion = false;
    const complete = vi.fn(() => {
      retainedAtCompletion = animations.every(({ cancel }) => cancel.mock.calls.length === 0);
    });
    const request = {
      id: 81,
      startedAt: performance.now(),
      settings: DEFAULT_PLAYER_EXIT_SETTINGS,
      hideRole: true,
    };
    const { container, rerender } = render(fixture(request, complete));
    const starts = animate.mock.calls.length;
    for (const animation of animations) {
      const cancel = animation.cancel.getMockImplementation() as () => void;
      animation.cancel.mockImplementation(() => {
        snapshots.push(
          container.querySelector(".player-exit-face") === null &&
            container.querySelectorAll(".seat-name").length === 1,
        );
        cancel();
      });
    }
    await act(async () => animations.forEach((animation) => animation.finish()));
    expect(complete).toHaveBeenCalledExactlyOnceWith(81);
    expect(retainedAtCompletion).toBe(true);
    expect(snapshots).toEqual(Array(starts).fill(true));
    expect(animations.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    rerender(fixture(request, complete));
    expect(animate).toHaveBeenCalledTimes(starts);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("settles partial startup before cancellation and does not replay the retained request", async () => {
    const snapshots: boolean[] = [];
    let retainedAtCompletion = false;
    const complete = vi.fn(() => {
      retainedAtCompletion = animations.every(({ cancel }) => cancel.mock.calls.length === 0);
    });
    const start = animate.getMockImplementation() as (
      this: HTMLElement,
      ...args: unknown[]
    ) => (typeof animations)[number];
    animate.mockImplementationOnce(function (this: HTMLElement, ...args: unknown[]) {
      const animation = start.apply(this, args);
      const cancel = animation.cancel.getMockImplementation() as () => void;
      animation.cancel.mockImplementation(() => {
        snapshots.push(
          document.querySelector(".player-exit-face") === null &&
            document.querySelectorAll(".seat-name").length === 1,
        );
        cancel();
      });
      return animation;
    });
    animate.mockImplementationOnce(() => {
      throw new Error("Unsupported rotation");
    });
    const request = {
      id: 82,
      startedAt: performance.now(),
      settings: DEFAULT_PLAYER_EXIT_SETTINGS,
      hideRole: true,
    };
    const { rerender } = render(fixture(request, complete));
    expect(complete).toHaveBeenCalledExactlyOnceWith(82);
    expect(retainedAtCompletion).toBe(true);
    expect(snapshots).toEqual([true]);
    expect(animations[0]!.cancel).toHaveBeenCalledTimes(1);
    rerender(fixture(request, complete));
    expect(animate).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {});
  });

  it("retains partial cause effects until the departure's static commit", async () => {
    const snapshots: boolean[] = [];
    let retainedAtCompletion = false;
    const complete = vi.fn(() => {
      retainedAtCompletion = animations.every(({ cancel }) => cancel.mock.calls.length === 0);
    });
    const start = animate.getMockImplementation() as (
      this: HTMLElement,
      ...args: unknown[]
    ) => (typeof animations)[number];
    animate.mockImplementation(function (this: HTMLElement, ...args: unknown[]) {
      if (animate.mock.calls.length === 6) throw new Error("Unsupported recoil");
      const animation = start.apply(this, args);
      const cancel = animation.cancel.getMockImplementation() as () => void;
      animation.cancel.mockImplementation(() => {
        snapshots.push(document.querySelector(".player-exit-face") === null);
        cancel();
      });
      return animation;
    });
    const request: PlayerExitRequest = {
      id: 84,
      startedAt: performance.now(),
      settings: DEFAULT_PLAYER_EXIT_SETTINGS,
      hideRole: true,
      cause: "mafia",
    };
    const { container, rerender } = render(fixture(request, complete));
    expect(complete).toHaveBeenCalledExactlyOnceWith(84);
    expect(retainedAtCompletion).toBe(true);
    expect(snapshots).toEqual(Array(5).fill(true));
    expect(animations.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
    expect(container.querySelectorAll(".player-bullet-hole")).toHaveLength(3);
    rerender(fixture(request, complete));
    expect(animate).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {});
  });

  it("bounds a never-finishing retained request and releases all owned tracks", () => {
    const complete = vi.fn();
    render(
      fixture(
        {
          id: 83,
          startedAt: performance.now(),
          settings: DEFAULT_PLAYER_EXIT_SETTINGS,
          hideRole: true,
        },
        complete,
      ),
    );
    act(() => vi.runAllTimers());
    expect(complete).toHaveBeenCalledExactlyOnceWith(83);
    expect(animations.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
    expect(document.querySelector(".player-exit-face")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["visibility", "reduced"] as const)(
    "settles %s interruption exactly once and releases listeners and timers",
    async (interruption) => {
      let reduced = false;
      let change: (() => void) | undefined;
      const remove = vi.fn();
      vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({
          get matches() {
            return reduced;
          },
          addEventListener: (_event: string, listener: () => void) => {
            change = listener;
          },
          removeEventListener: remove,
        })),
      );
      const complete = vi.fn();
      const request = {
        id: 85,
        startedAt: performance.now(),
        settings: DEFAULT_PLAYER_EXIT_SETTINGS,
        hideRole: true,
      };
      const { container, rerender } = render(fixture(request, complete));
      act(() => {
        if (interruption === "visibility") {
          vi.spyOn(document, "hidden", "get").mockReturnValue(true);
          document.dispatchEvent(new Event("visibilitychange"));
        } else {
          reduced = true;
          change?.();
        }
      });
      expect(complete).toHaveBeenCalledExactlyOnceWith(85);
      expect(container.querySelector(".player-exit-face")).toBeNull();
      expect(animations.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      await act(async () => animations.forEach(({ finish }) => finish()));
      rerender(fixture(request, complete));
      expect(complete).toHaveBeenCalledTimes(1);
    },
  );

  it("ignores replaced and unmounted requests' queued completions", async () => {
    const complete = vi.fn();
    const request = {
      id: 86,
      startedAt: performance.now(),
      settings: DEFAULT_PLAYER_EXIT_SETTINGS,
      hideRole: true,
    };
    const { rerender, unmount } = render(fixture(request, complete));
    const previous = [...animations];
    rerender(fixture({ ...request, id: 87 }, complete));
    expect(previous.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
    await act(async () => previous.forEach(({ finish }) => finish()));
    expect(complete).not.toHaveBeenCalled();
    unmount();
    await act(async () => animations.forEach(({ finish }) => finish()));
    expect(complete).not.toHaveBeenCalled();
    expect(animations.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    "settles exactly once with initial Fancy %s even if the caller retains the request",
    async (initialFancy) => {
      const complete = vi.fn();
      const request = {
        id: 1,
        startedAt: performance.now(),
        settings: DEFAULT_PLAYER_EXIT_SETTINGS,
        hideRole: true,
      };
      const fixture = (fancy: boolean) => (
        <FancyFeaturesContext.Provider value={fancy}>
          <div className="player-seat status-eliminated">
            <PlayerExitAnimation request={request} deceased onComplete={complete} reverse={null}>
              <span className="seat-name">Sample player</span>
            </PlayerExitAnimation>
          </div>
        </FancyFeaturesContext.Provider>
      );
      const { container, rerender } = render(fixture(initialFancy));
      const starts = initialFancy ? 5 : 0;
      expect(animate).toHaveBeenCalledTimes(starts);
      rerender(fixture(false));
      expect(complete).toHaveBeenCalledExactlyOnceWith(1);
      expect(animations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true);
      expect(container.querySelectorAll(".player-exit-face")).toHaveLength(0);
      expect(container.querySelectorAll(".seat-name")).toHaveLength(1);
      expect(container.querySelectorAll(".deceased-cross")).toHaveLength(1);
      rerender(fixture(true));
      // Model a queued successful finish arriving after cancellation as well as the
      // real controls regression's rejected finished promises.
      await act(async () => animations.forEach((animation) => animation.finish()));
      rerender(fixture(false));
      rerender(fixture(true));
      expect(complete).toHaveBeenCalledExactlyOnceWith(1);
      expect(animate).toHaveBeenCalledTimes(starts);
      expect(container.querySelectorAll(".player-exit-face")).toHaveLength(0);
      expect(container.querySelectorAll(".seat-name")).toHaveLength(1);
      expect(container.querySelectorAll(".deceased-cross")).toHaveLength(1);
    },
  );
});

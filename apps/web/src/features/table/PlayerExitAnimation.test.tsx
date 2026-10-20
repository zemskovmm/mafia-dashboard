import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FancyFeaturesContext } from "../effects/FancyFeaturesContext.js";
import { DEFAULT_PLAYER_EXIT_SETTINGS } from "../effects/player-exit-preferences.js";
import { PlayerExitAnimation } from "./PlayerExitAnimation.js";

describe("PlayerExitAnimation effective Fancy lifecycle", () => {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
  let animations: Array<{ cancel: ReturnType<typeof vi.fn>; finish: () => void }>;
  let animate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    animations = [];
    animate = vi.fn(() => {
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const animation = { finished, cancel: vi.fn(), finish };
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
    vi.restoreAllMocks();
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
            <PlayerExitAnimation request={request} deceased onComplete={complete}>
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

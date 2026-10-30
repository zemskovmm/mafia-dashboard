import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PLAYER_EXIT_SETTINGS as settings } from "../effects/player-exit-preferences.js";
import { playerDepartureTimeline } from "../effects/player-departure-timeline.js";
import { animateDepartureEffects } from "./PlayerDepartureEffects.js";

afterEach(() => vi.restoreAllMocks());

describe("departure fade track", () => {
  it.each(["unknown", "mafia", "vote", "discipline"] as const)(
    "creates exactly one material fade for %s",
    (cause) => {
      const host = document.createElement("div");
      const calls: { frames: Keyframe[]; options: KeyframeAnimationOptions }[] = [];
      host.animate = vi.fn((frames, options) => {
        calls.push({ frames: frames as Keyframe[], options: options as KeyframeAnimationOptions });
        return { finished: new Promise(() => {}), cancel: vi.fn() } as unknown as Animation;
      });
      const animations: Animation[] = [];
      animateDepartureEffects(
        host,
        host,
        { id: 1, startedAt: performance.now(), settings, cause, hideRole: true },
        animations,
      );
      expect(animations).toHaveLength(calls.length);
      const fades = calls.filter(({ frames }) => frames.some((f) => "--player-exit-fade" in f));
      const clock = playerDepartureTimeline(settings, cause);
      expect(fades).toHaveLength(1);
      expect(fades[0]?.frames).toEqual([
        { "--player-exit-fade": 1, offset: 0 },
        { "--player-exit-fade": 1, offset: clock.fadeStart / clock.duration },
        { "--player-exit-fade": settings.finalOpacity / 100, offset: 1 },
      ]);
      expect(fades[0]?.options).toMatchObject({ duration: clock.duration, fill: "both" });
    },
  );

  it("leaves partial effects with the caller for commit-owned cleanup", () => {
    const host = document.createElement("div");
    const partial = {
      finished: new Promise(() => {}),
      cancel: vi.fn(),
    } as unknown as Animation;
    host.animate = vi
      .fn()
      .mockReturnValueOnce(partial)
      .mockImplementationOnce(() => {
        throw new Error("recoil unavailable");
      });
    const animations: Animation[] = [];
    expect(() =>
      animateDepartureEffects(
        host,
        host,
        { id: 2, startedAt: performance.now(), settings, cause: "mafia", hideRole: true },
        animations,
      ),
    ).toThrow("recoil unavailable");
    expect(animations).toEqual([partial]);
    expect(partial.cancel).not.toHaveBeenCalled();
  });
});

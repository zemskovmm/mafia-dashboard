import { describe, expect, it } from "vitest";
import { playerDepartureTimeline } from "./player-departure-timeline.js";
import { DEFAULT_PLAYER_EXIT_SETTINGS as settings } from "./player-exit-preferences.js";
import { departurePresentationStyle } from "../table/PlayerDepartureEffects.js";

const causes = ["unknown", "mafia", "vote", "discipline"] as const;

describe("universal departure fade", () => {
  it.each(causes)("appends a final fade for %s", (cause) => {
    const clock = playerDepartureTimeline(settings, cause);
    expect(clock.duration - clock.fadeStart).toBe(settings.fadeMs);
    expect(clock.fadeStart - clock.tearStart).toBe(cause === "vote" ? settings.tearMs : 0);
    expect(clock.turnStart).toBe(
      cause === "mafia" ? settings.impactMs : cause === "discipline" ? settings.disciplineMs : 0,
    );
    for (const frames of [clock.lift, clock.turn, clock.front, clock.back]) {
      expect(frames[0]?.offset).toBe(0);
      expect(frames.at(-1)?.offset).toBe(1);
      const offsets = frames.map((frame) => Number(frame.offset));
      expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    }
  });

  it.each(causes)("retains the configured static fade for %s", (cause) => {
    const style = departurePresentationStyle(cause, settings);
    expect(style).toHaveProperty("--player-exit-fade", settings.finalOpacity / 100);
    expect(style).toHaveProperty("--player-exit-tear", cause === "vote" ? 1 : 0);
  });

  it("does not fade an active or only privately/provisionally departed card", () => {
    expect(departurePresentationStyle(undefined, settings)).toHaveProperty("--player-exit-fade", 1);
  });
});

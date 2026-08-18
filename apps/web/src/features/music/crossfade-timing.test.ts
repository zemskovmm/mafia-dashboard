import { describe, expect, it } from "vitest";
import { shouldStartCrossfade } from "./crossfade-timing.js";

describe("shouldStartCrossfade", () => {
  it("starts early enough to absorb sparse media time updates", () => {
    expect(
      shouldStartCrossfade({ durationSeconds: 16, currentSeconds: 12.5, crossfadeSeconds: 3 }),
    ).toBe(true);
  });

  it("waits while the next timing sample is safely before the transition window", () => {
    expect(
      shouldStartCrossfade({ durationSeconds: 16, currentSeconds: 11.5, crossfadeSeconds: 3 }),
    ).toBe(false);
  });

  it("ignores media whose duration is not finite", () => {
    expect(
      shouldStartCrossfade({
        durationSeconds: Number.POSITIVE_INFINITY,
        currentSeconds: 12,
        crossfadeSeconds: 3,
      }),
    ).toBe(false);
  });
});

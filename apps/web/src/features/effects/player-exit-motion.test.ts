import { describe, expect, it } from "vitest";
import { DEFAULT_PLAYER_EXIT_SETTINGS as defaults } from "./player-exit-preferences.js";
import { playerExitCurve, playerExitMotion } from "./player-exit-motion.js";

describe("player exit motion", () => {
  it("starts lifting and flipping together, then lands together with the selected curves", () => {
    const motion = playerExitMotion(defaults);
    expect(motion.duration).toBe(580);
    expect(motion.apex).toBe(100 / 580);
    expect(motion.flipStart).toBe(0);
    expect(motion.turn).toHaveLength(2);
    expect(motion.lift[1]).toMatchObject({ transform: "translateY(-10px) scale(1.07)" });
    for (const phase of ["lift", "flip", "drop"] as const) {
      expect(playerExitCurve(defaults, phase)).toEqual([0, 0, 0.58, 1]);
    }
    expect(motion.edge).toBeGreaterThan(0);
    expect(motion.edge).toBeLessThan(0.5);
    expect(motion.front[1]).toMatchObject({ offset: motion.edge, visibility: "hidden" });
    expect(motion.back[1]).toMatchObject({ offset: motion.edge, visibility: "visible" });
  });

  it("advances only flip onset with overlap and tracks asymmetric edge-on crossings", () => {
    for (const overlap of [0, 50, 100]) {
      const motion = playerExitMotion({ ...defaults, overlap });
      expect(motion.duration).toBe(580);
      expect(motion.flipStart).toBe((100 / 580) * (1 - overlap / 100));
      expect(motion.lift).toEqual(playerExitMotion(defaults).lift);
      expect(motion.turn.at(-1)).toEqual({ rotate: "y 180deg", offset: 1 });
    }
    const early = playerExitMotion({ ...defaults, liftMs: 700, landingMs: 200 });
    expect(early.edge).toBeLessThan(early.apex);
    const late = playerExitMotion({ ...defaults, flip: { easing: "in", strength: 100 } });
    expect(late.edge).toBeGreaterThan(0.5);
    const steady = playerExitMotion({ ...defaults, flip: { easing: "in", strength: 0 } });
    expect(steady.edge).toBeCloseTo(0.5);
    expect(
      playerExitCurve({ ...defaults, drop: { easing: "original", strength: 100 } }, "drop"),
    ).toEqual([0.65, 0, 1, 1]);
  });
});

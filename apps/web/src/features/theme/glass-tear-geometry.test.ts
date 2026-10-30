import { describe, expect, it } from "vitest";
import {
  PLAYER_TEAR_LEFT_CLIP,
  PLAYER_TEAR_RIGHT_CLIP,
  PLAYER_TEAR_SEAM_POINTS,
} from "../effects/player-tear-geometry.js";

type Point = readonly [number, number];
const polygon = (clip: string): Point[] =>
  [...clip.matchAll(/([\d.]+)% ([\d.]+)%/g)].map((match) => [
    Number(match[1]) / 100,
    Number(match[2]) / 100,
  ]);
const area = (points: readonly Point[]) =>
  Math.abs(
    points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length]!;
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0) / 2,
  );

describe("shared player tear geometry", () => {
  it("exports complementary full-card clips with the same seam traversed in opposite directions", () => {
    const left = polygon(PLAYER_TEAR_LEFT_CLIP);
    const right = polygon(PLAYER_TEAR_RIGHT_CLIP);
    expect(left.slice(1, -1)).toEqual(PLAYER_TEAR_SEAM_POINTS);
    expect(right.slice(2)).toEqual([...PLAYER_TEAR_SEAM_POINTS].reverse());
    expect(area(left) + area(right)).toBeCloseTo(1);
    expect(PLAYER_TEAR_SEAM_POINTS[0]).toEqual([0.5, 0]);
    expect(PLAYER_TEAR_SEAM_POINTS.at(-1)).toEqual([0.5, 1]);
    for (const [index, point] of PLAYER_TEAR_SEAM_POINTS.entries()) {
      expect(point[0]).toBeGreaterThan(0);
      expect(point[0]).toBeLessThan(1);
      if (index > 0) expect(point[1]).toBeGreaterThan(PLAYER_TEAR_SEAM_POINTS[index - 1]![1]);
    }
  });
});

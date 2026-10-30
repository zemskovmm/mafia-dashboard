/** Normalized full-card coordinates, top to bottom. Both fragments use the
 * SAME seam (the right polygon traverses it backwards), never a mirrored x.
 * Compress each clipped full-card half by 1 - gap / 100 * tear, with origins
 * 0% and 100%. This leaves exactly gap * tear percent between corresponding
 * seam points while keeping every fragment inside the original footprint. */
export const PLAYER_TEAR_SEAM_POINTS = [
  [0.5, 0],
  [0.47, 0.14],
  [0.53, 0.28],
  [0.48, 0.42],
  [0.54, 0.56],
  [0.47, 0.7],
  [0.52, 0.84],
  [0.5, 1],
] as const;

const percent = (point: readonly [number, number]) =>
  point.map((value) => `${Number((value * 100).toFixed(4))}%`).join(" ");
export const PLAYER_TEAR_LEFT_CLIP = `polygon(0% 0%, ${PLAYER_TEAR_SEAM_POINTS.map(percent).join(", ")}, 0% 100%)`;
export const PLAYER_TEAR_RIGHT_CLIP = `polygon(100% 0%, 100% 100%, ${[...PLAYER_TEAR_SEAM_POINTS].reverse().map(percent).join(", ")})`;

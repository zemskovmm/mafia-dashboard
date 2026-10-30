import type { PlayerExitPhase, PlayerExitSettings } from "./player-exit-preferences.js";

type Curve = readonly [number, number, number, number];
const linear: Curve = [1 / 3, 1 / 3, 2 / 3, 2 / 3];
const curves = {
  linear,
  in: [0.42, 0, 1, 1],
  out: [0, 0, 0.58, 1],
  "in-out": [0.42, 0, 0.58, 1],
} satisfies Record<string, Curve>;
const original: Record<PlayerExitPhase, Curve> = {
  lift: [0.2, 0.7, 0.3, 1],
  flip: [0, 0, 1, 1],
  drop: [0.65, 0, 1, 1],
};

export const playerExitCurve = (settings: PlayerExitSettings, phase: PlayerExitPhase): Curve => {
  const { easing, strength } = settings[phase];
  const target = easing === "original" ? original[phase] : curves[easing];
  return target.map((value, index) =>
    Number((linear[index]! + ((value - linear[index]!) * strength) / 100).toFixed(4)),
  ) as unknown as Curve;
};

const bezier = (t: number, first: number, second: number): number =>
  3 * (1 - t) ** 2 * t * first + 3 * (1 - t) * t ** 2 * second + t ** 3;

// Visibility must switch at 90 degrees, not halfway through elapsed time.
const halfwayTime = ([x1, y1, x2, y2]: Curve): number => {
  let low = 0;
  let high = 1;
  for (let index = 0; index < 40; index++) {
    const middle = (low + high) / 2;
    if (bezier(middle, y1, y2) < 0.5) low = middle;
    else high = middle;
  }
  return bezier((low + high) / 2, x1, x2);
};

export const playerExitMotion = (settings: PlayerExitSettings) => {
  const duration = settings.liftMs + settings.landingMs;
  const apex = settings.liftMs / duration;
  const flipStart = apex * (1 - settings.overlap / 100);
  const edge = flipStart + (1 - flipStart) * halfwayTime(playerExitCurve(settings, "flip"));
  const easing = (phase: PlayerExitPhase) =>
    `cubic-bezier(${playerExitCurve(settings, phase).join(",")})`;
  const lift: Keyframe[] = [
    { transform: "translateY(0) scale(1)", offset: 0, easing: easing("lift") },
    { transform: "translateY(-10px) scale(1.07)", offset: apex, easing: easing("drop") },
    { transform: "translateY(0) scale(1)", offset: 1 },
  ];
  // Individual rotation leaves the lift transform and existing speaker/voter scale independent.
  const turn: Keyframe[] = [
    ...(flipStart > 0 ? [{ rotate: "y 0deg", offset: 0 }] : []),
    { rotate: "y 0deg", offset: flipStart, easing: easing("flip") },
    { rotate: "y 180deg", offset: 1 },
  ];
  const front: Keyframe[] = [
    { visibility: "visible", offset: 0, easing: "steps(1, end)" },
    { visibility: "hidden", offset: edge },
    { visibility: "hidden", offset: 1 },
  ];
  const back: Keyframe[] = [
    { visibility: "hidden", offset: 0, easing: "steps(1, end)" },
    { visibility: "visible", offset: edge },
    { visibility: "visible", offset: 1 },
  ];
  // Directional reflections must match the upright resting surface. Change
  // their handedness only at the invisible edge, never when the host settles.
  const material: Keyframe[] = front.map(({ visibility, ...frame }) => ({
    ...frame,
    scale: visibility === "visible" ? "1 1" : "-1 1",
  }));
  return { duration, apex, flipStart, edge, lift, turn, front, back, material };
};

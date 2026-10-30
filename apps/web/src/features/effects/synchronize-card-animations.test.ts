import { afterEach, expect, it, vi } from "vitest";
import { synchronizeCardAnimations } from "./synchronize-card-animations.js";

const original = Object.getOwnPropertyDescriptor(document, "timeline");
const tracks = () =>
  Array.from({ length: 5 }, (): Pick<Animation, "currentTime" | "startTime"> => ({
    currentTime: null,
    startTime: null,
  }));

afterEach(() => {
  if (original) Object.defineProperty(document, "timeline", original);
  else Reflect.deleteProperty(document, "timeline");
  vi.restoreAllMocks();
});

it("anchors every track to the same native timeline epoch, without rebasing currentTime", () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(100);
  Object.defineProperty(document, "timeline", { configurable: true, value: { currentTime: 100 } });
  const animations = tracks();
  synchronizeCardAnimations(animations, 80);
  expect(animations.map((animation) => animation.startTime)).toEqual(Array(5).fill(80));
  expect(animations.every((animation) => animation.currentTime === null)).toBe(true);
  expect(now).toHaveBeenCalledTimes(1);
});

it.each([undefined, null, Number.NaN, Number.POSITIVE_INFINITY])(
  "uses one coherent elapsed-time fallback for unresolved clock %s",
  (currentTime) => {
    const now = vi.spyOn(performance, "now").mockReturnValue(100);
    Object.defineProperty(document, "timeline", { configurable: true, value: { currentTime } });
    const animations = tracks();
    synchronizeCardAnimations(animations, 80);
    expect(animations.map((animation) => animation.currentTime)).toEqual(Array(5).fill(20));
    expect(animations.every((animation) => animation.startTime === null)).toBe(true);
    expect(now).toHaveBeenCalledTimes(1);
  },
);

it("does not seek ahead of a future request epoch", () => {
  vi.spyOn(performance, "now").mockReturnValue(100);
  Object.defineProperty(document, "timeline", { configurable: true, value: { currentTime: 100 } });
  const animations = tracks();
  synchronizeCardAnimations(animations, 120);
  expect(animations.map((animation) => animation.startTime)).toEqual(Array(5).fill(100));
});

it("does not backdate a request when the document clock lags a busy frame", () => {
  vi.spyOn(performance, "now").mockReturnValue(165);
  Object.defineProperty(document, "timeline", { configurable: true, value: { currentTime: 120 } });
  const animations = tracks();
  synchronizeCardAnimations(animations, 110);
  expect(animations.map((animation) => animation.startTime)).toEqual(Array(5).fill(110));
});

import { describe, expect, it } from "vitest";
import { classifyPanelSwipe } from "./panel-swipe.js";

describe("classifyPanelSwipe", () => {
  it.each([
    ["up", { x: 20, y: 100 }, { x: 20, y: 40 }],
    ["down", { x: 20, y: 40 }, { x: 20, y: 100 }],
    ["left", { x: 100, y: 20 }, { x: 40, y: 20 }],
    ["right", { x: 40, y: 20 }, { x: 100, y: 20 }],
  ] as const)("classifies a dominant %s swipe over the threshold", (direction, start, end) => {
    expect(classifyPanelSwipe(start, end)).toBe(direction);
  });

  it("rejects movement exactly under the default threshold", () => {
    expect(classifyPanelSwipe({ x: 0, y: 0 }, { x: 43, y: 0 })).toBeNull();
  });

  it("accepts movement exactly at the threshold", () => {
    expect(classifyPanelSwipe({ x: 0, y: 0 }, { x: 44, y: 0 })).toBe("right");
  });

  it("uses a custom threshold", () => {
    expect(classifyPanelSwipe({ x: 0, y: 0 }, { x: 59, y: 0 }, 60)).toBeNull();
    expect(classifyPanelSwipe({ x: 0, y: 0 }, { x: 60, y: 0 }, 60)).toBe("right");
  });

  it("rejects diagonal movement without a sufficiently dominant axis", () => {
    expect(classifyPanelSwipe({ x: 0, y: 0 }, { x: 60, y: 55 })).toBeNull();
  });

  it("requires dominance to be strictly greater than a 1.25 ratio", () => {
    expect(classifyPanelSwipe({ x: 0, y: 0 }, { x: 50, y: 40 })).toBeNull();
    expect(classifyPanelSwipe({ x: 0, y: 0 }, { x: 40, y: 50 })).toBeNull();
  });

  it("classifies vertical movement with small horizontal drift", () => {
    expect(classifyPanelSwipe({ x: 20, y: 100 }, { x: 24, y: 40 })).toBe("up");
    expect(classifyPanelSwipe({ x: 20, y: 40 }, { x: 16, y: 100 })).toBe("down");
  });

  it("classifies horizontal movement with small vertical drift", () => {
    expect(classifyPanelSwipe({ x: 100, y: 20 }, { x: 40, y: 24 })).toBe("left");
    expect(classifyPanelSwipe({ x: 40, y: 20 }, { x: 100, y: 16 })).toBe("right");
  });
});

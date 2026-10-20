import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FancyFeaturesContext } from "../effects/FancyFeaturesContext.js";
import { ActivationGlassSweep } from "./ActivationGlassSweep.js";

const animations: Animation[] = [];
const animate = vi.fn(() => {
  const animation = { cancel: vi.fn(), onfinish: null } as unknown as Animation;
  animations.push(animation);
  return animation;
});
const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
const media = new Map<string, MediaQueryList>();

beforeEach(() => {
  animations.length = 0;
  animate.mockClear();
  media.clear();
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      const preference = media.get(query) ?? Object.assign(new EventTarget(), { matches: false });
      media.set(query, preference as MediaQueryList);
      return preference;
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (originalAnimate === undefined) Reflect.deleteProperty(HTMLElement.prototype, "animate");
  else Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
});

describe("ActivationGlassSweep", () => {
  it("skips all sweep work while Fancy is off and cancels active work without replacing controls", () => {
    const onClick = vi.fn();
    const fixture = (fancy: boolean) => (
      <FancyFeaturesContext.Provider value={fancy}>
        <button onClick={onClick}>
          <ActivationGlassSweep />
          Start timer
        </button>
        <input aria-label="Draft" defaultValue="kept" />
      </FancyFeaturesContext.Provider>
    );
    const { container, rerender, unmount } = render(fixture(false));
    const button = screen.getByRole("button", { name: "Start timer" });
    const draft = screen.getByRole("textbox", { name: "Draft" });
    expect(container.querySelector(".activation-glass-sweep")).toBeNull();
    expect(window.matchMedia).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
    expect(animate).not.toHaveBeenCalled();

    rerender(fixture(true));
    fireEvent.click(button);
    expect(animations).toHaveLength(1);
    const preferences = [...media.values()];
    const removals = preferences.map((preference) => vi.spyOn(preference, "removeEventListener"));
    rerender(fixture(false));
    expect(animations[0]?.cancel).toHaveBeenCalledOnce();
    for (const remove of removals)
      expect(remove).toHaveBeenCalledWith("change", expect.any(Function));
    fireEvent.click(button);
    expect(animations).toHaveLength(1);
    expect(container.querySelector(".liquid-card-glass__light")).toBeNull();

    rerender(fixture(true));
    expect(animations).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Start timer" })).toBe(button);
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
    expect(draft).toHaveValue("kept");
    fireEvent.click(button);
    expect(animations).toHaveLength(2);
    expect(onClick).toHaveBeenCalledTimes(4);
    unmount();
    expect(animations[1]?.cancel).toHaveBeenCalledOnce();
  });

  it("retains disabled and live reduced-preference constraints", () => {
    const { rerender } = render(
      <button>
        <ActivationGlassSweep disabled />
        Start timer
      </button>,
    );
    const button = screen.getByRole("button", { name: "Start timer" });
    fireEvent.click(button);
    expect(animate).not.toHaveBeenCalled();
    rerender(
      <button>
        <ActivationGlassSweep />
        Start timer
      </button>,
    );
    fireEvent.click(button);
    expect(animations).toHaveLength(1);
    const motion = media.get("(prefers-reduced-motion: reduce)")!;
    act(() => {
      Object.assign(motion, { matches: true });
      motion.dispatchEvent(new Event("change"));
    });
    expect(animations[0]?.cancel).toHaveBeenCalledOnce();
    fireEvent.click(button);
    expect(animations).toHaveLength(1);
    Object.assign(motion, { matches: false });
    Object.assign(media.get("(prefers-reduced-transparency: reduce)")!, { matches: true });
    fireEvent.click(button);
    expect(animations).toHaveLength(1);
  });
});

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenTutorial } from "./ScreenTutorial.js";

const slides = [
  {
    title: "First slide",
    body: "Harmless instructions",
    target: ".demo-control",
    exampleLabel: "Example control",
  },
  {
    title: "Last slide",
    body: "Second instructions",
    target: ".demo-control",
    exampleLabel: "Example control",
  },
] as const;
afterEach(() => vi.restoreAllMocks());
const geometry = () =>
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.matches("dialog")) return new DOMRect(0, 0, 1200, 800);
    if (this.matches(".role-tutorial-callout")) return new DOMRect(0, 0, 340, 300);
    return new DOMRect(80, 80, 100, 100);
  });

describe("ScreenTutorial presentation", () => {
  it.each([
    "absent",
    "disabled",
    "disabled-fieldset",
    "aria-disabled",
    "hidden",
    "offscreen",
    "clipped",
    "collapsed",
  ])("uses a labeled example for an %s target", async (state) => {
    const user = userEvent.setup();
    render(
      <main>
        <fieldset
          disabled={state === "disabled-fieldset"}
          style={state === "clipped" ? { overflow: "hidden" } : undefined}
        >
          <details open={state !== "collapsed"}>
            <summary>Tools</summary>
            {state !== "absent" && (
              <button
                type="button"
                className="demo-control"
                aria-disabled={state === "aria-disabled" || undefined}
                disabled={state === "disabled"}
                hidden={state === "hidden"}
              >
                Real action
              </button>
            )}
          </details>
        </fieldset>
        <ScreenTutorial helpLabel="Help" title="Guide" slides={slides} />
      </main>,
    );
    geometry().mockImplementation(function (this: HTMLElement) {
      if (this.matches("dialog")) return new DOMRect(0, 0, 1200, 800);
      if (this.matches(".role-tutorial-callout")) return new DOMRect(0, 0, 340, 300);
      if (this.matches("fieldset") && state === "clipped") return new DOMRect(0, 0, 40, 40);
      return new DOMRect(state === "offscreen" ? 1300 : 80, 80, 100, 100);
    });
    await user.click(screen.getByRole("button", { name: "Help" }));
    expect(
      within(screen.getByRole("dialog")).getByRole("img", { name: "Example control" }),
    ).toBeVisible();
    expect(document.querySelector(".role-tutorial-target[data-example='false']")).toBeNull();
  });

  it("keeps hand artwork above a live control near the viewport bottom", async () => {
    const user = userEvent.setup();
    render(
      <main>
        <button type="button" className="demo-control">
          Real action
        </button>
        <ScreenTutorial helpLabel="Help" title="Guide" slides={slides} />
      </main>,
    );
    geometry().mockImplementation(function (this: HTMLElement) {
      if (this.matches("dialog")) return new DOMRect(0, 0, 1200, 800);
      if (this.matches(".role-tutorial-callout")) return new DOMRect(0, 0, 340, 300);
      return new DOMRect(80, 730, 100, 48);
    });
    await user.click(screen.getByRole("button", { name: "Help" }));
    expect(document.querySelector(".role-tutorial-target")).toHaveAttribute(
      "data-hand-above",
      "true",
    );
  });

  it("rechecks visibility after scroll instead of leaving a hand at an offscreen control", async () => {
    const user = userEvent.setup();
    render(
      <main>
        <button type="button" className="demo-control">
          Real action
        </button>
        <ScreenTutorial helpLabel="Help" title="Guide" slides={slides} />
      </main>,
    );
    const bounds = geometry();
    await user.click(screen.getByRole("button", { name: "Help" }));
    expect(document.querySelector(".role-tutorial-target[data-example='false']")).not.toBeNull();
    bounds.mockImplementation(function (this: HTMLElement) {
      if (this.matches("dialog")) return new DOMRect(0, 0, 1200, 800);
      if (this.matches(".role-tutorial-callout")) return new DOMRect(0, 0, 340, 300);
      return new DOMRect(-120, 0, 100, 100);
    });
    fireEvent.scroll(window);
    expect(
      within(screen.getByRole("dialog")).getByRole("img", { name: "Example control" }),
    ).toBeVisible();
  });

  it("mounts within fullscreen and retains bounded swipes with no target activation", async () => {
    const user = userEvent.setup();
    const action = vi.fn();
    const { container } = render(
      <main>
        <button type="button" className="demo-control" onClick={action}>
          Real action
        </button>
        <ScreenTutorial helpLabel="Help" title="Guide" slides={slides} />
      </main>,
    );
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: container });
    try {
      await user.click(screen.getByRole("button", { name: "Help" }));
      const dialog = screen.getByRole("dialog");
      expect(container).toContainElement(dialog);
      const pointer = (type: string, x: number, y = 100, id = 1) => {
        const event = new Event(type, { bubbles: true });
        Object.assign(event, {
          clientX: x,
          clientY: y,
          pointerId: id,
          isPrimary: id === 1,
          button: 0,
        });
        fireEvent(dialog, event);
      };
      for (const interruption of [
        "pointercancel",
        "lostpointercapture",
        "second-pointer",
        "vertical",
        "short",
      ]) {
        pointer("pointerdown", 200);
        if (interruption === "second-pointer") pointer("pointerdown", 190, 100, 2);
        else if (interruption === "pointercancel" || interruption === "lostpointercapture")
          pointer(interruption, 200);
        pointer(
          "pointerup",
          interruption === "short" ? 190 : 100,
          interruption === "vertical" ? 300 : 100,
        );
        expect(dialog).toHaveTextContent("First slide");
      }
      for (let i = 0; i < 3; i++) {
        pointer("pointerdown", 200);
        pointer("pointerup", 100);
        fireEvent.click(dialog);
      }
      expect(dialog).toHaveTextContent("Last slide");
      for (let i = 0; i < 3; i++) {
        pointer("pointerdown", 100);
        pointer("pointerup", 200);
      }
      expect(dialog).toHaveTextContent("First slide");
      expect(action).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
    }
  });
});

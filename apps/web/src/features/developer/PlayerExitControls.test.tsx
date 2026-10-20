import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { FancyFeaturesContext } from "../effects/FancyFeaturesContext.js";
import {
  DEFAULT_PLAYER_EXIT_SETTINGS,
  type PlayerExitSettings,
} from "../effects/player-exit-preferences.js";
import { PlayerExitControls } from "./PlayerExitControls.js";

const Harness = ({ changed }: { changed: (settings: PlayerExitSettings) => void }) => {
  const [settings, setSettings] = useState(DEFAULT_PLAYER_EXIT_SETTINGS);
  return (
    <PlayerExitControls
      settings={settings}
      onChange={(next) => {
        setSettings(next);
        changed(next);
      }}
    />
  );
};

describe("player exit controls", () => {
  describe("effective Fancy policy through the real preview animation", () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
    let animations: Array<{ cancel: ReturnType<typeof vi.fn>; finish: () => void }>;
    let animate: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      animations = [];
      animate = vi.fn(() => {
        let finish!: () => void;
        let reject!: (reason: unknown) => void;
        const finished = new Promise<void>((resolve, fail) => {
          finish = resolve;
          reject = fail;
        });
        const animation = {
          finished,
          finish,
          cancel: vi.fn(() => reject(new DOMException("Cancelled", "AbortError"))),
        };
        animations.push(animation);
        return animation;
      });
      Object.defineProperty(HTMLElement.prototype, "animate", {
        configurable: true,
        value: animate,
      });
    });

    afterEach(() => {
      cleanup();
      if (descriptor) Object.defineProperty(HTMLElement.prototype, "animate", descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, "animate");
      vi.restoreAllMocks();
    });

    it("cancels a running preview on OFF, retains child tuning and permits only a fresh ON preview", async () => {
      const changed = vi.fn();
      const fixture = (enabled: boolean) => (
        <FancyFeaturesContext.Provider value={enabled}>
          <Harness changed={changed} />
        </FancyFeaturesContext.Provider>
      );
      const { container, rerender } = render(fixture(true));
      fireEvent.click(screen.getByText("Player exit animation", { selector: "summary" }));
      fireEvent.change(screen.getByLabelText("Lift duration"), { target: { value: "260" } });
      fireEvent.change(screen.getByLabelText("Drop easing strength"), {
        target: { value: "35" },
      });
      const changes = changed.mock.calls.length;
      const preview = screen.getByRole("button", { name: "Preview exit" });
      const card = container.querySelector(".player-exit-preview .player-seat");
      fireEvent.click(preview);
      expect(animate).toHaveBeenCalledTimes(5);
      expect(container.querySelectorAll(".player-exit-face")).toHaveLength(2);

      rerender(fixture(false));
      expect(animations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true);
      expect(container.querySelectorAll(".player-exit-face")).toHaveLength(0);
      expect(container.querySelectorAll(".player-exit-preview .seat-name")).toHaveLength(1);
      expect(container.querySelectorAll(".player-exit-preview .deceased-cross")).toHaveLength(1);
      expect(card).toHaveClass("status-eliminated");
      expect(card).not.toHaveClass("is-exiting");
      expect(screen.getByLabelText("Lift duration")).toHaveValue("260");
      expect(screen.getByLabelText("Drop easing strength")).toHaveValue("35");
      expect(screen.getByRole("button", { name: "Disable player exit animation" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(changed).toHaveBeenCalledTimes(changes);

      rerender(fixture(true));
      expect(animate).toHaveBeenCalledTimes(5);
      expect(container.querySelector(".player-exit-preview .player-seat")).toBe(card);
      expect(card).not.toHaveClass("is-exiting");
      fireEvent.click(preview);
      expect(animate).toHaveBeenCalledTimes(10);
      // Cancellation rejects finished asynchronously; the old callback must not settle this preview.
      await act(async () => {});
      expect(card).toHaveClass("is-exiting");
      expect(container.querySelectorAll(".player-exit-face")).toHaveLength(2);
      await act(async () => animations.slice(5).forEach((animation) => animation.finish()));
      expect(card).not.toHaveClass("is-exiting");
      expect(container.querySelectorAll(".player-exit-preview .deceased-cross")).toHaveLength(1);
      expect(animations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true);
      expect(changed).toHaveBeenCalledTimes(changes);
    });

    it("settles cold-OFF previews without animation and preserves a disabled child choice on ON", () => {
      const changed = vi.fn();
      const fixture = (enabled: boolean) => (
        <FancyFeaturesContext.Provider value={enabled}>
          <Harness changed={changed} />
        </FancyFeaturesContext.Provider>
      );
      const { container, rerender } = render(fixture(false));
      fireEvent.click(screen.getByText("Player exit animation", { selector: "summary" }));
      const preview = screen.getByRole("button", { name: "Preview exit" });
      fireEvent.click(preview);
      fireEvent.click(preview);
      expect(animate).not.toHaveBeenCalled();
      expect(container.querySelectorAll(".player-exit-face")).toHaveLength(0);
      expect(container.querySelectorAll(".player-exit-preview .seat-name")).toHaveLength(1);
      expect(container.querySelectorAll(".player-exit-preview .deceased-cross")).toHaveLength(1);
      expect(container.querySelector(".player-exit-preview .player-seat")).toHaveClass(
        "status-eliminated",
      );
      expect(container.querySelector(".is-exiting")).toBeNull();
      expect(changed).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Disable player exit animation" }));
      expect(changed).toHaveBeenCalledExactlyOnceWith({
        ...DEFAULT_PLAYER_EXIT_SETTINGS,
        enabled: false,
      });
      rerender(fixture(true));
      fireEvent.click(preview);
      expect(animate).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Lift duration")).toBeDisabled();
      expect(changed).toHaveBeenCalledTimes(1);
      expect(container.querySelector(".is-exiting")).toBeNull();
      expect(container.querySelectorAll(".player-exit-preview .deceased-cross")).toHaveLength(1);
    });
  });

  it("shows exact timings, keeps preview harmless, updates independent controls and resets", async () => {
    const changed = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<Harness changed={changed} />);
    await user.click(screen.getByText("Player exit animation", { selector: "summary" }));
    expect(
      screen.getByText("Flip starts at 0 ms; drop starts at 100 ms. Both land at 580 ms."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Preview exit" }));
    expect(container.querySelector(".player-exit-preview .deceased-cross")).toBeInTheDocument();
    expect(changed).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Lift / flip overlap"), { target: { value: "0" } });
    expect(changed).toHaveBeenLastCalledWith({ ...DEFAULT_PLAYER_EXIT_SETTINGS, overlap: 0 });
    expect(
      screen.getByText("Flip starts at 100 ms; drop starts at 100 ms. Both land at 580 ms."),
    ).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Flip easing"), "linear");
    expect(screen.getByLabelText("Flip easing strength")).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Drop easing"), "in");
    fireEvent.change(screen.getByLabelText("Drop easing strength"), { target: { value: "35" } });
    expect(changed).toHaveBeenLastCalledWith({
      ...DEFAULT_PLAYER_EXIT_SETTINGS,
      overlap: 0,
      flip: { easing: "linear", strength: 100 },
      drop: { easing: "in", strength: 35 },
    });
    await user.click(screen.getByRole("button", { name: "Disable player exit animation" }));
    expect(screen.getByLabelText("Lift duration")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Reset exit animation settings" }));
    expect(changed).toHaveBeenLastCalledWith(DEFAULT_PLAYER_EXIT_SETTINGS);
    expect(screen.getByLabelText("Lift duration")).toHaveValue("100");
    expect(screen.getByLabelText("Landing duration")).toHaveValue("480");
    expect(screen.getByLabelText("Lift / flip overlap")).toHaveValue("100");
    expect(screen.getByLabelText("Flip easing strength")).toBeEnabled();
  });

  it("localizes the section, resolved timings, curves and actions in Russian", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider locale="ru">
        <Harness changed={vi.fn()} />
      </I18nProvider>,
    );
    await user.click(screen.getByText("Анимация ухода игрока", { selector: "summary" }));
    expect(screen.getByLabelText("Длительность подъёма")).toHaveValue("100");
    expect(screen.getByLabelText("Перекрытие подъёма и переворота")).toHaveValue("100");
    expect(screen.getByLabelText("Переворот: плавность")).toHaveValue("out");
    expect(
      screen.getByText(
        "Переворот начинается на 0 мс, опускание — на 100 мс. Оба завершаются на 580 мс.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Посмотреть анимацию" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Сбросить настройки анимации ухода" }),
    ).toBeInTheDocument();
  });
});

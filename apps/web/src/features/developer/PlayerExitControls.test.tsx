import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { FancyFeaturesContext } from "../effects/FancyFeaturesContext.js";
import { playerDepartureTimeline } from "../effects/player-departure-timeline.js";
import {
  DEFAULT_PLAYER_EXIT_SETTINGS,
  type PlayerExitSettings,
} from "../effects/player-exit-preferences.js";
import { PlayerExitControls } from "./PlayerExitControls.js";

const PREVIEW_CASES = (["glass", "classic", "heritage", "noir"] as const).flatMap((style) =>
  (
    [
      "unknown",
      "mafia",
      "vote",
      "foul1",
      "foul2",
      "foul3",
      "fourth-foul",
      "exclusion",
      "opposing-result",
    ] as const
  ).map((action) => ({ style, action })),
);

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
      animate = vi.fn(function (this: HTMLElement) {
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
      vi.unstubAllGlobals();
    });

    it.each(
      PREVIEW_CASES.flatMap((entry) =>
        (["fancy-off", "reduced-motion", "unavailable"] as const).map((mode) => ({
          ...entry,
          mode,
        })),
      ),
    )("settles $style / $action to its endpoint with $mode", ({ style, action, mode }) => {
      if (mode === "reduced-motion")
        vi.stubGlobal(
          "matchMedia",
          vi.fn(() => ({ matches: true })),
        );
      if (mode === "unavailable")
        Object.defineProperty(HTMLElement.prototype, "animate", {
          configurable: true,
          value: undefined,
        });
      const changed = vi.fn();
      const { container } = render(
        <FancyFeaturesContext.Provider value={mode !== "fancy-off"}>
          <Harness changed={changed} />
        </FancyFeaturesContext.Provider>,
      );
      fireEvent.click(screen.getByText("Player exit animation", { selector: "summary" }));
      fireEvent.change(screen.getByLabelText("Preview card style"), { target: { value: style } });
      fireEvent.change(screen.getByLabelText("Preview action"), { target: { value: action } });
      fireEvent.click(screen.getByRole("button", { name: "Preview exit" }));
      expect(animate).not.toHaveBeenCalled();
      const card = container.querySelector<HTMLElement>(".player-exit-preview .player-seat")!;
      expect(card).not.toHaveClass("is-exiting");
      const departed = ["unknown", "mafia", "vote", "fourth-foul", "exclusion"].includes(action);
      expect(card.style.getPropertyValue("--player-exit-fade")).toBe(departed ? "0.45" : "1");
      if (action === "mafia") expect(card.querySelectorAll(".player-bullet-hole")).toHaveLength(3);
      if (action === "vote") expect(card.querySelectorAll(".player-torn-fragment")).toHaveLength(2);
      if (action === "fourth-foul" || action === "exclusion")
        expect(card.querySelectorAll(".player-disciplinary-ribbon")).toHaveLength(1);
      if (action.startsWith("foul") || action === "opposing-result") {
        expect(card).toHaveClass("status-active");
        expect(container.querySelector("[data-preview-state]")).toHaveTextContent(
          "1/1 active · 0 departures",
        );
      } else {
        expect(container.querySelector("[data-preview-state]")).toHaveTextContent(
          "0/1 active · 1 departures",
        );
      }
      expect(changed).not.toHaveBeenCalled();
    });

    it.each(PREVIEW_CASES)(
      "previews $action with the real $style renderer and retains its honest endpoint",
      async ({ style, action }) => {
        const changed = vi.fn();
        const saved = vi.spyOn(Storage.prototype, "setItem");
        const { container } = render(<Harness changed={changed} />);
        fireEvent.click(screen.getByText("Player exit animation", { selector: "summary" }));
        fireEvent.change(screen.getByLabelText("Preview card style"), { target: { value: style } });
        fireEvent.change(screen.getByLabelText("Preview action"), { target: { value: action } });
        expect(animate).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Preview exit" }));
        const card = container.querySelector<HTMLElement>(".player-exit-preview .player-seat")!;
        expect(card).toHaveAttribute("data-card-style", style);
        expect(card.querySelector(".seat-name,.printed-player-card__name")).toBeNull();
        expect(card.nextElementSibling).toHaveClass("player-seat-caption");
        expect(card.nextElementSibling).toHaveTextContent(card.getAttribute("aria-label")!);
        if (style === "glass") {
          expect(card.firstElementChild).toHaveClass("liquid-card-glass");
          expect(card.querySelectorAll(":scope > .liquid-card-glass")).toHaveLength(1);
          expect(card.querySelector(".player-exit-back .seat-name")).toBeNull();
        } else {
          expect(card.querySelector(".liquid-card-glass")).toBeNull();
          expect(card.querySelector(`.printed-player-card--${style}`)).toBeInTheDocument();
        }
        const departed = ["unknown", "mafia", "vote", "fourth-foul", "exclusion"].includes(action);
        expect(card.classList.contains("status-active")).toBe(!departed);
        expect(card.classList.contains("is-exiting")).toBe(departed);
        expect(animate).toHaveBeenCalled();
        const targets = animate.mock.instances as HTMLElement[];
        if (action.startsWith("foul")) {
          const number = Number(action.slice(-1));
          expect(card.querySelectorAll(".foul-dot")).toHaveLength(number);
          expect(targets[0]).toBe(card.querySelector(`.foul-dot:nth-child(${number})`));
          expect(animate).toHaveBeenCalledTimes(number === 3 ? 2 : 1);
          expect(Boolean(card.querySelector(".card-mute"))).toBe(number === 3);
        }
        if (action === "opposing-result") {
          expect(card).not.toHaveAttribute("data-departure-cause");
          expect(
            card.querySelector(
              ".deceased-cross,.player-disciplinary-ribbon,.player-bullet-hole,.player-torn-fragment",
            ),
          ).toBeNull();
          expect(animate).toHaveBeenCalledTimes(1);
          expect(targets[0]).toHaveClass("winner-card");
          expect(screen.getByText("Opposing team wins")).toBeInTheDocument();
        }
        await act(async () => animations.forEach((animation) => animation.finish()));
        expect(card).not.toHaveClass("is-exiting");
        expect(card.style.getPropertyValue("--player-exit-fade")).toBe(departed ? "0.45" : "1");
        if (action === "mafia")
          expect(card.querySelectorAll(".player-bullet-hole")).toHaveLength(3);
        if (action === "vote") {
          expect(card.querySelectorAll(".player-torn-fragment")).toHaveLength(2);
          expect(card.style.getPropertyValue("--player-exit-gap")).toBe("6");
          expect(card.style.getPropertyValue("--player-exit-fade")).toBe("0.45");
        }
        if (action === "fourth-foul" || action === "exclusion") {
          expect(card.querySelectorAll(".player-disciplinary-ribbon")).toHaveLength(1);
          expect(card).toHaveClass("status-red-carded");
        }
        const count = animate.mock.calls.length;
        fireEvent.click(screen.getByRole("button", { name: "Preview exit" }));
        expect(animate.mock.calls.length).toBeGreaterThan(count);
        expect(changed).not.toHaveBeenCalled();
        expect(saved).not.toHaveBeenCalled();
      },
    );

    it("captures motion and endpoint settings until replay and does not replay on style changes", async () => {
      const { container } = render(<Harness changed={vi.fn()} />);
      fireEvent.click(screen.getByText("Player exit animation", { selector: "summary" }));
      fireEvent.change(screen.getByLabelText("Preview action"), { target: { value: "vote" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview exit" }));
      const count = animate.mock.calls.length;
      const card = container.querySelector<HTMLElement>(".player-exit-preview .player-seat")!;
      fireEvent.change(screen.getByLabelText("Tear duration"), { target: { value: "700" } });
      fireEvent.change(screen.getByLabelText("Final departed-card opacity"), {
        target: { value: "60" },
      });
      expect(animate).toHaveBeenCalledTimes(count);
      expect(card.style.getPropertyValue("--player-exit-fade")).toBe("0.45");
      await act(async () => animations.forEach((animation) => animation.finish()));
      fireEvent.change(screen.getByLabelText("Preview card style"), {
        target: { value: "classic" },
      });
      expect(animate).toHaveBeenCalledTimes(count);
      expect(card.querySelectorAll(".player-torn-fragment")).toHaveLength(2);
      expect(card.style.getPropertyValue("--player-exit-fade")).toBe("0.45");
      fireEvent.click(screen.getByRole("button", { name: "Preview exit" }));
      expect(animate.mock.calls.length).toBeGreaterThan(count);
      expect(card.style.getPropertyValue("--player-exit-fade")).toBe("0.6");
      const replayCount = animate.mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: "Reset exit animation settings" }));
      expect(animate).toHaveBeenCalledTimes(replayCount);
      expect(card.style.getPropertyValue("--player-exit-fade")).toBe("0.6");
      expect(screen.getByText("Next preview · total 1300 ms")).toBeInTheDocument();
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
      expect(animate).toHaveBeenCalledTimes(6);
      expect(animate.mock.contexts[4]).toBe(card?.querySelector(":scope > .liquid-card-glass"));
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
      expect(animate).toHaveBeenCalledTimes(6);
      expect(container.querySelector(".player-exit-preview .player-seat")).toBe(card);
      expect(card).not.toHaveClass("is-exiting");
      fireEvent.click(preview);
      expect(animate).toHaveBeenCalledTimes(12);
      // Cancellation rejects finished asynchronously; the old callback must not settle this preview.
      await act(async () => {});
      expect(card).toHaveClass("is-exiting");
      expect(container.querySelectorAll(".player-exit-face")).toHaveLength(2);
      await act(async () => animations.slice(6).forEach((animation) => animation.finish()));
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

  it.each([
    ["unknown", "Lift starts at 0 ms; flip at 0 ms; drop at 100 ms. Turn completes at 580 ms."],
    ["mafia", "Three impacts at 34, 168 and 302 ms. Impact phase: 0–420 ms, before the turn."],
    ["vote", "Intact turn: 0–580 ms. Tear: 580–940 ms. Fade: 940–1300 ms."],
    ["fourth-foul", "Red-card cue: 0–600 ms, then the departure turn and lasting ribbon."],
    [
      "exclusion",
      "Lift starts at 600 ms; flip at 600 ms; drop at 700 ms. Turn completes at 1180 ms.",
    ],
    ["foul1", "Feedback: 0–600 ms. No departure turn, tear or fade."],
    ["foul2", "Feedback: 0–600 ms. No departure turn, tear or fade."],
    ["foul3", "Feedback: 0–600 ms. No departure turn, tear or fade."],
    ["opposing-result", "Feedback: 0–600 ms. No departure turn, tear or fade."],
  ])("shows the complete resolved %s timeline", (action, phases) => {
    const { unmount } = render(<Harness changed={vi.fn()} />);
    fireEvent.click(screen.getByText("Player exit animation", { selector: "summary" }));
    fireEvent.change(screen.getByLabelText("Preview action"), { target: { value: action } });
    const cause =
      action === "unknown" || action === "mafia" || action === "vote"
        ? action
        : action === "exclusion" || action === "fourth-foul"
          ? "discipline"
          : undefined;
    const clock = playerDepartureTimeline(DEFAULT_PLAYER_EXIT_SETTINGS, cause);
    const total = cause ? clock.duration : DEFAULT_PLAYER_EXIT_SETTINGS.disciplineMs;
    expect(screen.getByText(`Next preview · total ${total} ms`)).toBeInTheDocument();
    expect(screen.getByText(phases)).toBeInTheDocument();
    if (cause && cause !== "vote") {
      expect(
        screen.getByText(`Fade: ${clock.fadeStart}–${clock.duration} ms.`),
      ).toBeInTheDocument();
    }
    unmount();
  });

  it("bounds and resets all added fields without overwriting independent turn choices", () => {
    const changed = vi.fn();
    const { unmount } = render(<Harness changed={changed} />);
    fireEvent.click(screen.getByText("Player exit animation", { selector: "summary" }));
    fireEvent.change(screen.getByLabelText("Lift duration"), { target: { value: "260" } });
    fireEvent.change(screen.getByLabelText("Flip easing"), { target: { value: "original" } });
    for (const [name, key, min, max, value] of [
      ["Three-impact duration", "impactMs", "240", "900", "800"],
      ["Tear duration", "tearMs", "200", "800", "700"],
      ["Departure fade duration", "fadeMs", "200", "900", "600"],
      ["Discipline cue duration", "disciplineMs", "300", "1000", "500"],
      ["Tear gap (% of card width)", "gap", "2", "12", "8"],
      ["Final departed-card opacity", "finalOpacity", "25", "70", "60"],
    ] as const) {
      const input = screen.getByLabelText(name);
      expect(input).toHaveAttribute("min", min);
      expect(input).toHaveAttribute("max", max);
      fireEvent.change(input, { target: { value } });
      expect(changed).toHaveBeenLastCalledWith(
        expect.objectContaining({
          [key]: Number(value),
          liftMs: 260,
          flip: { easing: "original", strength: 100 },
        }),
      );
    }
    fireEvent.change(screen.getByLabelText("Preview action"), { target: { value: "vote" } });
    expect(screen.getByText("Next preview · total 2040 ms")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Disable player exit animation" }));
    expect(screen.getByLabelText("Tear duration")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Reset exit animation settings" }));
    expect(changed).toHaveBeenLastCalledWith(DEFAULT_PLAYER_EXIT_SETTINGS);
    expect(screen.getByLabelText("Three-impact duration")).toHaveValue("420");
    expect(screen.getByLabelText("Tear duration")).toHaveValue("360");
    expect(screen.getByLabelText("Departure fade duration")).toHaveValue("360");
    expect(screen.getByLabelText("Discipline cue duration")).toHaveValue("600");
    expect(screen.getByLabelText("Tear gap (% of card width)")).toHaveValue("6");
    expect(screen.getByLabelText("Final departed-card opacity")).toHaveValue("45");
    expect(screen.getByText("Next preview · total 1300 ms")).toBeInTheDocument();
    unmount();
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
    for (const [name, value] of [
      ["Длительность трёх попаданий", "420"],
      ["Длительность разрыва", "360"],
      ["Длительность затухания карты при уходе", "360"],
      ["Длительность дисциплинарного сигнала", "600"],
      ["Зазор разрыва (% ширины карты)", "6"],
      ["Конечная непрозрачность карты ушедшего игрока", "45"],
    ])
      expect(screen.getByLabelText(name!)).toHaveValue(value);
    expect(screen.getByLabelText("Стиль карты для просмотра")).toHaveValue("glass");
    expect(screen.getByLabelText("Действие для просмотра")).toHaveValue("unknown");
    for (const name of [
      "Стекло",
      "Французская классика",
      "Старинная гравюра",
      "Нуар Рояль",
      "Убийство мафией",
      "Уход по голосованию города",
      "Первый фол",
      "Второй фол",
      "Третий фол · ожидающее ограничение речи",
      "Четвёртый фол · удаление",
      "Прямое удаление",
      "Победа противоположной команды",
    ])
      expect(screen.getByRole("option", { name })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Действие для просмотра"), "vote");
    expect(screen.getByText("Следующий просмотр · всего 1300 мс")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Переворот целой карты: 0–580 мс. Разрыв: 580–940 мс. Затухание: 940–1300 мс.",
      ),
    ).toBeInTheDocument();
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

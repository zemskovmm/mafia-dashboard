import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider.js";
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

import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import {
  DEFAULT_PLAYER_CARD_PREFERENCES,
  writePlayerCardPreferences,
  type PlayerCardPreferences,
} from "./player-card-preferences.js";
import { PlayerCardStyleControls } from "./PlayerCardStyleControls.js";

const Harness = ({
  changed,
  persist = false,
}: {
  changed: (settings: PlayerCardPreferences) => void;
  persist?: boolean;
}) => {
  const [settings, setSettings] = useState(DEFAULT_PLAYER_CARD_PREFERENCES);
  return (
    <PlayerCardStyleControls
      settings={settings}
      onChange={(next) => {
        if (persist) writePlayerCardPreferences(next);
        setSettings(next);
        changed(next);
      }}
    />
  );
};

const languages = [
  {
    locale: "en",
    section: "Player cards",
    style: "Player card style",
    placement: "Role placement",
    styles: ["Glass", "French Classic", "Old-world Engraved", "Noir Royale"],
    placements: ["Lower on card", "Role band", "Near top"],
  },
  {
    locale: "ru",
    section: "Карточки игроков",
    style: "Стиль карточек игроков",
    placement: "Расположение роли",
    styles: ["Стекло", "Французская классика", "Старинная гравюра", "Нуар Рояль"],
    placements: ["Внизу карточки", "Полоса роли", "Вверху"],
  },
] as const;

afterEach(() => vi.restoreAllMocks());

describe("PlayerCardStyleControls", () => {
  it.each(languages)(
    "offers four native localized styles and retains printed placement through Glass ($locale)",
    async (labels) => {
      const user = userEvent.setup();
      const changed = vi.fn();
      render(
        <I18nProvider locale={labels.locale}>
          <Harness changed={changed} />
        </I18nProvider>,
      );
      const group = screen.getByRole("group", { name: labels.section });
      const style = within(group).getByRole("combobox", { name: labels.style });
      expect(style.tagName).toBe("SELECT");
      expect(style).toHaveValue("glass");
      expect(
        within(style)
          .getAllByRole("option")
          .map((option) => option.textContent),
      ).toEqual(labels.styles);
      expect(screen.queryByRole("combobox", { name: labels.placement })).not.toBeInTheDocument();
      expect(changed).not.toHaveBeenCalled();

      await user.selectOptions(style, "classic");
      const placement = screen.getByRole("combobox", { name: labels.placement });
      expect(placement.tagName).toBe("SELECT");
      expect(placement).toHaveValue("below");
      expect(
        within(placement)
          .getAllByRole("option")
          .map((option) => option.textContent),
      ).toEqual(labels.placements);
      expect(changed).toHaveBeenLastCalledWith({ style: "classic", rolePlacement: "below" });
      await user.selectOptions(placement, "top");
      expect(changed).toHaveBeenLastCalledWith({ style: "classic", rolePlacement: "top" });
      await user.selectOptions(style, "heritage");
      expect(placement).toHaveValue("top");
      expect(changed).toHaveBeenLastCalledWith({ style: "heritage", rolePlacement: "top" });
      await user.selectOptions(placement, "ribbon");
      await user.selectOptions(style, "noir");
      expect(changed).toHaveBeenLastCalledWith({ style: "noir", rolePlacement: "ribbon" });
      await user.selectOptions(style, "glass");
      expect(changed).toHaveBeenLastCalledWith({ style: "glass", rolePlacement: "ribbon" });
      expect(screen.queryByRole("combobox", { name: labels.placement })).not.toBeInTheDocument();
      await user.selectOptions(style, "classic");
      expect(screen.getByRole("combobox", { name: labels.placement })).toHaveValue("ribbon");
      expect(changed).toHaveBeenCalledTimes(7);
    },
  );

  it("is controlled by its caller and never reads or writes storage itself", async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    const getItem = vi.spyOn(window.localStorage, "getItem");
    const setItem = vi.spyOn(window.localStorage, "setItem");
    const { rerender } = render(
      <PlayerCardStyleControls
        settings={{ style: "noir", rolePlacement: "top" }}
        onChange={changed}
      />,
    );
    const placement = screen.getByRole("combobox", { name: "Role placement" });
    await user.selectOptions(placement, "ribbon");
    expect(changed).toHaveBeenCalledExactlyOnceWith({ style: "noir", rolePlacement: "ribbon" });
    expect(placement).toHaveValue("top");
    rerender(
      <PlayerCardStyleControls
        settings={{ style: "noir", rolePlacement: "ribbon" }}
        onChange={changed}
      />,
    );
    expect(placement).toHaveValue("ribbon");
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("updates labels live without resetting settings or emitting a preference change", async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    const { rerender } = render(
      <I18nProvider locale="en">
        <Harness changed={changed} />
      </I18nProvider>,
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Player card style" }), "noir");
    await user.selectOptions(screen.getByRole("combobox", { name: "Role placement" }), "top");
    changed.mockClear();
    rerender(
      <I18nProvider locale="ru">
        <Harness changed={changed} />
      </I18nProvider>,
    );
    expect(screen.getByRole("combobox", { name: "Стиль карточек игроков" })).toHaveValue("noir");
    expect(screen.getByRole("option", { name: "Нуар Рояль" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Расположение роли" })).toHaveValue("top");
    expect(screen.getByRole("option", { name: "Вверху" })).toBeInTheDocument();
    expect(changed).not.toHaveBeenCalled();
  });

  it("keeps current-session controls working when its caller cannot persist settings", async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });
    render(<Harness changed={changed} persist />);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Player card style" }),
      "heritage",
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Role placement" }), "top");
    await user.selectOptions(screen.getByRole("combobox", { name: "Player card style" }), "glass");
    await user.selectOptions(screen.getByRole("combobox", { name: "Player card style" }), "noir");
    expect(screen.getByRole("combobox", { name: "Player card style" })).toHaveValue("noir");
    expect(screen.getByRole("combobox", { name: "Role placement" })).toHaveValue("top");
    expect(changed).toHaveBeenLastCalledWith({ style: "noir", rolePlacement: "top" });
  });
});

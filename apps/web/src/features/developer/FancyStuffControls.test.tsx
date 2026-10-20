import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import {
  DEFAULT_FANCY_STUFF_SETTINGS,
  type FancyStuffSettings,
} from "../effects/fancy-stuff-preferences.js";
import { FancyStuffControls } from "./FancyStuffControls.js";

const Harness = ({ changed }: { changed: (settings: FancyStuffSettings) => void }) => {
  const [settings, setSettings] = useState(DEFAULT_FANCY_STUFF_SETTINGS);
  return (
    <FancyStuffControls
      settings={settings}
      onChange={(next) => {
        setSettings(next);
        changed(next);
      }}
    />
  );
};

describe("fancy stuff controls", () => {
  it.each([
    {
      locale: "en" as const,
      section: "Fancy Features",
      disable: "Disable Fancy Features",
      enable: "Enable Fancy Features",
      on: "On",
      off: "Off",
    },
    {
      locale: "ru" as const,
      section: "Красивые эффекты",
      disable: "Выключить красивые эффекты",
      enable: "Включить красивые эффекты",
      on: "Вкл.",
      off: "Выкл.",
    },
  ])("exposes a collapsed, keyboard-operated localized control ($locale)", async (labels) => {
    const changed = vi.fn();
    const user = userEvent.setup();
    render(
      <I18nProvider locale={labels.locale}>
        <Harness changed={changed} />
      </I18nProvider>,
    );
    const summary = screen.getByText(labels.section, { selector: "summary" });
    expect(summary.closest("details")).not.toHaveAttribute("open");
    await user.click(summary);
    const toggle = screen.getByRole("button", { name: labels.disable });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveTextContent(labels.on);
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(changed).toHaveBeenLastCalledWith({ version: 2, enabled: false });
    const disabled = screen.getByRole("button", { name: labels.enable });
    expect(disabled).toHaveAttribute("aria-pressed", "false");
    expect(disabled).toHaveTextContent(labels.off);
    await user.keyboard(" ");
    expect(changed).toHaveBeenLastCalledWith(DEFAULT_FANCY_STUFF_SETTINGS);
    expect(screen.getByRole("button", { name: labels.disable })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

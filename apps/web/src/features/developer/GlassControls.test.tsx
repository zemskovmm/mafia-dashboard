import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { GlassControls, type GlassStatus } from "./GlassControls.js";
import { DEFAULT_GLASS_SETTINGS, type GlassSettings } from "../theme/glass-preferences.js";

const Harness = ({
  status,
  initialSettings = { ...DEFAULT_GLASS_SETTINGS, enabled: true },
  onChange,
}: {
  readonly status: GlassStatus;
  readonly initialSettings?: GlassSettings;
  readonly onChange?: (settings: GlassSettings) => void;
}) => {
  const [settings, setSettings] = useState(initialSettings);
  return (
    <GlassControls
      settings={settings}
      status={status}
      onChange={(next) => {
        setSettings(next);
        onChange?.(next);
      }}
    />
  );
};

describe("Glass controls", () => {
  it("changes player-card appearance independently, retains essential indicators, and resets defaults", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness status="ready" initialSettings={DEFAULT_GLASS_SETTINGS} onChange={onChange} />);
    await user.click(screen.getByText("Glass", { selector: "summary" }));
    await user.click(screen.getByText("Player cards", { selector: "summary" }));
    const tint = screen.getByRole("slider", { name: "Nomination tint" });
    expect(tint).toHaveAttribute("min", "0");
    expect(tint).toHaveAttribute("max", "50");
    expect(tint).toHaveAttribute("step", "1");
    expect(tint).toHaveValue("18");
    let expected = { ...DEFAULT_GLASS_SETTINGS };
    for (const value of [0, 50]) {
      fireEvent.change(tint, { target: { value: String(value) } });
      expected = { ...expected, nominationTint: value };
      expect(onChange).toHaveBeenLastCalledWith(expected);
      expect(tint.closest("label")).toHaveTextContent(`${value}%`);
    }
    const color = screen.getByLabelText("Nomination color", { exact: true });
    expect(color).toHaveAttribute("type", "color");
    fireEvent.change(color, { target: { value: "#123456" } });
    expected = { ...expected, nominationColor: "#123456" };
    expect(onChange).toHaveBeenLastCalledWith(expected);
    expect(screen.getByText("#123456")).toBeInTheDocument();
    for (const [name, value] of [
      ["Amber", "#e6bc7e"],
      ["Blue", "#88c7e3"],
      ["Lilac", "#bda5ec"],
      ["Green", "#a8d6b1"],
    ]) {
      await user.click(screen.getByRole("button", { name: `${name} nomination tint` }));
      expected = { ...expected, nominationColor: value! };
      expect(onChange).toHaveBeenLastCalledWith(expected);
      expect(color).toHaveValue(value);
    }
    const choices = [
      ["nominationTreatment", "Nomination treatment", ["icons", "tint", "hybrid"]],
      ["nominationIcon", "Nomination icon", ["flag", "vote"]],
      ["supportIcon", "Support icon", ["thumbs-up", "hand"]],
      ["selectionStyle", "This speaker’s choice", ["check", "check-outline"]],
    ] as const;
    for (const [field, name, values] of choices) {
      const control = screen.getByRole("combobox", { name });
      for (const value of values) {
        await user.selectOptions(control, value);
        expected = { ...expected, [field]: value };
        expect(onChange).toHaveBeenLastCalledWith(expected);
        expect(control).toHaveValue(value);
      }
    }
    expect(
      screen.getByText(/Essential indicators and support counts remain visible/),
    ).toBeInTheDocument();
    expect(document.querySelector(".lucide-message-circle-off")).not.toBeNull();
    expect(screen.queryByRole("combobox", { name: /mute/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset glass settings" }));
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_GLASS_SETTINGS);
    expect(tint).toHaveValue("18");
    expect(color).toHaveValue("#e6bc7e");
    for (const [field, name] of choices)
      expect(screen.getByLabelText(name)).toHaveValue(DEFAULT_GLASS_SETTINGS[field]);
  });
  it.each(["off", "unavailable", "context-lost", "reduced-transparency"] as const)(
    "keeps player-card controls available with %s glass",
    async (status) => {
      const user = userEvent.setup();
      render(
        <Harness
          status={status}
          initialSettings={{ ...DEFAULT_GLASS_SETTINGS, enabled: status !== "off" }}
        />,
      );
      await user.click(screen.getByText("Glass", { selector: "summary" }));
      await user.click(screen.getByText("Player cards", { selector: "summary" }));
      for (const label of [
        "Nomination tint",
        "Nomination color",
        "Nomination treatment",
        "Nomination icon",
        "Support icon",
        "This speaker’s choice",
      ])
        expect(screen.getByLabelText(label, { exact: true })).not.toBeDisabled();
      fireEvent.change(screen.getByLabelText("Nomination tint"), { target: { value: "0" } });
      await user.selectOptions(screen.getByLabelText("Nomination treatment"), "tint");
      expect(screen.getByLabelText("Nomination tint")).toHaveValue("0");
      expect(screen.getByLabelText("Nomination treatment")).toHaveValue("tint");
    },
  );
  it("updates and resets independent tuning values without disabling status lighting", async () => {
    const user = userEvent.setup();
    render(<Harness status="ready" />);
    await user.click(screen.getByText("Glass", { selector: "summary" }));
    const refraction = screen.getByLabelText("Refraction strength");
    refraction.focus();
    fireEvent.change(refraction, { target: { value: "24" } });
    expect(refraction).toHaveValue("24");
    expect(screen.getByLabelText("Gold background light")).toHaveValue("25");
    fireEvent.change(screen.getByLabelText("Gold background light"), { target: { value: "0" } });
    expect(refraction).toHaveValue("24");
    expect(screen.getByRole("status")).toHaveTextContent("Enhanced glass active");
    await user.click(screen.getByRole("button", { name: "Reset glass settings" }));
    expect(refraction).toHaveValue("10");
    expect(refraction).toBeDisabled();
    expect(screen.getByLabelText("Gold background light")).toHaveValue("25");
  });
  it.each([
    "inactive",
    "initializing",
    "unavailable",
    "context-lost",
    "reduced-transparency",
  ] as const)("shows an honest %s fallback reason and keeps gold operable", (status) => {
    render(<Harness status={status} />);
    expect(screen.getByLabelText("Refraction strength")).toBeDisabled();
    expect(screen.getByLabelText("Refraction strength")).toHaveAttribute(
      "aria-describedby",
      "glass-renderer-reason",
    );
    expect(screen.getByLabelText("Gold background light")).not.toBeDisabled();
    expect(screen.getByRole("status")).not.toHaveTextContent("Enhanced glass active");
  });
  it("localizes all controls and fallback status in Russian", () => {
    const onChange = vi.fn();
    render(
      <I18nProvider locale="ru">
        <GlassControls
          settings={{ ...DEFAULT_GLASS_SETTINGS, enabled: true }}
          status="context-lost"
          onChange={onChange}
        />
      </I18nProvider>,
    );
    expect(screen.getByText("Стекло", { selector: "summary" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Выключить улучшенное стекло" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Сила преломления")).toBeDisabled();
    expect(screen.getByLabelText("Золотой фоновый свет")).toHaveValue("25");
    expect(screen.getByText("Карточки игроков", { selector: "summary" })).toBeInTheDocument();
    expect(screen.getByLabelText("Тонировка выставления")).toHaveValue("18");
    expect(screen.getByLabelText("Цвет выставления")).toHaveValue("#e6bc7e");
    expect(screen.getByLabelText("Оформление выставления")).toHaveValue("hybrid");
    expect(screen.getByLabelText("Значок выставления")).toHaveValue("vote");
    expect(screen.getByLabelText("Значок поддержки")).toHaveValue("hand");
    expect(screen.getByLabelText("Выбор текущего выступающего")).toHaveValue("check-outline");
    expect(screen.getByRole("status")).toHaveTextContent("графический контекст потерян");
    fireEvent.click(screen.getByRole("button", { name: "Сбросить настройки стекла" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(DEFAULT_GLASS_SETTINGS);
  });
});

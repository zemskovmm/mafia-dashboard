import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { GlassControls, type GlassStatus } from "./GlassControls.js";
import { DEFAULT_GLASS_SETTINGS, type GlassSettings } from "../theme/glass-preferences.js";

const Harness = ({
  status,
  initialSettings = DEFAULT_GLASS_SETTINGS,
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
    render(<Harness status="ready" onChange={onChange} />);
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
    expect(screen.getAllByLabelText("Glass tint", { exact: true })).toHaveLength(1);
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
    const matte = screen.getByRole("button", { name: "Disable matte glass" });
    expect(matte).toHaveAttribute("aria-pressed", "true");
    matte.focus();
    await user.keyboard(" ");
    expect(screen.getByRole("button", { name: "Enable matte glass" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(refraction).toHaveValue("24");
    expect(screen.getByLabelText("Gold background light")).toHaveValue("0");
    expect(screen.getByRole("status")).toHaveTextContent("Enhanced glass active");
    await user.click(screen.getByRole("button", { name: "Disable enhanced glass" }));
    expect(refraction).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Reset glass settings" }));
    expect(refraction).toHaveValue("14");
    expect(refraction).not.toBeDisabled();
    expect(screen.getByLabelText("Gold background light")).toHaveValue("25");
    expect(screen.getByRole("button", { name: "Disable matte glass" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Refraction profile")).toHaveValue("edge");
    expect(screen.getByLabelText("Frosting amount")).toHaveValue("50");
    expect(screen.getByLabelText("Glass tint")).toHaveValue("13");
    expect(screen.getByLabelText("Edge highlights")).toHaveValue("100");
    expect(screen.getByLabelText("Caustic light")).toHaveValue("100");
    expect(screen.getByLabelText("Noir contrast · Available players only")).toHaveValue("100");
  });
  it("groups fine tuning and updates each bounded control independently", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness status="ready" onChange={onChange} />);
    await user.click(screen.getByText("Glass", { selector: "summary" }));
    const summary = screen.getByText("Fine tuning", { selector: "summary" });
    const advanced = summary.closest("details");
    expect(advanced).toHaveClass("dev-glass-advanced");
    expect(advanced).not.toHaveAttribute("open");
    await user.click(summary);
    expect(advanced).toHaveAttribute("open");
    const profile = screen.getByRole("combobox", { name: "Refraction profile" });
    expect(profile.closest("details")).toBe(advanced);
    expect(profile).toHaveValue("edge");
    expect(within(profile).getByRole("option", { name: "Reference-inspired edge" })).toHaveValue(
      "edge",
    );
    expect(within(profile).getByRole("option", { name: "Current simple" })).toHaveValue("simple");
    await user.selectOptions(profile, "simple");
    let expected: GlassSettings = { ...DEFAULT_GLASS_SETTINGS, profile: "simple" };
    expect(onChange).toHaveBeenLastCalledWith(expected);
    const ranges = [
      ["refraction", "Refraction strength", 24, 14, false],
      ["goldLight", "Gold background light", 100, 25, false],
      ["frosting", "Frosting amount", 100, 50, true],
      ["tint", "Glass tint", 30, 13, true],
      ["edgeHighlights", "Edge highlights", 100, 100, true],
      ["caustics", "Caustic light", 100, 100, true],
      ["noirContrast", "Noir contrast · Available players only", 100, 100, true],
    ] as const;
    for (const [field, name, maximum, initial, isAdvanced] of ranges) {
      const slider = screen.getByRole("slider", { name });
      expect(slider).toHaveValue(String(initial));
      expect(slider).toHaveAttribute("min", "0");
      expect(slider).toHaveAttribute("max", String(maximum));
      expect(slider).toHaveAttribute("step", "1");
      expect(slider.closest("details") === advanced).toBe(isAdvanced);
      for (const value of [0, maximum]) {
        fireEvent.change(slider, { target: { value: String(value) } });
        expected = { ...expected, [field]: value };
        expect(onChange).toHaveBeenLastCalledWith(expected);
        expect(slider).toHaveValue(String(value));
        expect(slider.closest("label")).toHaveTextContent(
          `${value}${field === "refraction" ? "" : "%"}`,
        );
      }
    }
    expect(
      screen.getByLabelText("Noir contrast · Available players only"),
    ).toHaveAccessibleDescription(
      "Only the Available players background; other screens stay unchanged.",
    );
    await user.click(screen.getByRole("button", { name: "Reset glass settings" }));
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_GLASS_SETTINGS);
    for (const [, name, , initial] of ranges) {
      expect(screen.getByRole("slider", { name })).toHaveValue(String(initial));
    }
    expect(profile).toHaveValue("edge");
  });
  it("retains frosting and other tuning while Matte is toggled by keyboard", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness status="ready" onChange={onChange} />);
    await user.click(screen.getByText("Glass", { selector: "summary" }));
    await user.click(screen.getByText("Fine tuning", { selector: "summary" }));
    const frosting = screen.getByRole("slider", { name: "Frosting amount" });
    fireEvent.change(frosting, { target: { value: "77" } });
    screen.getByRole("button", { name: "Disable matte glass" }).focus();
    await user.keyboard(" ");
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_GLASS_SETTINGS,
      matte: false,
      frosting: 77,
    });
    expect(frosting).toBeDisabled();
    expect(frosting).toHaveValue("77");
    expect(frosting).toHaveAccessibleDescription(/Turn on Matte glass to adjust frosting/);
    expect(screen.getByLabelText("Refraction strength")).not.toBeDisabled();
    expect(screen.getByLabelText("Glass tint")).not.toBeDisabled();
    expect(screen.getByLabelText("Gold background light")).toHaveValue("25");
    await user.keyboard(" ");
    expect(frosting).not.toBeDisabled();
    expect(frosting).toHaveValue("77");
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_GLASS_SETTINGS, frosting: 77 });
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
    expect(screen.getByLabelText("Disable matte glass")).not.toBeDisabled();
    expect(screen.getByLabelText("Refraction profile")).toBeDisabled();
    expect(screen.getByLabelText("Refraction profile")).toHaveAttribute(
      "aria-describedby",
      "glass-renderer-reason",
    );
    expect(screen.getByLabelText("Noir contrast · Available players only")).not.toBeDisabled();
    for (const name of ["Frosting amount", "Glass tint", "Edge highlights", "Caustic light"]) {
      const control = screen.getByLabelText(name);
      expect(control.hasAttribute("disabled")).toBe(status === "reduced-transparency");
      if (status === "reduced-transparency") {
        expect(control).toHaveAccessibleDescription(/Reduced transparency uses opaque glass/);
      }
    }
    expect(screen.getByRole("status")).not.toHaveTextContent("Enhanced glass active");
  });
  it.each(["ready", "reduced-transparency"] as const)(
    "preserves saved OFF with honest %s material availability",
    (status) => {
      render(
        <Harness
          status={status}
          initialSettings={{ ...DEFAULT_GLASS_SETTINGS, enabled: false, refraction: 10 }}
        />,
      );
      expect(screen.getByRole("status")).toHaveTextContent("Enhanced glass off");
      expect(screen.getByLabelText("Refraction strength")).toHaveValue("10");
      expect(screen.getByLabelText("Refraction strength")).toBeDisabled();
      expect(screen.getByLabelText("Refraction profile")).toBeDisabled();
      expect(screen.getByLabelText("Disable matte glass")).not.toBeDisabled();
      expect(screen.getByLabelText("Gold background light")).not.toBeDisabled();
      expect(screen.getByLabelText("Glass tint").hasAttribute("disabled")).toBe(
        status === "reduced-transparency",
      );
      if (status === "reduced-transparency") {
        expect(screen.getByLabelText("Disable matte glass")).toHaveAccessibleDescription(
          /Reduced transparency uses opaque glass/,
        );
      }
    },
  );
  it.each([
    ["en", "Enhanced glass requested · no eligible player-card surface is active"],
    ["ru", "Улучшенное стекло запрошено · подходящие карточки игроков сейчас не показаны"],
  ] as const)(
    "explains inactive shared surfaces rather than a table-only scope in %s",
    (locale, reason) => {
      render(
        <I18nProvider locale={locale}>
          <Harness status="inactive" />
        </I18nProvider>,
      );
      expect(screen.getByRole("status")).toHaveTextContent(reason);
    },
  );
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
    expect(
      screen.getByText("Тонкая настройка", { selector: "summary" }).closest("details"),
    ).toHaveClass("dev-glass-advanced");
    expect(screen.getByLabelText("Профиль преломления")).toBeDisabled();
    expect(screen.getByRole("option", { name: "Краевой, по образцу", hidden: true })).toHaveValue(
      "edge",
    );
    expect(screen.getByRole("option", { name: "Прежний простой", hidden: true })).toHaveValue(
      "simple",
    );
    expect(screen.getByLabelText("Степень матовости")).toHaveValue("50");
    expect(screen.getByLabelText("Тонировка стекла")).toHaveValue("13");
    expect(screen.getByLabelText("Блики на краях")).toHaveValue("100");
    expect(screen.getByLabelText("Каустический свет")).toHaveValue("100");
    expect(screen.getByLabelText("Контраст Noir · только Доступные игроки")).toHaveValue("100");
    expect(
      screen.getByLabelText("Контраст Noir · только Доступные игроки"),
    ).toHaveAccessibleDescription(
      "Только фон экрана «Доступные игроки»; остальные экраны не меняются.",
    );
    expect(screen.getByRole("button", { name: "Выключить матовое стекло" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
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

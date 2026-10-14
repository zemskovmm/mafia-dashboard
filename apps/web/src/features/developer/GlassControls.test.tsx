import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { GlassControls, type GlassStatus } from "./GlassControls.js";
import { DEFAULT_GLASS_SETTINGS } from "../theme/glass-preferences.js";

const Harness = ({ status }: { readonly status: GlassStatus }) => {
  const [settings, setSettings] = useState({ ...DEFAULT_GLASS_SETTINGS, enabled: true });
  return <GlassControls settings={settings} status={status} onChange={setSettings} />;
};

describe("Glass controls", () => {
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
    expect(screen.getByRole("status")).toHaveTextContent("графический контекст потерян");
    fireEvent.click(screen.getByRole("button", { name: "Сбросить настройки стекла" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(DEFAULT_GLASS_SETTINGS);
  });
});

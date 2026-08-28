import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { I18nProvider, useI18n } from "./I18nProvider.js";
import { LanguageSelector } from "./LanguageSelector.js";

const Harness = () => {
  const [locale, setLocale] = useState<"en" | "ru">("en");
  return (
    <I18nProvider locale={locale} onLocaleChange={setLocale}>
      <LanguageSelector />
      <Probe />
    </I18nProvider>
  );
};

const Probe = () => <p>{useI18n().t("Day {day}", { day: 1 })}</p>;

afterEach(cleanup);

describe("LanguageSelector", () => {
  it("changes the controlled locale through a keyboard-operable select", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const selector = screen.getByRole("combobox", { name: "Language" });
    expect(selector).toHaveValue("en");
    expect(screen.getByRole("option", { name: "English" })).toBeInTheDocument();
    await user.selectOptions(selector, "ru");

    expect(screen.getByRole("combobox", { name: "Язык" })).toHaveValue("ru");
    expect(screen.getByRole("option", { name: "Русский" })).toBeInTheDocument();
    expect(screen.getByText("День 1")).toBeInTheDocument();
  });
});

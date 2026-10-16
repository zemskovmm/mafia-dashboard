import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { I18nProvider, resolveBrowserLocale, useI18n, useMessages } from "./I18nProvider.js";

const Probe = () => {
  const { locale, setLocale, t } = useI18n();
  return (
    <div>
      <output>{locale}</output>
      <p>{t("Day {day}", { day: 2 })}</p>
      <p>{t("players.games", { count: 1 })}</p>
      <p>{t("players.games", { count: 2 })}</p>
      <p>{t("players.games", { count: 5 })}</p>
      <p>{t("Hello, {name}", { name: "Михаил" })}</p>
      <button type="button" onClick={() => setLocale("ru")}>
        Russian
      </button>
    </div>
  );
};

const scopedMessages = {
  en: { Greeting: "Welcome, {name}" },
  ru: { Greeting: "Добро пожаловать, {name}" },
} as const;

const ScopedProbe = () => <p>{useMessages(scopedMessages).t("Greeting", { name: "Анна" })}</p>;

afterEach(() => {
  cleanup();
  document.documentElement.lang = "en";
});

describe("I18nProvider", () => {
  it("resolves only Russian browser locales to Russian", () => {
    expect(resolveBrowserLocale(["ru-RU", "en"])).toBe("ru");
    expect(resolveBrowserLocale(["en-GB", "ru"])).toBe("en");
    expect(resolveBrowserLocale(["es"])).toBe("en");
    expect(resolveBrowserLocale([])).toBe("en");
  });

  it("uses the English fallback when uncontrolled", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );

    expect(screen.getByText("Day 2")).toBeInTheDocument();
    expect(screen.getByText("1 game")).toBeInTheDocument();
    expect(screen.getByText("2 games")).toBeInTheDocument();
    expect(screen.getByText("5 games")).toBeInTheDocument();
    expect(screen.getByText("Hello, Михаил")).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("lang", "en");
    await user.click(screen.getByRole("button", { name: "Russian" }));
    expect(screen.getByText("День 2")).toBeInTheDocument();
  });

  it("updates a controlled club locale without remounting children", async () => {
    const user = userEvent.setup();
    const Controlled = () => {
      const [locale, setLocale] = useState<"en" | "ru">("en");
      return (
        <I18nProvider locale={locale} onLocaleChange={setLocale}>
          <Probe />
        </I18nProvider>
      );
    };
    render(<Controlled />);

    expect(screen.getByText("Day 2")).toBeInTheDocument();
    expect(screen.getByText("1 game")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Russian" }));
    expect(screen.getByText("День 2")).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("lang", "ru");
  });

  it("translates a typed feature-scoped catalog", () => {
    render(
      <I18nProvider locale="ru">
        <ScopedProbe />
      </I18nProvider>,
    );

    expect(screen.getByText("Добро пожаловать, Анна")).toBeInTheDocument();
  });

  it("keeps the outgoing locale without resetting the destination document language", () => {
    const { rerender } = render(
      <I18nProvider locale="ru">
        <I18nProvider locale="en" manageDocumentLanguage={false}>
          <Probe />
        </I18nProvider>
      </I18nProvider>,
    );
    expect(screen.getByText("Day 2")).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("lang", "ru");
    rerender(
      <I18nProvider locale="ru">
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByText("День 2")).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("lang", "ru");
  });
});

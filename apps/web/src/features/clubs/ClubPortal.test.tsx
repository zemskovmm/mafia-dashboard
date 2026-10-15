import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppUser, Club } from "../../api/client.js";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { ClubPortal } from "./ClubPortal.js";

afterEach(cleanup);

const creator = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "owner@example.test",
  name: "Club Owner",
  picture: null,
};

describe("ClubPortal", () => {
  it.each([
    [
      "en",
      "The city sleeps. The game begins.",
      "Official app of La Verdad · Málaga",
      "Choose your club",
    ],
    [
      "ru",
      "Город засыпает. Игра начинается.",
      "Официальное приложение клуба La Verdad · Малага",
      "Выберите клуб",
    ],
  ] as const)(
    "shows the localized slogan with app branding through %s authentication states",
    (locale, slogan, attribution, oldHeading) => {
      const portal = (loading: boolean, authUnavailable: boolean) => (
        <I18nProvider locale={locale}>
          <ClubPortal
            user={null}
            authConfigured
            authUnavailable={authUnavailable}
            clubs={[]}
            loading={loading}
            error={null}
            editing={null}
            onSignOut={vi.fn().mockResolvedValue(undefined)}
            onEditingChange={vi.fn()}
            onSaveClub={vi.fn().mockResolvedValue(undefined)}
            onOpenClub={vi.fn()}
          />
        </I18nProvider>
      );
      const { rerender } = render(portal(true, false));
      for (const [loading, unavailable] of [
        [true, false],
        [false, true],
        [false, false],
      ] as const) {
        rerender(portal(loading, unavailable));
        expect(screen.getByRole("img", { name: "La Verdad" })).toHaveAttribute(
          "src",
          "/la-verdad.svg",
        );
        expect(screen.getByRole("heading", { name: slogan })).toBeInTheDocument();
        expect(screen.queryByText(attribution)).not.toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: oldHeading })).not.toBeInTheDocument();
        expect(screen.getByText("La Verdad")).toBeInTheDocument();
      }
      expect(
        screen.getByRole("link", {
          name: locale === "en" ? "Continue with Google" : "Продолжить с Google",
        }),
      ).toHaveAttribute("href", "/api/auth/google/start");
    },
  );

  it("renders the Russian club form and authentication copy", () => {
    render(
      <I18nProvider locale="ru">
        <ClubPortal
          user={creator}
          authConfigured
          authUnavailable={false}
          clubs={[]}
          loading={false}
          error={null}
          editing="new"
          onSignOut={vi.fn().mockResolvedValue(undefined)}
          onEditingChange={vi.fn()}
          onSaveClub={vi.fn().mockResolvedValue(undefined)}
          onOpenClub={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("heading", { name: "Создать новый клуб" })).toBeInTheDocument();
    expect(screen.getByLabelText("Название клуба")).toBeInTheDocument();
    expect(screen.getByLabelText("Город")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Я согласен/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Сохранить клуб" })).toBeDisabled();
  });

  it("requires explicit Owner profile consent for each club creation", async () => {
    const user = userEvent.setup();
    const onSaveClub = vi.fn().mockResolvedValue(undefined);

    const Harness = () => {
      const [editing, setEditing] = useState<Club | "new" | null>("new");
      return (
        <ClubPortal
          user={creator}
          authConfigured
          authUnavailable={false}
          clubs={[]}
          loading={false}
          error={null}
          editing={editing}
          onSignOut={vi.fn().mockResolvedValue(undefined)}
          onEditingChange={setEditing}
          onSaveClub={onSaveClub}
          onOpenClub={vi.fn()}
        />
      );
    };

    render(<Harness />);
    await user.type(screen.getByLabelText("Club name"), "Mafia Sevilla");
    await user.type(screen.getByLabelText("City"), "Sevilla");
    const bestMove = screen.getByRole("checkbox", { name: "Enable Best move" });
    expect(bestMove).toBeChecked();
    await user.click(bestMove);

    const consent = screen.getByRole("checkbox", {
      name: "I consent to store my Google name and email in the Owner player profile.",
    });
    const save = screen.getByRole("button", { name: "Save club" });
    expect(consent).not.toBeChecked();
    expect(save).toBeDisabled();

    await user.click(consent);
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() =>
      expect(onSaveClub).toHaveBeenCalledWith(null, {
        name: "Mafia Sevilla",
        city: "Sevilla",
        headerLogo: null,
        cardLogo: null,
        language: "en",
        bestMoveEnabled: false,
        ownerConsent: true,
      }),
    );
    await user.click(screen.getByRole("button", { name: /^New club/ }));
    expect(
      screen.getByRole("checkbox", {
        name: "I consent to store my Google name and email in the Owner player profile.",
      }),
    ).not.toBeChecked();
  });

  it("defaults a new club to the browser language and submits an explicit language", async () => {
    const user = userEvent.setup();
    const onSaveClub = vi.fn().mockResolvedValue(undefined);
    render(
      <I18nProvider locale="ru">
        <ClubPortal
          user={creator}
          authConfigured
          authUnavailable={false}
          clubs={[]}
          loading={false}
          error={null}
          editing="new"
          onSignOut={vi.fn().mockResolvedValue(undefined)}
          onEditingChange={vi.fn()}
          onSaveClub={onSaveClub}
          onOpenClub={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("combobox", { name: "Язык" })).toHaveValue("ru");
    await user.type(screen.getByLabelText("Название клуба"), "Mafia Moscow");
    await user.type(screen.getByLabelText("Город"), "Москва");
    await user.click(screen.getByRole("checkbox", { name: /Я согласен/ }));
    await user.click(screen.getByRole("button", { name: "Сохранить клуб" }));
    await waitFor(() =>
      expect(onSaveClub).toHaveBeenCalledWith(
        null,
        expect.objectContaining({ language: "ru", ownerConsent: true }),
      ),
    );
  });

  it.each(["en", "ru"] as const)(
    "preserves account actions without a %s portal colour picker",
    async (locale) => {
      const user = userEvent.setup();
      const onSignOut = vi.fn().mockResolvedValue(undefined);
      const portal = (account: AppUser | null, loading = false, editing: "new" | null = null) => (
        <I18nProvider locale={locale}>
          <ClubPortal
            user={account}
            authConfigured
            authUnavailable={false}
            clubs={[]}
            loading={loading}
            error={null}
            editing={editing}
            onSignOut={onSignOut}
            onEditingChange={vi.fn()}
            onSaveClub={vi.fn().mockResolvedValue(undefined)}
            onOpenClub={vi.fn()}
          />
        </I18nProvider>
      );
      const signOutName = locale === "en" ? "Sign out" : "Выйти";
      const { container, rerender } = render(portal(creator));

      expect(
        screen.queryByLabelText(locale === "en" ? "Glass color" : "Цвет стекла"),
      ).not.toBeInTheDocument();
      expect(screen.getByText(creator.name)).toBeInTheDocument();
      expect(screen.getByText(creator.email)).toBeInTheDocument();
      expect(container.querySelector(".club-user-avatar")).toHaveTextContent("C");
      await user.click(screen.getByRole("button", { name: signOutName }));
      expect(onSignOut).toHaveBeenCalledTimes(1);

      rerender(portal({ ...creator, picture: "https://example.test/avatar.png" }, true));
      expect(container.querySelector(".club-user-avatar img")).toHaveAttribute(
        "referrerpolicy",
        "no-referrer",
      );
      expect(screen.getByRole("button", { name: signOutName })).toBeDisabled();
      await user.click(screen.getByRole("button", { name: signOutName }));
      expect(onSignOut).toHaveBeenCalledTimes(1);

      for (const state of [portal(null), portal(creator, false, "new")]) {
        rerender(state);
        expect(screen.queryByRole("button", { name: signOutName })).not.toBeInTheDocument();
        expect(screen.queryByText(creator.email)).not.toBeInTheDocument();
        expect(container.querySelector('input[type="color"]')).toBeNull();
      }
    },
  );
});

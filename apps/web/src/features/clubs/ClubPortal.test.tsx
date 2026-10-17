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
  it("captures the whole real card outline for mouse and keyboard ignition", async () => {
    const user = userEvent.setup();
    const onOpenClub = vi.fn();
    const club: Club = {
      id: "00000000-0000-4000-8000-000000000101",
      name: "La Verdad",
      city: "Málaga",
      headerLogo: null,
      cardLogo: null,
      language: "en",
      bestMoveEnabled: true,
      role: "manager",
      createdAt: "2026-10-15T00:00:00.000Z",
      updatedAt: "2026-10-15T00:00:00.000Z",
    };
    render(
      <ClubPortal
        user={creator}
        authConfigured
        authUnavailable={false}
        clubs={[club]}
        loading={false}
        error={null}
        editing={null}
        onSignOut={vi.fn()}
        onEditingChange={vi.fn()}
        onSaveClub={vi.fn()}
        onOpenClub={onOpenClub}
      />,
    );
    const button = screen.getByRole("button", { name: /La Verdad.*Málaga/i });
    const card = button.closest<HTMLElement>(".club-playing-card")!;
    card.style.borderRadius = "16px";
    Object.defineProperties(card, {
      offsetWidth: { value: 240 },
      offsetHeight: { value: 340 },
    });
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 200, 240, 340));
    await user.click(button);
    const origin = onOpenClub.mock.calls[0]![1];
    expect(origin).toMatchObject({ x: 220, y: 370 });
    expect(origin.card).toBe(card);
    expect(origin.cardTransform).toBe(getComputedStyle(card).transform);
    expect(origin.front).toHaveLength(52);
    expect(origin.front[0]).toEqual([340, 524]);
    expect(origin.front).toContainEqual([324, 540]);
    expect(origin.front).toContainEqual([100, 216]);
    await user.keyboard("{Enter}");
    expect(onOpenClub).toHaveBeenCalledTimes(2);
    expect(onOpenClub).toHaveBeenLastCalledWith(club, origin);
  });

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

  it.each([true, false])(
    "hides Edit club Best Move and preserves its saved %s value and logos through save/cancel",
    async (bestMoveEnabled) => {
      const user = userEvent.setup();
      const onSaveClub = vi.fn().mockResolvedValue(undefined);
      const onEditingChange = vi.fn();
      const club: Club = {
        id: "00000000-0000-4000-8000-000000000101",
        name: "La Verdad",
        city: "Málaga",
        headerLogo:
          "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='300'/>",
        cardLogo:
          "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='300' height='900'/>",
        language: "en",
        bestMoveEnabled,
        role: "manager",
        createdAt: "2026-10-15T00:00:00.000Z",
        updatedAt: "2026-10-15T00:00:00.000Z",
      };
      const editor = (
        <ClubPortal
          user={creator}
          authConfigured
          authUnavailable={false}
          clubs={[club]}
          loading={false}
          error={null}
          editing={club}
          onSignOut={vi.fn()}
          onEditingChange={onEditingChange}
          onSaveClub={onSaveClub}
          onOpenClub={vi.fn()}
        />
      );
      const { rerender } = render(editor);

      expect(screen.queryByRole("checkbox", { name: "Enable Best move" })).not.toBeInTheDocument();
      expect(screen.getByRole("img", { name: "Header logo preview" })).toHaveAttribute(
        "src",
        club.headerLogo,
      );
      expect(screen.getByRole("img", { name: "Playing-card logo preview" })).toHaveAttribute(
        "src",
        club.cardLogo,
      );
      expect(screen.getAllByText("Change")).toHaveLength(2);
      await user.clear(screen.getByLabelText("Club name"));
      await user.type(screen.getByLabelText("Club name"), "Renamed club");
      await user.clear(screen.getByLabelText("City"));
      await user.type(screen.getByLabelText("City"), "Sevilla");
      await user.selectOptions(screen.getByRole("combobox", { name: "Language" }), "ru");
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onEditingChange).toHaveBeenCalledWith(null);
      expect(onSaveClub).not.toHaveBeenCalled();
      expect(club).toMatchObject({
        name: "La Verdad",
        city: "Málaga",
        language: "en",
        bestMoveEnabled,
      });

      // Honor the controlled editor's close callback, then reopen the saved club.
      rerender(<></>);
      rerender(editor);
      expect(screen.getByLabelText("Club name")).toHaveValue(club.name);
      expect(screen.getByLabelText("City")).toHaveValue(club.city);
      expect(screen.getByRole("combobox", { name: "Language" })).toHaveValue(club.language);
      await user.clear(screen.getByLabelText("Club name"));
      await user.type(screen.getByLabelText("Club name"), "Renamed club");
      await user.clear(screen.getByLabelText("City"));
      await user.type(screen.getByLabelText("City"), "Sevilla");
      await user.selectOptions(screen.getByRole("combobox", { name: "Language" }), "ru");
      await user.click(screen.getByRole("button", { name: "Save club" }));
      await waitFor(() =>
        expect(onSaveClub).toHaveBeenCalledExactlyOnceWith(club.id, {
          name: "Renamed club",
          city: "Sevilla",
          language: "ru",
          headerLogo: club.headerLogo,
          cardLogo: club.cardLogo,
          bestMoveEnabled,
        }),
      );

      // FileReader uploads also retain the hidden setting, without rewriting
      // the source club or transforming either uploaded value.
      onSaveClub.mockClear();
      rerender(<></>);
      rerender(editor);
      const image = "<svg xmlns='http://www.w3.org/2000/svg' width='800' height='200'/>";
      const imageValue = `data:image/svg+xml;base64,${btoa(image)}`;
      await user.upload(
        screen.getByLabelText(/Header logo/, { selector: "input" }),
        new File([image], "header.svg", { type: "image/svg+xml" }),
      );
      await user.upload(
        screen.getByLabelText(/Playing-card logo/, { selector: "input" }),
        new File([image], "card.svg", { type: "image/svg+xml" }),
      );
      await waitFor(() => {
        expect(screen.getByRole("img", { name: "Header logo preview" })).toHaveAttribute(
          "src",
          imageValue,
        );
        expect(screen.getByRole("img", { name: "Playing-card logo preview" })).toHaveAttribute(
          "src",
          imageValue,
        );
      });
      await user.click(screen.getByRole("button", { name: "Save club" }));
      await waitFor(() =>
        expect(onSaveClub).toHaveBeenCalledExactlyOnceWith(club.id, {
          name: club.name,
          city: club.city,
          language: club.language,
          headerLogo: imageValue,
          cardLogo: imageValue,
          bestMoveEnabled,
        }),
      );
    },
  );

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

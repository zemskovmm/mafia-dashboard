import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client.js";
import type { PlayerProfile } from "../../api/client.js";
import { clearErrorConsole, getErrorConsoleSnapshot } from "../console/error-console.js";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { PlayersScreen } from "./PlayersScreen.js";

afterEach(() => {
  clearErrorConsole();
  cleanup();
});

const profile = (overrides: Partial<PlayerProfile> = {}): PlayerProfile => ({
  id: "00000000-0000-4000-8000-000000000001",
  nickname: "Alpha",
  consent: true,
  clubManager: false,
  managerLocked: false,
  firstName: "Ada",
  lastName: "Player",
  email: "ada@example.test",
  consentAt: "2026-08-17T20:00:00.000Z",
  createdAt: "2026-08-17T20:00:00.000Z",
  updatedAt: "2026-08-17T20:00:00.000Z",
  lastPlayedAt: "2026-08-17T22:00:00.000Z",
  statistics: {
    hostedGames: 2,
    gamesPlayed: 5,
    wins: 3,
    losses: 2,
    redGames: 3,
    redWins: 2,
    blackGames: 2,
    blackWins: 1,
    sheriffGames: 1,
    citizenGames: 2,
    mafiaGames: 1,
    donGames: 1,
    totalFouls: 4,
    eliminations: 1,
    redCards: 0,
    bestMoves: 0,
    bestMoveMafiaHits: 0,
  },
  ...overrides,
});

describe("PlayersScreen", () => {
  it("uses one local rotating specular surface only for New player", () => {
    render(<PlayersScreen players={[profile()]} onCreate={vi.fn()} onUpdate={vi.fn()} />);

    expect(document.querySelector(".new-player-panel")).toHaveClass("glass-surface", "is-specular");
    expect(screen.getByRole("article", { name: /player alpha/i })).not.toHaveClass("is-specular");
  });

  it("uses compact headings, aligned toggles, and shared player action rows", () => {
    render(
      <PlayersScreen
        players={[profile({ lastPlayedAt: null })]}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const newHeading = screen.getByRole("heading", { name: "New player" });
    expect(newHeading).toHaveClass("eyebrow");
    expect(screen.queryByText("Add to players")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add player" })).toHaveAttribute(
      "form",
      "new-player-form",
    );
    for (const control of [
      screen.getByLabelText("New player Agree for data processing"),
      screen.getByLabelText("New player Club manager"),
    ]) {
      expect(control.closest(".player-toggle-field")).not.toBeNull();
      expect(control.closest(".player-toggle-control")).not.toBeNull();
    }

    const card = screen.getByRole("article", { name: /player alpha/i });
    expect(within(card).queryByText("Player profile")).not.toBeInTheDocument();
    expect(within(card).queryByText(/Never played|Last played/i)).not.toBeInTheDocument();
    const actions = card.querySelector(".player-card-actions");
    expect(actions).toContainElement(within(card).getByRole("button", { name: "Save Alpha" }));
    expect(actions).toContainElement(within(card).getByRole("button", { name: "Delete Alpha" }));
  });

  it("renders a Club manager control for a new player", () => {
    render(<PlayersScreen players={[]} onCreate={vi.fn()} onUpdate={vi.fn()} />);

    expect(screen.getByRole("checkbox", { name: "New player Club manager" })).toBeInTheDocument();
  });

  it("requires explicit consent before an unlocked player can become a Club manager", async () => {
    const user = userEvent.setup();
    const player = profile({
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    render(<PlayersScreen players={[player]} onCreate={vi.fn()} onUpdate={vi.fn()} />);

    const card = screen.getByRole("article", { name: /player alpha/i });
    const consentControl = within(card).getByLabelText("Alpha Agree for data processing");
    const managerControl = within(card).getByRole("checkbox", { name: "Alpha Club manager" });
    expect(managerControl).toBeDisabled();

    await user.click(consentControl);

    expect(managerControl).toBeEnabled();
    expect(managerControl).not.toBeChecked();

    await user.click(managerControl);

    expect(managerControl).toBeChecked();
    expect(consentControl).toBeChecked();
  });

  it("submits a new manager with normalized personal fields", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<PlayersScreen players={[]} onCreate={onCreate} onUpdate={vi.fn()} />);

    await user.type(screen.getByLabelText("New player nickname"), "  Manager  ");
    await user.click(screen.getByLabelText("New player Agree for data processing"));
    await user.click(screen.getByRole("checkbox", { name: "New player Club manager" }));
    await user.type(screen.getByLabelText("New player first name"), "  Grace  ");
    await user.type(screen.getByLabelText("New player last name"), "  Host  ");
    await user.type(screen.getByLabelText("New player email"), "manager@example.test");
    await user.click(screen.getByRole("button", { name: "Add player" }));

    expect(onCreate).toHaveBeenCalledWith({
      nickname: "Manager",
      consent: true,
      clubManager: true,
      firstName: "Grace",
      lastName: "Host",
      email: "manager@example.test",
    });
  });

  it("keeps game availability controls out of persistent player-profile cards", () => {
    const player = profile();
    render(
      <PlayersScreen
        players={[player]}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        {...({
          availablePlayerIds: new Set([player.id]),
          onAvailabilityChange: vi.fn(),
        } as Record<string, unknown>)}
      />,
    );

    expect(
      screen.queryByRole("checkbox", {
        name: `${player.nickname} available for game selection`,
      }),
    ).not.toBeInTheDocument();
  });

  it("submits a changed player name", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(<PlayersScreen players={[profile()]} onCreate={vi.fn()} onUpdate={onUpdate} />);
    const card = screen.getByRole("article", { name: /player alpha/i });

    await user.clear(within(card).getByLabelText(/alpha nickname/i));
    await user.type(within(card).getByLabelText(/alpha nickname/i), "Bravo");
    await user.click(within(card).getByRole("button", { name: /save alpha/i }));

    expect(onUpdate).toHaveBeenCalledWith(
      profile().id,
      expect.objectContaining({ nickname: "Bravo" }),
    );
  });

  it("requires confirmation before deleting a player", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <PlayersScreen
        players={[profile()]}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        {...({ onDelete } as Record<string, unknown>)}
      />,
    );

    await user.click(screen.getByRole("button", { name: /delete alpha/i }));
    expect(confirm).toHaveBeenCalledWith(
      'Delete player "Alpha" and 7 associated games? Those games will also be removed from every affected player\'s statistics. This cannot be undone.',
    );
    expect(onDelete).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: /delete alpha/i }));
    expect(onDelete).toHaveBeenCalledWith(profile().id);
  });

  it("keeps creator manager access while allowing personal-data consent withdrawal", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const creator = profile({
      clubManager: true,
      managerLocked: true,
      statistics: {
        ...profile().statistics,
        hostedGames: 0,
        gamesPlayed: 0,
      },
    });
    render(
      <PlayersScreen
        players={[creator]}
        onCreate={vi.fn()}
        onUpdate={onUpdate}
        onDelete={vi.fn()}
      />,
    );

    const card = screen.getByRole("article", { name: /player alpha/i });
    const managerControl = within(card).getByRole("checkbox", { name: "Alpha Club manager" });
    const consentControl = within(card).getByLabelText("Alpha Agree for data processing");
    expect(managerControl).toBeChecked();
    expect(managerControl).toBeDisabled();
    expect(consentControl).toBeEnabled();
    expect(within(card).queryByRole("button", { name: "Delete Alpha" })).not.toBeInTheDocument();
    expect(within(card).getByText(/manager access remains linked/i)).toHaveTextContent(
      /personal profile data is removed/i,
    );

    await user.click(consentControl);

    expect(managerControl).toBeChecked();
    expect(within(card).getByLabelText("Alpha first name")).toBeDisabled();
    expect(within(card).getByLabelText("Alpha first name")).toHaveValue("");
    expect(within(card).getByLabelText("Alpha last name")).toHaveValue("");
    expect(within(card).getByLabelText("Alpha email")).toHaveValue("");
    await user.click(within(card).getByRole("button", { name: /save alpha/i }));

    expect(onUpdate).toHaveBeenCalledWith(creator.id, {
      nickname: "Alpha",
      consent: false,
      clubManager: true,
      firstName: null,
      lastName: null,
      email: null,
    });
  });

  it("lets a normal manager demote the profile", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const manager = profile({ clubManager: true });
    render(<PlayersScreen players={[manager]} onCreate={vi.fn()} onUpdate={onUpdate} />);

    const card = screen.getByRole("article", { name: /player alpha/i });
    const managerControl = within(card).getByRole("checkbox", { name: "Alpha Club manager" });
    expect(managerControl).toBeChecked();
    expect(managerControl).toBeEnabled();

    await user.click(managerControl);
    await user.click(within(card).getByRole("button", { name: /save alpha/i }));

    expect(onUpdate).toHaveBeenCalledWith(manager.id, {
      nickname: "Alpha",
      consent: true,
      clubManager: false,
      firstName: "Ada",
      lastName: "Player",
      email: "ada@example.test",
    });
  });

  it("creates a nickname-only profile when consent is not granted", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<PlayersScreen players={[]} onCreate={onCreate} onUpdate={vi.fn()} />);

    expect(screen.getByLabelText(/new player first name/i)).toBeDisabled();
    await user.type(screen.getByLabelText(/new player nickname/i), "Night Owl");
    await user.click(screen.getByRole("button", { name: /add player/i }));

    expect(onCreate).toHaveBeenCalledWith({
      nickname: "Night Owl",
      consent: false,
      clubManager: false,
      firstName: null,
      lastName: null,
      email: null,
    });
  });

  it("requires all personal fields after data-processing consent", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<PlayersScreen players={[]} onCreate={onCreate} onUpdate={vi.fn()} />);

    await user.type(screen.getByLabelText(/new player nickname/i), "Consented");
    await user.click(screen.getByLabelText(/new player agree for data processing/i));
    const firstName = screen.getByLabelText(/new player first name/i);
    const lastName = screen.getByLabelText(/new player last name/i);
    const email = screen.getByLabelText(/new player email/i);
    expect(firstName).toBeRequired();
    expect(lastName).toBeRequired();
    expect(email).toBeRequired();

    await user.type(firstName, "Grace");
    await user.type(lastName, "Host");
    await user.type(email, "grace@example.test");
    await user.click(screen.getByRole("button", { name: /add player/i }));

    expect(onCreate).toHaveBeenCalledWith({
      nickname: "Consented",
      consent: true,
      clubManager: false,
      firstName: "Grace",
      lastName: "Host",
      email: "grace@example.test",
    });
  });

  it("keeps the create form open and explains nickname conflicts", async () => {
    const user = userEvent.setup();
    const onCreate = vi
      .fn()
      .mockRejectedValue(new ApiError("Unable to create player", 409, "nickname_conflict"));
    render(<PlayersScreen players={[]} onCreate={onCreate} onUpdate={vi.fn()} />);

    const nickname = screen.getByLabelText(/new player nickname/i);
    await user.type(nickname, "Duplicate");
    await user.click(screen.getByRole("button", { name: /add player/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/nickname already exists/i);
    expect(nickname).toHaveValue("Duplicate");
    expect(getErrorConsoleSnapshot()[0]).toMatchObject({
      source: "api",
      context: "players.create",
      message: "Unable to create player",
    });
  });

  it("explains manager email conflicts", async () => {
    const user = userEvent.setup();
    const onUpdate = vi
      .fn()
      .mockRejectedValue(new ApiError("Unable to update player", 409, "manager_email_conflict"));
    render(
      <PlayersScreen
        players={[profile({ clubManager: true })]}
        onCreate={vi.fn()}
        onUpdate={onUpdate}
      />,
    );

    await user.click(screen.getByRole("button", { name: /save alpha/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /email is already assigned to another club manager/i,
    );
  });

  it("clears manager and personal data when consent is withdrawn", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const manager = profile({ clubManager: true });
    render(<PlayersScreen players={[manager]} onCreate={vi.fn()} onUpdate={onUpdate} />);

    const card = screen.getByRole("article", { name: /player alpha/i });
    await user.click(within(card).getByLabelText("Alpha Agree for data processing"));

    expect(within(card).getByLabelText("Alpha Club manager")).not.toBeChecked();
    expect(within(card).getByLabelText("Alpha first name")).toBeDisabled();
    expect(within(card).getByLabelText("Alpha first name")).toHaveValue("");
    await user.click(within(card).getByRole("button", { name: /save alpha/i }));
    expect(onUpdate).toHaveBeenCalledWith(manager.id, {
      nickname: "Alpha",
      consent: false,
      clubManager: false,
      firstName: null,
      lastName: null,
      email: null,
    });
  });

  it("renders statistics and clears personal fields when consent is withdrawn", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(<PlayersScreen players={[profile()]} onCreate={vi.fn()} onUpdate={onUpdate} />);

    const card = screen.getByRole("article", { name: /player alpha/i });
    const hostedLabel = within(card).getByText("Hosted");
    expect(hostedLabel.previousElementSibling).toHaveTextContent("2");
    expect(within(card).getByText("5")).toBeInTheDocument();
    expect(within(card).getByText(/60% win rate/i)).toBeInTheDocument();
    expect(within(card).getByText(/sheriff 1/i)).toBeInTheDocument();

    await user.click(within(card).getByLabelText(/alpha agree for data processing/i));
    expect(within(card).getByLabelText(/alpha first name/i)).toBeDisabled();
    expect(within(card).getByLabelText(/alpha first name/i)).toHaveValue("");
    await user.click(within(card).getByRole("button", { name: /save alpha/i }));

    expect(onUpdate).toHaveBeenCalledWith(profile().id, {
      nickname: "Alpha",
      consent: false,
      clubManager: false,
      firstName: null,
      lastName: null,
      email: null,
    });
  });

  it("renders statistics, fields, localized dates, and Russian deletion plurals", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    confirm.mockClear();
    const playerWithGames = (nickname: string, gamesPlayed: number) =>
      profile({
        id: `00000000-0000-4000-8000-00000000000${gamesPlayed}`,
        nickname,
        statistics: { ...profile().statistics, hostedGames: 0, gamesPlayed },
      });
    render(
      <I18nProvider locale="ru">
        <PlayersScreen
          players={[
            playerWithGames("Alpha", 1),
            playerWithGames("Bravo", 2),
            playerWithGames("Charlie", 5),
          ]}
          onCreate={vi.fn()}
          onUpdate={vi.fn()}
          onDelete={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("heading", { name: "Новый игрок" })).toBeInTheDocument();
    expect(screen.getByLabelText("Новый игрок Псевдоним")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Поиск по псевдониму, имени или электронной почте"),
    ).toBeInTheDocument();
    const alphaCard = screen.getByRole("article", { name: "Игрок Alpha" });
    expect(within(alphaCard).getByText(/Последняя игра \d{2}\.\d{2}\.\d{4}/)).toBeInTheDocument();
    expect(within(alphaCard).getByText(/Шериф 1 · Мирный 2 · Мафия 1 · Дон 1/)).toBeInTheDocument();
    expect(
      within(alphaCard).getByText(/4 фола · 1 удаление · 0 красных карточек/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Удалить Alpha" }));
    await user.click(screen.getByRole("button", { name: "Удалить Bravo" }));
    await user.click(screen.getByRole("button", { name: "Удалить Charlie" }));

    expect(confirm.mock.calls.map(([message]) => message)).toEqual([
      "Удалить игрока «Alpha» и 1 связанную игру? Она также будет удалена из статистики всех затронутых игроков. Отменить это действие нельзя.",
      "Удалить игрока «Bravo» и 2 связанные игры? Они также будут удалены из статистики всех затронутых игроков. Отменить это действие нельзя.",
      "Удалить игрока «Charlie» и 5 связанных игр? Они также будут удалены из статистики всех затронутых игроков. Отменить это действие нельзя.",
    ]);
  });
});

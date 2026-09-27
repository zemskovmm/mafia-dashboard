import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PlayerProfile } from "../../api/client.js";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { SetupWizard, type SetupWizardSessionState } from "./SetupWizard.js";
import { beginRoleDraw, createSetup, drawRoleForSeat, type GameState } from "@mafia/game-domain";

const availablePlayers: readonly PlayerProfile[] = Array.from({ length: 11 }, (_, index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  nickname: `Player ${index + 1}`,
  consent: false,
  clubAccess: "none",
  managerLocked: false,
  firstName: null,
  lastName: null,
  email: null,
  consentAt: null,
  createdAt: "2026-08-17T20:00:00.000Z",
  updatedAt: "2026-08-17T20:00:00.000Z",
  lastPlayedAt: index < 2 ? `2026-08-${17 - index}T20:00:00.000Z` : null,
  statistics: {
    hostedGames: 0,
    gamesPlayed: index < 2 ? 1 : 0,
    wins: 0,
    losses: index < 2 ? 1 : 0,
    redGames: 0,
    redWins: 0,
    blackGames: 0,
    blackWins: 0,
    sheriffGames: 0,
    citizenGames: 0,
    mafiaGames: 0,
    donGames: 0,
    totalFouls: 0,
    eliminations: 0,
    redCards: 0,
    bestMoves: 0,
    bestMoveMafiaHits: 0,
  },
}));
const replacementPlayer: PlayerProfile = {
  ...availablePlayers[0]!,
  id: "00000000-0000-4000-8000-000000000012",
  nickname: "Player 12",
};
const playersWithReplacement = [...availablePlayers, replacementPlayer];

const Harness = ({
  onComplete,
  players = availablePlayers,
  onPopulateDevelopmentPlayers,
}: {
  onComplete: (game: GameState, hostPlayerId: string, hostName: string) => void;
  players?: readonly PlayerProfile[];
  onPopulateDevelopmentPlayers?: () => Promise<readonly PlayerProfile[]>;
}) => (
  <SetupWizard
    players={players}
    onComplete={onComplete}
    onOpenAvailablePlayers={() => undefined}
    {...({
      showDevelopmentTools: onPopulateDevelopmentPlayers !== undefined,
      onPopulateDevelopmentPlayers,
    } as Record<string, unknown>)}
  />
);

const choosePlayer = async (
  user: ReturnType<typeof userEvent.setup>,
  fieldName: string,
  player: PlayerProfile,
) => {
  const field = screen.getByRole("combobox", { name: fieldName });
  await user.click(field);
  await user.clear(field);
  await user.type(field, player.nickname);
  const suggestionsName = `${fieldName.replace(/ player$/, "")} suggestions`;
  await user.click(
    within(screen.getByRole("listbox", { name: suggestionsName })).getByRole("option", {
      name: player.nickname,
    }),
  );
};

const fillPlayerSelection = async (user: ReturnType<typeof userEvent.setup>) => {
  await choosePlayer(user, "Host player", availablePlayers[10]!);
  for (let index = 0; index < 10; index += 1) {
    await choosePlayer(user, `Seat ${index + 1} player`, availablePlayers[index]!);
  }
};

const partialRoleSession = () => {
  const selectedPlayerIds = availablePlayers.slice(0, 10).map(({ id }) => id);
  const setup = drawRoleForSeat(
    beginRoleDraw(
      createSetup(
        availablePlayers
          .slice(0, 10)
          .map(({ id, nickname }, index) => ({ id, name: nickname, seat: index + 1 })),
      ),
      () => 0,
    ),
    1,
  );
  return {
    step: "roles" as const,
    hostPlayerId: availablePlayers[10]!.id,
    selectedPlayerIds,
    setup,
  };
};

const invokeRoleDrawBackAction = (onRoleDrawBackActionChange: ReturnType<typeof vi.fn>) => {
  const action = [...onRoleDrawBackActionChange.mock.calls]
    .reverse()
    .map(([candidate]) => candidate)
    .find((candidate): candidate is () => void => typeof candidate === "function");
  if (action === undefined) throw new Error("Role back action was not registered");
  act(action);
};

describe("SetupWizard", () => {
  it("groups the accessible Casper switch with the selection heading", async () => {
    const user = userEvent.setup();
    render(<Harness onComplete={vi.fn()} />);
    const heading = screen.getByRole("heading", { name: "Select 10 players + host" });
    const header = heading.closest("header");
    expect(header).not.toBeNull();
    const toggle = within(header!).getByRole("switch", { name: "Include Casper" });
    expect(toggle).not.toBeChecked();
    expect(toggle).not.toHaveAttribute("aria-describedby");
    toggle.focus();
    await user.keyboard(" ");
    expect(toggle).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Seat 10 player" })).toHaveValue("Casper · citizen");
    await user.click(screen.getByText("Include Casper", { selector: "span" }));
    expect(toggle).not.toBeChecked();
    expect(screen.getByRole("combobox", { name: "Seat 10 player" })).toHaveValue("");
  });

  it("omits explanatory paragraphs in both modes but keeps missing-player warnings", async () => {
    const user = userEvent.setup();
    render(<Harness players={availablePlayers.slice(0, 9)} onComplete={vi.fn()} />);
    expect(
      screen.queryByText(/Choose a saved host and ten different saved players/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Casper fills C10/)).not.toBeInTheDocument();
    expect(screen.getByText(/Mark at least 11 players available/)).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Include Casper" }));
    expect(
      screen.queryByText(/Choose a saved host and nine different saved players/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Casper fills C10/)).not.toBeInTheDocument();
    expect(screen.getByText(/Mark at least 10 players available/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Seat 10 player" })).not.toHaveAttribute(
      "aria-describedby",
    );
  });

  it("fills nine human seats and locks Casper to C10 with only ten people available", async () => {
    const user = userEvent.setup();
    const onSessionStateChange = vi.fn();
    render(
      <SetupWizard
        players={availablePlayers.slice(0, 10)}
        onComplete={vi.fn()}
        onSessionStateChange={onSessionStateChange}
      />,
    );

    const toggle = screen.getByRole("switch", { name: "Include Casper" });
    expect(toggle).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Assign players" })).toBeDisabled();
    await user.click(toggle);
    await choosePlayer(user, "Host player", availablePlayers[9]!);
    await user.click(screen.getByRole("button", { name: "Assign players" }));

    expect(screen.getAllByRole("combobox", { name: /seat \d+ player/i })).toHaveLength(9);
    expect(screen.getByRole("textbox", { name: "Seat 10 player" })).toHaveValue("Casper · citizen");
    expect(screen.getByRole("textbox", { name: "Seat 10 player" })).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Start game" })).toBeEnabled();
    const selection = onSessionStateChange.mock.lastCall?.[0];
    expect(selection.hostPlayerId).toBe(availablePlayers[9]!.id);
    expect(new Set(selection.selectedPlayerIds.slice(0, 9))).toEqual(
      new Set(availablePlayers.slice(0, 9).map(({ id }) => id)),
    );
    expect(selection.selectedPlayerIds[9]).toBe("casper");
    await user.click(screen.getByRole("combobox", { name: "Host player" }));
    await user.clear(screen.getByRole("combobox", { name: "Host player" }));
    await user.type(screen.getByRole("combobox", { name: "Host player" }), "Casper");
    expect(screen.queryByRole("option", { name: "Casper" })).not.toBeInTheDocument();
  });

  it("keeps Casper citizen through role draw, back navigation and restored setup", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    const onSessionStateChange = vi.fn<(state: SetupWizardSessionState) => void>();
    const onRoleDrawBackActionChange = vi.fn();
    const props = {
      players: availablePlayers.slice(0, 10),
      onComplete,
      onSessionStateChange,
      onRoleDrawBackActionChange,
    };
    const { unmount } = render(<SetupWizard {...props} />);
    await user.click(screen.getByRole("switch", { name: "Include Casper" }));
    await choosePlayer(user, "Host player", availablePlayers[9]!);
    await user.click(screen.getByRole("button", { name: "Assign players" }));
    await user.click(screen.getByRole("button", { name: "Start game" }));

    expect(screen.getByText("Draw roles · 9 remaining")).toBeInTheDocument();
    const casper = screen.getByRole("button", { name: "Casper: citizen" });
    expect(casper).toBeDisabled();
    expect(casper).not.toHaveAttribute("aria-haspopup");
    fireEvent.touchStart(casper, { touches: [{ clientX: 100, clientY: 100 }] });
    fireEvent.touchEnd(casper, { changedTouches: [{ clientX: 160, clientY: 102 }] });
    expect(screen.queryByRole("dialog", { name: "Choose role" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Draw role for Player 1" }));
    const assignments = onSessionStateChange.mock.lastCall?.[0].setup?.assignments;
    invokeRoleDrawBackAction(onRoleDrawBackActionChange);
    expect(screen.getByRole("switch", { name: "Include Casper" })).toBeChecked();
    const saved = onSessionStateChange.mock.lastCall?.[0];
    unmount();
    render(<SetupWizard {...props} initialSessionState={saved!} />);
    expect(screen.getByRole("switch", { name: "Include Casper" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Start game" }));
    expect(onSessionStateChange.mock.lastCall?.[0].setup?.assignments).toEqual(assignments);
    for (const player of availablePlayers.slice(1, 9)) {
      await user.click(screen.getByRole("button", { name: `Draw role for ${player.nickname}` }));
    }
    await user.click(screen.getByRole("button", { name: "Begin Mafia planning stage" }));
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete.mock.calls[0]?.[0].players[9]).toMatchObject({
      id: "casper",
      name: "Casper",
      seat: 10,
      role: "citizen",
      team: "red",
      status: "active",
    });
  });

  it("replaces only C10 when toggled and clears role progress when Casper is removed", async () => {
    const user = userEvent.setup();
    const onSessionStateChange = vi.fn();
    const onRoleDrawBackActionChange = vi.fn();
    render(
      <SetupWizard
        players={availablePlayers}
        onComplete={vi.fn()}
        initialSessionState={{ ...partialRoleSession(), step: "players" }}
        onSessionStateChange={onSessionStateChange}
        onRoleDrawBackActionChange={onRoleDrawBackActionChange}
      />,
    );
    await user.click(screen.getByRole("switch", { name: "Include Casper" }));
    expect(onSessionStateChange.mock.lastCall?.[0]).toMatchObject({
      hostPlayerId: availablePlayers[10]!.id,
      selectedPlayerIds: [...availablePlayers.slice(0, 9).map(({ id }) => id), "casper"],
      setup: null,
    });
    await user.click(screen.getByRole("button", { name: "Start game" }));
    expect(screen.getByText("Draw roles · 9 remaining")).toBeInTheDocument();
    invokeRoleDrawBackAction(onRoleDrawBackActionChange);
    await user.click(screen.getByRole("switch", { name: "Include Casper" }));
    expect(screen.getByRole("combobox", { name: "Seat 10 player" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Start game" })).toBeDisabled();
    expect(onSessionStateChange.mock.lastCall?.[0].setup).toBeNull();
    await choosePlayer(user, "Seat 10 player", availablePlayers[9]!);
    await user.click(screen.getByRole("button", { name: "Start game" }));
    expect(screen.getByText("Draw roles · 10 remaining")).toBeInTheDocument();
  });

  it("still requires ten real people with Casper and clears unavailable humans on restore", async () => {
    const user = userEvent.setup();
    const onSessionStateChange = vi.fn();
    render(
      <SetupWizard
        players={availablePlayers.slice(1, 10)}
        onComplete={vi.fn()}
        initialSessionState={{
          step: "players",
          hostPlayerId: availablePlayers[9]!.id,
          selectedPlayerIds: [...availablePlayers.slice(0, 9).map(({ id }) => id), "casper"],
          setup: null,
        }}
        onSessionStateChange={onSessionStateChange}
      />,
    );
    expect(screen.getByRole("switch", { name: "Include Casper" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Seat 1 player" })).toHaveValue("");
    expect(screen.getByText(/mark at least 10 players available/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assign players" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start game" })).toBeDisabled();
    expect(onSessionStateChange.mock.lastCall?.[0].selectedPlayerIds[9]).toBe("casper");
    const toggle = screen.getByRole("switch", { name: "Include Casper" });
    toggle.focus();
    await user.keyboard(" ");
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/mark at least 11 players available/i)).toBeInTheDocument();
  });

  it("keeps Casper selected when development players are generated", async () => {
    const user = userEvent.setup();
    const onSessionStateChange = vi.fn();
    render(
      <SetupWizard
        players={[]}
        onComplete={vi.fn()}
        showDevelopmentTools
        onPopulateDevelopmentPlayers={() => Promise.resolve(availablePlayers)}
        onSessionStateChange={onSessionStateChange}
      />,
    );
    await user.click(screen.getByRole("switch", { name: "Include Casper" }));
    await user.click(
      screen.getByRole("button", { name: /development only.*generate.*host.*10 random players/i }),
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Host player" })).toHaveValue("Player 1"),
    );
    expect(screen.getByRole("switch", { name: "Include Casper" })).toBeChecked();
    expect(onSessionStateChange.mock.lastCall?.[0].selectedPlayerIds).toEqual([
      ...availablePlayers.slice(1, 10).map(({ id }) => id),
      "casper",
    ]);
    expect(screen.getByRole("button", { name: "Start game" })).toBeEnabled();
  });

  it("localizes the Casper option without treating a human named Casper as synthetic", async () => {
    const user = userEvent.setup();
    const players = availablePlayers.map((player, index) =>
      index === 0 ? { ...player, nickname: "Casper" } : player,
    );
    const { unmount } = render(<Harness players={players} onComplete={vi.fn()} />);
    await choosePlayer(user, "Host player", players[0]!);
    expect(screen.getByRole("switch", { name: "Include Casper" })).not.toBeChecked();
    expect(screen.getByRole("combobox", { name: "Host player" })).toHaveValue("Casper");
    unmount();
    render(
      <I18nProvider locale="ru">
        <Harness onComplete={vi.fn()} />
      </I18nProvider>,
    );
    await user.click(screen.getByRole("switch", { name: "Добавить Каспера" }));
    expect(screen.getByRole("textbox", { name: "Место 10 игрок" })).toHaveValue(
      "Casper · Мирный житель",
    );
  });

  it.each(["en", "ru"] as const)(
    "keeps the role-giveaway heading free of Host view in %s",
    (locale) => {
      const { container } = render(
        <I18nProvider locale={locale}>
          <SetupWizard
            players={availablePlayers}
            onComplete={vi.fn()}
            onOpenAvailablePlayers={vi.fn()}
            initialSessionState={partialRoleSession()}
          />
        </I18nProvider>,
      );
      expect(container.querySelector(".eyebrow")).toHaveTextContent(
        locale === "en" ? "First game stage" : "Первый этап игры",
      );
      expect(container.querySelector(".eyebrow")?.textContent).not.toMatch(
        /host view|панель ведущего|режим ведущего|·\s*$/i,
      );
    },
  );

  it("renders the Russian role draw and preserves the emitted role payload", async () => {
    const user = userEvent.setup();
    const onEvent = vi.fn();
    const players = availablePlayers.map((player, index) =>
      index === 0 ? { ...player, nickname: "Иван" } : player,
    );
    const selectedPlayerIds = players.slice(0, 10).map(({ id }) => id);
    const setup = beginRoleDraw(
      createSetup(
        players
          .slice(0, 10)
          .map(({ id, nickname }, index) => ({ id, name: nickname, seat: index + 1 })),
      ),
      () => 0,
    );
    render(
      <I18nProvider locale="ru">
        <SetupWizard
          players={players}
          onComplete={() => undefined}
          onEvent={onEvent}
          initialSessionState={{
            step: "roles",
            hostPlayerId: players[10]!.id,
            selectedPlayerIds,
            setup,
          }}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("heading", { name: "Раздача ролей" })).toBeInTheDocument();
    expect(screen.getByText("Раздайте роли · осталось 10")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Стол «Мафия»" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Раздать роль игроку Иван" }));
    expect(onEvent).toHaveBeenCalledWith(
      "setup.role-drawn",
      expect.objectContaining({ seat: 1, role: expect.any(String), secret: true }),
    );
  });

  it("opens and closes manual role assignment from the keyboard", () => {
    const players = availablePlayers.slice(0, 10);
    const setup = beginRoleDraw(
      createSetup(
        players.map(({ id, nickname }, index) => ({ id, name: nickname, seat: index + 1 })),
      ),
      () => 0,
    );
    render(
      <SetupWizard
        players={availablePlayers}
        onComplete={() => undefined}
        onEvent={() => undefined}
        initialSessionState={{
          step: "roles",
          hostPlayerId: availablePlayers[10]!.id,
          selectedPlayerIds: players.map(({ id }) => id),
          setup,
        }}
      />,
    );
    const card = screen.getByRole("button", { name: "Draw role for Player 1" });
    card.focus();

    fireEvent.keyDown(card, { key: "ContextMenu" });

    const assign = screen.getAllByRole("button", { name: /Assign .* to seat 1/ })[0]!;
    expect(assign).toHaveFocus();
    fireEvent.keyDown(assign, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Choose role" })).toBeNull();
    expect(card).toHaveFocus();
  });

  it("returns from role giveaway with the selection intact and focus restored", async () => {
    const session = partialRoleSession();
    const onSessionStateChange = vi.fn();
    const onRoleDrawBackActionChange = vi.fn();
    render(
      <SetupWizard
        players={availablePlayers}
        onComplete={() => undefined}
        onSessionStateChange={onSessionStateChange}
        initialSessionState={session}
        {...({ onRoleDrawBackActionChange } as Record<string, unknown>)}
      />,
    );

    expect(onRoleDrawBackActionChange).toHaveBeenCalledWith(expect.any(Function));
    expect(screen.queryByRole("button", { name: "Back to player selection" })).toBeNull();
    invokeRoleDrawBackAction(onRoleDrawBackActionChange);

    expect(screen.getByRole("heading", { name: "Select 10 players + host" })).toHaveFocus();
    expect(screen.getByRole("combobox", { name: "Host player" })).toHaveValue("Player 11");
    expect(
      screen
        .getAllByRole("combobox", { name: /seat \d+ player/i })
        .map((seat) => (seat as HTMLInputElement).value),
    ).toEqual(availablePlayers.slice(0, 10).map(({ nickname }) => nickname));
    expect(onSessionStateChange.mock.lastCall?.[0]).toEqual({ ...session, step: "players" });
    expect(onRoleDrawBackActionChange.mock.lastCall).toEqual([null]);
    expect(screen.queryByText(session.setup.assignments[1]!)).not.toBeInTheDocument();
  });

  it("re-enters an unchanged role giveaway without resetting partial progress", async () => {
    const user = userEvent.setup();
    const session = partialRoleSession();
    const onStartGame = vi.fn();
    const onEvent = vi.fn();
    const onSessionStateChange = vi.fn();
    const onRoleDrawBackActionChange = vi.fn();
    render(
      <SetupWizard
        players={availablePlayers}
        onComplete={() => undefined}
        onStartGame={onStartGame}
        onEvent={onEvent}
        onSessionStateChange={onSessionStateChange}
        initialSessionState={session}
        onRoleDrawBackActionChange={onRoleDrawBackActionChange}
      />,
    );

    invokeRoleDrawBackAction(onRoleDrawBackActionChange);
    await user.click(screen.getByRole("button", { name: "Start game" }));

    expect(screen.getByRole("heading", { name: "Role giveaway" })).toBeInTheDocument();
    expect(onSessionStateChange.mock.lastCall?.[0]).toEqual(session);
    expect(screen.getAllByRole("button", { name: /^draw role for/i })).toHaveLength(9);
    expect(onStartGame).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("durably resets role progress when the host changes", async () => {
    const user = userEvent.setup();
    const onStartGame = vi.fn();
    const onSessionStateChange = vi.fn();
    const onRoleDrawBackActionChange = vi.fn();
    render(
      <SetupWizard
        players={playersWithReplacement}
        onComplete={() => undefined}
        onStartGame={onStartGame}
        onSessionStateChange={onSessionStateChange}
        initialSessionState={partialRoleSession()}
        onRoleDrawBackActionChange={onRoleDrawBackActionChange}
      />,
    );

    invokeRoleDrawBackAction(onRoleDrawBackActionChange);
    onSessionStateChange.mockClear();
    await choosePlayer(user, "Host player", replacementPlayer);

    await waitFor(() => expect(onSessionStateChange.mock.lastCall?.[0].setup).toBeNull());
    await user.click(screen.getByRole("button", { name: "Start game" }));
    expect(screen.getByText("Draw roles · 10 remaining")).toBeInTheDocument();
    expect(onSessionStateChange.mock.lastCall?.[0].setup.assignments).toEqual({});
    expect(onStartGame).toHaveBeenCalledOnce();
  });

  it("durably resets role progress when a seat changes", async () => {
    const user = userEvent.setup();
    const onStartGame = vi.fn();
    const onSessionStateChange = vi.fn();
    const onRoleDrawBackActionChange = vi.fn();
    render(
      <SetupWizard
        players={playersWithReplacement}
        onComplete={() => undefined}
        onStartGame={onStartGame}
        onSessionStateChange={onSessionStateChange}
        initialSessionState={partialRoleSession()}
        onRoleDrawBackActionChange={onRoleDrawBackActionChange}
      />,
    );

    invokeRoleDrawBackAction(onRoleDrawBackActionChange);
    onSessionStateChange.mockClear();
    await choosePlayer(user, "Seat 1 player", replacementPlayer);

    await waitFor(() => expect(onSessionStateChange.mock.lastCall?.[0].setup).toBeNull());
    await user.click(screen.getByRole("button", { name: "Start game" }));
    expect(screen.getByText("Draw roles · 10 remaining")).toBeInTheDocument();
    expect(onSessionStateChange.mock.lastCall?.[0].setup.assignments).toEqual({});
    expect(onStartGame).toHaveBeenCalledOnce();
  });

  it("durably resets role progress when development players replace the roster", async () => {
    const user = userEvent.setup();
    const generated = availablePlayers.map((player, index) => ({
      ...player,
      id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      nickname: `Generated ${index + 1}`,
    }));
    const onSessionStateChange = vi.fn();
    const onRoleDrawBackActionChange = vi.fn();
    render(
      <SetupWizard
        players={availablePlayers}
        onComplete={() => undefined}
        showDevelopmentTools
        onPopulateDevelopmentPlayers={() => Promise.resolve(generated)}
        onSessionStateChange={onSessionStateChange}
        initialSessionState={partialRoleSession()}
        onRoleDrawBackActionChange={onRoleDrawBackActionChange}
      />,
    );

    invokeRoleDrawBackAction(onRoleDrawBackActionChange);
    onSessionStateChange.mockClear();
    await user.click(
      screen.getByRole("button", {
        name: "Development only · Generate and select host + 10 random players",
      }),
    );

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Host player" })).toHaveValue("Generated 1"),
    );
    expect(onSessionStateChange.mock.lastCall?.[0].setup).toBeNull();
  });

  it("requires a saved host who is not assigned to a player seat", async () => {
    const user = userEvent.setup();
    const host = availablePlayers[10]!;
    render(<Harness onComplete={() => undefined} />);

    await fillPlayerSelection(user);

    expect(screen.getByRole("button", { name: /^start game$/i })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /set up music/i })).not.toBeInTheDocument();
    const firstSeat = screen.getByRole("combobox", { name: "Seat 1 player" });
    await user.click(firstSeat);
    await user.clear(firstSeat);
    await user.type(firstSeat, host.nickname);
    expect(
      within(screen.getByRole("listbox", { name: "Seat 1 suggestions" })).queryByRole("option", {
        name: host.nickname,
      }),
    ).toBeNull();

    const hostSelector = screen.getByRole("combobox", { name: "Host player" });
    await user.click(hostSelector);
    await user.clear(hostSelector);
    await user.type(hostSelector, availablePlayers[1]!.nickname);
    expect(
      within(screen.getByRole("listbox", { name: "Host suggestions" })).queryByRole("option", {
        name: availablePlayers[1]!.nickname,
      }),
    ).toBeNull();
  });

  it("scopes player search to the combobox currently being edited", async () => {
    const user = userEvent.setup();
    render(<Harness onComplete={() => undefined} />);

    const seat = screen.getByRole("combobox", { name: "Seat 1 player" });
    await user.click(seat);
    await user.type(seat, "PLAYER 10");
    const seatSuggestions = screen.getByRole("listbox", { name: "Seat 1 suggestions" });
    expect(within(seatSuggestions).getByRole("option", { name: "Player 10" })).toBeInTheDocument();
    await user.click(within(seatSuggestions).getByRole("option", { name: "Player 10" }));

    const host = screen.getByRole("combobox", { name: "Host player" });
    await user.click(host);
    await user.type(host, "PLAYER 11");
    await user.click(
      within(screen.getByRole("listbox", { name: "Host suggestions" })).getByRole("option", {
        name: "Player 11",
      }),
    );

    expect(seat).toHaveValue("Player 10");
    expect(host).toHaveValue("Player 11");
  });

  it("clears an assigned seat with a dedicated control", async () => {
    const user = userEvent.setup();
    render(<Harness onComplete={() => undefined} />);
    await fillPlayerSelection(user);

    await user.click(screen.getByRole("button", { name: "Clear Seat 1" }));

    expect(screen.getByRole("combobox", { name: "Seat 1 player" })).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Clear Seat 1" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^start game$/i })).toBeDisabled();
  });

  it("assigns ten random seats from saved players without changing the host", async () => {
    const user = userEvent.setup();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const host = availablePlayers[10]!;
    render(<Harness onComplete={() => undefined} />);

    await choosePlayer(user, "Host player", host);
    await user.click(screen.getByRole("button", { name: "Assign players" }));

    await waitFor(() =>
      expect(
        screen
          .getAllByRole("combobox", { name: /seat \d+ player/i })
          .map((seat) => (seat as HTMLInputElement).value)
          .filter(Boolean),
      ).toHaveLength(10),
    );
    const selectedNames = screen
      .getAllByRole("combobox", { name: /seat \d+ player/i })
      .map((seat) => (seat as HTMLInputElement).value);
    expect(new Set(selectedNames).size).toBe(10);
    expect(selectedNames).not.toContain(host.nickname);
    random.mockRestore();
  });

  it("prioritizes available players by hosted, fewer played, and more wins before shuffling seats", async () => {
    const user = userEvent.setup();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const host = { ...availablePlayers[10]!, nickname: "Selected Host" };
    const candidate = (
      index: number,
      nickname: string,
      hostedGames: number,
      gamesPlayed: number,
      wins: number,
    ): PlayerProfile => ({
      ...availablePlayers[index % availablePlayers.length]!,
      id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      nickname,
      statistics: {
        ...availablePlayers[0]!.statistics,
        hostedGames,
        gamesPlayed,
        wins,
        losses: Math.max(0, gamesPlayed - wins),
      },
    });
    const priorityCandidates = [
      candidate(0, "Hosted leader", 2, 100, 0),
      ...Array.from({ length: 8 }, (_, index) =>
        candidate(index + 1, `Less played ${index + 1}`, 1, 5, 1),
      ),
      candidate(9, "More wins", 1, 6, 5),
    ];
    const lowerPriority = [
      candidate(10, "Fewer wins", 1, 6, 0),
      candidate(11, "Never hosted", 0, 0, 0),
    ];
    const players = [host, ...priorityCandidates, ...lowerPriority];
    render(<Harness players={players} onComplete={() => undefined} />);

    await choosePlayer(user, "Host player", host);
    await user.click(screen.getByRole("button", { name: "Assign players" }));

    await waitFor(() =>
      expect(
        screen
          .getAllByRole("combobox", { name: /seat \d+ player/i })
          .map((seat) => (seat as HTMLInputElement).value)
          .filter(Boolean),
      ).toHaveLength(10),
    );
    const selectedNames = screen
      .getAllByRole("combobox", { name: /seat \d+ player/i })
      .map((seat) => (seat as HTMLInputElement).value);
    expect(new Set(selectedNames)).toEqual(
      new Set(priorityCandidates.map(({ nickname }) => nickname)),
    );
    expect(selectedNames).not.toContain("Fewer wins");
    expect(selectedNames).not.toContain("Never hosted");
    expect(screen.getByRole("combobox", { name: "Host player" })).toHaveValue("Selected Host");
    random.mockRestore();
  });

  it("disables player assignment when it would leave no player available to host", () => {
    render(<Harness players={availablePlayers.slice(0, 10)} onComplete={() => undefined} />);

    expect(screen.getByRole("button", { name: "Assign players" })).toBeDisabled();
    expect(
      screen
        .getAllByRole("combobox", { name: /seat \d+ player/i })
        .map((seat) => (seat as HTMLInputElement).value)
        .filter(Boolean),
    ).toHaveLength(0);
  });

  it("groups all three player setup actions in their visual order", () => {
    render(<Harness onComplete={() => undefined} />);

    expect(
      within(screen.getByRole("group", { name: "Player setup actions" }))
        .getAllByRole("button")
        .map((button) => button.textContent?.trim()),
    ).toEqual(["Select available players", "Assign players", "Start game"]);
  });

  it("generates and selects a host plus ten development players", async () => {
    const user = userEvent.setup();
    const generated = availablePlayers.map((player, index) => ({
      ...player,
      id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      nickname: `Generated ${index + 1}`,
    }));
    const onPopulateDevelopmentPlayers = vi.fn().mockResolvedValue(generated);
    render(
      <Harness
        players={[]}
        onComplete={() => undefined}
        onPopulateDevelopmentPlayers={onPopulateDevelopmentPlayers}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /development only.*generate.*host.*10 random players/i }),
    );

    expect(onPopulateDevelopmentPlayers).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Host player" })).toHaveValue(
        generated[0]!.nickname,
      ),
    );
    const seats = screen.getAllByRole("combobox", { name: /seat \d+ player/i });
    expect(seats.map((seat) => (seat as HTMLInputElement).value)).toEqual(
      generated.slice(1).map(({ nickname }) => nickname),
    );
    expect(screen.getByRole("button", { name: /^start game$/i })).toBeEnabled();
  });

  it("returns legacy music-step snapshots to the player setup with seats intact", () => {
    const selectedPlayerIds = availablePlayers.slice(0, 10).map(({ id }) => id);
    const setup = createSetup(
      availablePlayers
        .slice(0, 10)
        .map(({ id, nickname }, index) => ({ id, name: nickname, seat: index + 1 })),
    );

    render(
      <SetupWizard
        players={availablePlayers}
        onComplete={() => undefined}
        initialSessionState={{
          step: "music",
          hostPlayerId: availablePlayers[10]!.id,
          selectedPlayerIds,
          setup,
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: /select 10 players/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Seat 1 player" })).toHaveValue("Player 1");
    expect(screen.queryByText(/table music/i)).not.toBeInTheDocument();
  });

  it("returns stale restored host selection to the player step", () => {
    const selectedPlayerIds = availablePlayers.slice(0, 10).map(({ id }) => id);
    const setup = createSetup(
      availablePlayers
        .slice(0, 10)
        .map(({ id, nickname }, index) => ({ id, name: nickname, seat: index + 1 })),
    );

    render(
      <SetupWizard
        players={availablePlayers}
        onComplete={() => undefined}
        initialSessionState={{
          step: "music",
          hostPlayerId: "deleted-host",
          selectedPlayerIds,
          setup,
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: /select 10 players/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Host player" })).toHaveValue("");
  });

  it("clears restored seat selections that are no longer marked available", async () => {
    const onSessionStateChange = vi.fn();
    const selectedPlayerIds = availablePlayers.slice(0, 10).map(({ id }) => id);

    render(
      <SetupWizard
        players={availablePlayers.slice(1)}
        onComplete={() => undefined}
        onSessionStateChange={onSessionStateChange}
        initialSessionState={{
          step: "players",
          hostPlayerId: availablePlayers[10]!.id,
          selectedPlayerIds,
          setup: null,
        }}
      />,
    );

    await waitFor(() =>
      expect(onSessionStateChange.mock.lastCall?.[0]).toEqual(
        expect.objectContaining({
          hostPlayerId: availablePlayers[10]!.id,
          selectedPlayerIds: ["", ...selectedPlayerIds.slice(1)],
        }),
      ),
    );
    expect(screen.getByRole("combobox", { name: "Seat 1 player" })).toHaveValue("");
  });

  it("runs a persisted role giveaway on the table before Mafia planning", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn<(game: GameState, hostPlayerId: string, hostName: string) => void>();
    const onStartGame = vi.fn();
    const onSessionStateChange = vi.fn();
    const onEvent = vi.fn();
    render(
      <SetupWizard
        players={availablePlayers}
        bestMoveEnabled={false}
        onComplete={onComplete}
        onStartGame={onStartGame}
        onEvent={onEvent}
        onSessionStateChange={onSessionStateChange}
      />,
    );

    expect(screen.getByRole("heading", { name: /select 10 players/i })).toBeInTheDocument();
    const startGame = screen.getByRole("button", { name: /^start game$/i });
    expect(startGame).toBeDisabled();

    const selectors = screen.getAllByRole("combobox", { name: /seat \d+ player/i });
    expect(selectors).toHaveLength(10);
    await fillPlayerSelection(user);
    expect(startGame).toBeEnabled();
    await user.click(startGame);

    expect(onComplete).not.toHaveBeenCalled();
    expect(onStartGame).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "Role giveaway" })).toBeInTheDocument();
    expect(screen.getByText("Draw roles · 10 remaining")).toBeInTheDocument();
    expect(screen.getByLabelText("Mafia table")).toBeInTheDocument();
    const roleGiveaway = onSessionStateChange.mock.lastCall?.[0];
    expect(roleGiveaway).toMatchObject({
      step: "roles",
      hostPlayerId: availablePlayers[10]!.id,
      selectedPlayerIds: availablePlayers.slice(0, 10).map(({ id }) => id),
      setup: { step: "role-draw", assignments: {} },
    });
    expect(roleGiveaway?.setup?.roleDeck).toHaveLength(10);
    expect(roleGiveaway?.setup?.remainingRoles).toHaveLength(10);
    expect(onEvent).toHaveBeenCalledWith("setup.role-draw-started", {});

    const firstRoleCard = screen.getByRole("button", { name: "Draw role for Player 1" });
    fireEvent.touchStart(firstRoleCard, { touches: [{ clientX: 100, clientY: 100 }] });
    fireEvent.touchEnd(firstRoleCard, { changedTouches: [{ clientX: 160, clientY: 102 }] });
    expect(screen.getByRole("dialog", { name: "Choose role" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Assign sheriff to seat 1" }));
    expect(screen.getByRole("button", { name: /Player 1: sheriff/i })).toBeInTheDocument();

    for (const player of availablePlayers.slice(1, 10)) {
      await user.click(screen.getByRole("button", { name: `Draw role for ${player.nickname}` }));
    }

    expect(screen.getByText("Draw roles · 0 remaining")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Player 1: sheriff/i })).not.toHaveAttribute(
      "aria-haspopup",
    );
    await user.click(screen.getByRole("button", { name: "Begin Mafia planning stage" }));

    expect(onComplete).toHaveBeenCalledTimes(1);
    const completedGame = onComplete.mock.calls[0]?.[0];
    expect(completedGame?.phase).toBe("mafia-planning");
    expect(completedGame?.bestMoveEnabled).toBe(false);
    expect(completedGame?.players.map(({ role }) => role).sort()).toEqual(
      [
        "citizen",
        "citizen",
        "citizen",
        "citizen",
        "citizen",
        "citizen",
        "don",
        "mafia",
        "mafia",
        "sheriff",
      ].sort(),
    );
    expect(onComplete.mock.calls[0]?.[1]).toBe(availablePlayers[10]!.id);
    expect(onComplete.mock.calls[0]?.[2]).toBe(availablePlayers[10]!.nickname);
  });

  it("prevents duplicate selections and guides empty players to player management", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness onComplete={() => undefined} />);
    await choosePlayer(user, "Seat 1 player", availablePlayers[0]!);
    const secondSeat = screen.getByRole("combobox", { name: "Seat 2 player" });
    await user.click(secondSeat);
    await user.type(secondSeat, availablePlayers[0]!.nickname);
    expect(
      within(screen.getByRole("listbox", { name: "Seat 2 suggestions" })).queryByRole("option", {
        name: availablePlayers[0]!.nickname,
      }),
    ).toBeNull();

    unmount();
    render(<Harness players={[]} onComplete={() => undefined} />);
    expect(
      screen.getByText(/mark at least 11 players available in players & statistics/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^start game$/i })).toBeDisabled();
  });

  it("does not let role giveaway advance before the creation POST has returned a GUID", async () => {
    const onSessionStateChange = vi.fn();
    const rolePlayers = availablePlayers.slice(0, 10).map(({ id, nickname }, index) => ({
      id,
      name: nickname,
      seat: index + 1,
    }));
    render(
      <SetupWizard
        players={availablePlayers}
        initialSessionState={{
          step: "roles",
          hostPlayerId: availablePlayers[10]!.id,
          selectedPlayerIds: rolePlayers.map(({ id }) => id),
          setup: beginRoleDraw(createSetup(rolePlayers), () => 0.5),
        }}
        persistencePending
        onComplete={() => undefined}
        onSessionStateChange={onSessionStateChange}
      />,
    );

    onSessionStateChange.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Draw role for Player 1" }));

    expect(onSessionStateChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Begin Mafia planning stage" })).toBeDisabled();
  });
});

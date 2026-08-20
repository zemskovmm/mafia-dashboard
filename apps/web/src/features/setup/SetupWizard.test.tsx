import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PlayerProfile } from "../../api/client.js";
import { SetupWizard } from "./SetupWizard.js";
import { createSetup, type GameState } from "@mafia/game-domain";

vi.mock("../music/AccountPlaylistPicker.js", () => ({
  AccountPlaylistPicker: ({
    playlistId,
    onPlaylistIdChange,
  }: {
    playlistId: string;
    onPlaylistIdChange: (playlistId: string) => void;
  }) => (
    <select
      aria-label="YouTube Music playlist"
      value={playlistId}
      onChange={(event) => onPlaylistIdChange(event.target.value)}
    >
      <option value="test-playlist">Test playlist</option>
      <option value="account-playlist">Account playlist</option>
    </select>
  ),
}));

const availablePlayers: readonly PlayerProfile[] = Array.from({ length: 11 }, (_, index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  nickname: `Player ${index + 1}`,
  consent: false,
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
  },
}));

const Harness = ({
  onComplete,
  players = availablePlayers,
  onPopulateDevelopmentPlayers,
  randomFillRequest = 0,
  fullscreenTouchPicker = false,
}: {
  onComplete: (game: GameState, hostPlayerId: string, hostName: string) => void;
  players?: readonly PlayerProfile[];
  onPopulateDevelopmentPlayers?: () => Promise<readonly PlayerProfile[]>;
  randomFillRequest?: number;
  fullscreenTouchPicker?: boolean;
}) => {
  const [musicPlaying, setMusicPlaying] = useState(false);
  const [playlistId, setPlaylistId] = useState("test-playlist");
  const [musicSource, setMusicSource] = useState<"youtube" | "local">("youtube");
  return (
    <SetupWizard
      players={players}
      musicPlaying={musicPlaying}
      musicStatus={musicPlaying ? "Playing" : "Stopped"}
      playlistId={playlistId}
      onPlaylistIdChange={setPlaylistId}
      musicSource={musicSource}
      onMusicSourceChange={setMusicSource}
      onStartMusic={() => setMusicPlaying(true)}
      onQuickStopMusic={() => setMusicPlaying(false)}
      onSlowStopMusic={() => setMusicPlaying(false)}
      onComplete={onComplete}
      fullscreenTouchPicker={fullscreenTouchPicker}
      {...({
        showDevelopmentTools: onPopulateDevelopmentPlayers !== undefined,
        onPopulateDevelopmentPlayers,
        randomFillRequest,
      } as Record<string, unknown>)}
    />
  );
};

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

const fillRoster = async (user: ReturnType<typeof userEvent.setup>) => {
  await choosePlayer(user, "Host player", availablePlayers[10]!);
  for (let index = 0; index < 10; index += 1) {
    await choosePlayer(user, `Seat ${index + 1} player`, availablePlayers[index]!);
  }
};

describe("SetupWizard", () => {
  it("requires a saved host who is not assigned to a player seat", async () => {
    const user = userEvent.setup();
    const host = availablePlayers[10]!;
    render(<Harness onComplete={() => undefined} />);

    await fillRoster(user);

    expect(screen.getByRole("button", { name: /set up music.*optional/i })).toBeEnabled();
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
    expect(screen.queryByRole("searchbox", { name: /search saved players/i })).toBeNull();

    const seat = screen.getByRole("combobox", { name: "Seat 1 player" });
    await user.click(seat);
    await user.type(seat, "PLAYER 10");
    const seatSuggestions = screen.getByRole("listbox", { name: "Seat 1 suggestions" });
    expect(within(seatSuggestions).getByRole("option", { name: "Player 10" })).toBeInTheDocument();
    expect(within(seatSuggestions).queryByRole("option", { name: "Player 2" })).toBeNull();
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

  it("opens a non-editable touch picker without focusing the input in iPad fullscreen", async () => {
    const user = userEvent.setup();
    render(<Harness onComplete={() => undefined} fullscreenTouchPicker />);

    const host = screen.getByRole("combobox", { name: "Host player" });
    await user.click(host);

    expect(host).toHaveAttribute("readonly");
    expect(host).toHaveAttribute("inputmode", "none");
    expect(document.activeElement).not.toBe(host);
    expect(screen.getByRole("listbox", { name: "Host suggestions" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Player 11" }));
    expect(host).toHaveValue("Player 11");
  });

  it("randomly fills ten seats from saved players without selecting the host", async () => {
    const user = userEvent.setup();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const host = availablePlayers[10]!;
    const view = render(<Harness onComplete={() => undefined} randomFillRequest={0} />);

    await choosePlayer(user, "Host player", host);
    view.rerender(<Harness onComplete={() => undefined} randomFillRequest={1} />);

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
    expect(screen.queryByRole("button", { name: /randomly fill 10 seats/i })).toBeNull();
    random.mockRestore();
  });

  it("publishes the complete music-step snapshot before its durable setup event", async () => {
    const user = userEvent.setup();
    const onSessionStateChange = vi.fn();
    let sessionStateAtEvent: unknown;
    const onEvent = vi.fn((type: string) => {
      if (type !== "setup.players-selected") return;
      sessionStateAtEvent = onSessionStateChange.mock.lastCall?.[0];
    });
    render(
      <SetupWizard
        players={availablePlayers}
        musicPlaying={false}
        musicStatus="Stopped"
        playlistId="test-playlist"
        onPlaylistIdChange={() => undefined}
        musicSource="youtube"
        onMusicSourceChange={() => undefined}
        onStartMusic={() => undefined}
        onQuickStopMusic={() => undefined}
        onSlowStopMusic={() => undefined}
        onComplete={() => undefined}
        onEvent={onEvent}
        onSessionStateChange={onSessionStateChange}
      />,
    );
    await fillRoster(user);

    await user.click(screen.getByRole("button", { name: /set up music.*optional/i }));

    expect(onEvent).toHaveBeenCalledWith("setup.players-selected", expect.any(Object));
    expect(sessionStateAtEvent).toEqual(
      expect.objectContaining({ step: "music", setup: expect.any(Object) }),
    );
  });

  it("ignores a random fill request when it would leave no player available to host", () => {
    const view = render(
      <Harness
        players={availablePlayers.slice(0, 10)}
        onComplete={() => undefined}
        randomFillRequest={0}
      />,
    );
    view.rerender(
      <Harness
        players={availablePlayers.slice(0, 10)}
        onComplete={() => undefined}
        randomFillRequest={1}
      />,
    );

    expect(
      screen
        .getAllByRole("combobox", { name: /seat \d+ player/i })
        .map((seat) => (seat as HTMLInputElement).value)
        .filter(Boolean),
    ).toHaveLength(0);
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
    expect(screen.getByRole("button", { name: /set up music.*optional/i })).toBeEnabled();
  });

  it("restores a saved setup step and selected seats", () => {
    const selectedPlayerIds = availablePlayers.slice(0, 10).map(({ id }) => id);
    const setup = createSetup(
      availablePlayers
        .slice(0, 10)
        .map(({ id, nickname }, index) => ({ id, name: nickname, seat: index + 1 })),
    );

    render(
      <SetupWizard
        players={availablePlayers}
        musicPlaying={false}
        musicStatus="Stopped"
        playlistId="test-playlist"
        onPlaylistIdChange={() => undefined}
        musicSource="youtube"
        onMusicSourceChange={() => undefined}
        onStartMusic={() => undefined}
        onQuickStopMusic={() => undefined}
        onSlowStopMusic={() => undefined}
        onComplete={() => undefined}
        initialSessionState={{
          step: "music",
          hostPlayerId: availablePlayers[10]!.id,
          selectedPlayerIds,
          setup,
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: /table music.*optional/i })).toBeInTheDocument();
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
        musicPlaying={false}
        musicStatus="Stopped"
        playlistId="test-playlist"
        onPlaylistIdChange={() => undefined}
        musicSource="youtube"
        onMusicSourceChange={() => undefined}
        onStartMusic={() => undefined}
        onQuickStopMusic={() => undefined}
        onSlowStopMusic={() => undefined}
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

  it("runs a persisted role giveaway on the table before Mafia negotiation", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn<(game: GameState, hostPlayerId: string, hostName: string) => void>();
    const onSessionStateChange = vi.fn();
    const onEvent = vi.fn();
    render(
      <SetupWizard
        players={availablePlayers}
        musicPlaying={false}
        musicStatus="Stopped"
        playlistId="test-playlist"
        onPlaylistIdChange={() => undefined}
        musicSource="youtube"
        onMusicSourceChange={() => undefined}
        onStartMusic={() => undefined}
        onQuickStopMusic={() => undefined}
        onSlowStopMusic={() => undefined}
        onComplete={onComplete}
        onEvent={onEvent}
        onSessionStateChange={onSessionStateChange}
      />,
    );

    expect(screen.getByRole("heading", { name: /select 10 players/i })).toBeInTheDocument();
    expect(screen.queryByLabelText("Setup progress")).toBeNull();
    const startGame = screen.getByRole("button", { name: /^start game$/i });
    expect(startGame).toBeDisabled();

    const selectors = screen.getAllByRole("combobox", { name: /seat \d+ player/i });
    expect(selectors).toHaveLength(10);
    await fillRoster(user);
    expect(startGame).toBeEnabled();
    await user.click(startGame);

    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Role giveaway" })).toBeInTheDocument();
    expect(screen.getByText("Draw roles · 10 remaining")).toBeInTheDocument();
    expect(screen.getByLabelText("Mafia table")).toBeInTheDocument();
    expect(onSessionStateChange.mock.lastCall?.[0]).toEqual(
      expect.objectContaining({
        step: "roles",
        setup: expect.objectContaining({ step: "role-draw", remainingRoles: expect.any(Array) }),
      }),
    );
    expect(onEvent).toHaveBeenCalledWith("setup.role-draw-started", {});

    for (const player of availablePlayers.slice(0, 10)) {
      await user.click(screen.getByRole("button", { name: `Draw role for ${player.nickname}` }));
    }

    expect(screen.getByText("Draw roles · 0 remaining")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Begin Mafia negotiation" }));

    expect(onComplete).toHaveBeenCalledTimes(1);
    const completedGame = onComplete.mock.calls[0]?.[0];
    expect(completedGame?.phase).toBe("mafia-negotiation");
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

  it("offers music setup without requiring playback before role giveaway", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn<(game: GameState, hostPlayerId: string, hostName: string) => void>();
    render(<Harness onComplete={onComplete} />);
    await fillRoster(user);

    await user.click(screen.getByRole("button", { name: /set up music.*optional/i }));
    expect(screen.getByRole("heading", { name: /table music.*optional/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /start.*fade in/i })).toBeNull();
    const startGame = screen.getByRole("button", { name: /^start game$/i });
    expect(startGame).toBeEnabled();
    await user.click(startGame);

    expect(screen.getByRole("heading", { name: "Role giveaway" })).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("uses account playlists without exposing a generic YouTube video queue", async () => {
    const user = userEvent.setup();
    render(<Harness onComplete={() => undefined} />);

    await fillRoster(user);
    await user.click(screen.getByRole("button", { name: /set up music.*optional/i }));
    const accountPlaylist = screen.getByRole("combobox", { name: "YouTube Music playlist" });
    await user.selectOptions(accountPlaylist, "account-playlist");

    expect(accountPlaylist).toHaveValue("account-playlist");
    expect(screen.queryByRole("textbox", { name: /youtube video url or id/i })).toBeNull();
    expect(screen.queryByRole("heading", { name: /quick queue/i })).toBeNull();
  });

  it("offers a local waveform DJ mode for real oscillograms and crossfades", async () => {
    const user = userEvent.setup();
    render(<Harness onComplete={() => undefined} />);
    await fillRoster(user);
    await user.click(screen.getByRole("button", { name: /set up music.*optional/i }));

    await user.click(screen.getByRole("button", { name: "Local waveform DJ" }));

    expect(
      screen.getByText(/real oscillograms, start-point seeking, and crossfades/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "YouTube Music playlist" })).toBeNull();
    expect(screen.queryByRole("button", { name: /start.*fade in/i })).toBeNull();
  });

  it("prevents duplicate selections and guides an empty roster to player management", async () => {
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
      screen.getByText(/add at least 11 players in players & statistics/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /set up music.*optional/i })).toBeDisabled();
  });
});

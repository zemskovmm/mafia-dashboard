import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
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
}: {
  onComplete: (game: GameState, hostPlayerId: string, hostName: string) => void;
  players?: readonly PlayerProfile[];
  onPopulateDevelopmentPlayers?: () => Promise<readonly PlayerProfile[]>;
}) => {
  const [musicPlaying, setMusicPlaying] = useState(false);
  const [playlistId, setPlaylistId] = useState("test-playlist");
  return (
    <SetupWizard
      players={players}
      musicPlaying={musicPlaying}
      musicStatus={musicPlaying ? "Playing" : "Stopped"}
      playlistId={playlistId}
      onPlaylistIdChange={setPlaylistId}
      onStartMusic={() => setMusicPlaying(true)}
      onQuickStopMusic={() => setMusicPlaying(false)}
      onSlowStopMusic={() => setMusicPlaying(false)}
      onComplete={onComplete}
      {...({
        showDevelopmentTools: onPopulateDevelopmentPlayers !== undefined,
        onPopulateDevelopmentPlayers,
      } as Record<string, unknown>)}
    />
  );
};

describe("SetupWizard", () => {
  it("requires a saved host who is not assigned to a player seat", async () => {
    const user = userEvent.setup();
    const host = availablePlayers[10]!;
    render(<Harness onComplete={() => undefined} />);

    const hostSelector = screen.getByRole("combobox", { name: "Host player" });
    await user.selectOptions(hostSelector, host.id);
    const seats = screen.getAllByRole("combobox", { name: /seat \d+ player/i });
    for (let index = 0; index < seats.length; index += 1) {
      await user.selectOptions(seats[index]!, availablePlayers[index]!.id);
    }

    expect(screen.getByRole("button", { name: /continue to music/i })).toBeEnabled();
    expect(within(seats[0]!).getByRole("option", { name: host.nickname })).toBeDisabled();
    expect(
      within(hostSelector).getByRole("option", { name: availablePlayers[0]!.nickname }),
    ).toBeDisabled();
  });

  it("filters nickname choices without losing an already selected player", async () => {
    const user = userEvent.setup();
    render(<Harness onComplete={() => undefined} />);
    const seats = screen.getAllByRole("combobox", { name: /seat \d+ player/i });
    await user.selectOptions(seats[0]!, availablePlayers[0]!.id);

    await user.type(screen.getByRole("searchbox", { name: /search saved players/i }), "PLAYER 10");

    expect(seats[0]).toHaveValue(availablePlayers[0]!.id);
    expect(within(seats[0]!).getByRole("option", { name: "Player 1" })).toBeInTheDocument();
    expect(within(seats[0]!).getByRole("option", { name: "Player 10" })).toBeInTheDocument();
    expect(within(seats[0]!).queryByRole("option", { name: "Player 2" })).toBeNull();
  });

  it("randomly fills ten seats from saved players without selecting the host", async () => {
    const user = userEvent.setup();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const host = availablePlayers[10]!;
    render(<Harness onComplete={() => undefined} />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Host player" }), host.id);
    await user.click(screen.getByRole("button", { name: /randomly fill 10 seats/i }));

    const selectedIds = screen
      .getAllByRole("combobox", { name: /seat \d+ player/i })
      .map((seat) => (seat as HTMLSelectElement).value);
    expect(new Set(selectedIds).size).toBe(10);
    expect(selectedIds).not.toContain(host.id);
    expect(screen.getByRole("button", { name: /continue to music/i })).toBeEnabled();
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
        onStartMusic={() => undefined}
        onQuickStopMusic={() => undefined}
        onSlowStopMusic={() => undefined}
        onComplete={() => undefined}
        onEvent={onEvent}
        onSessionStateChange={onSessionStateChange}
      />,
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Host player" }),
      availablePlayers[10]!.id,
    );
    const seats = screen.getAllByRole("combobox", { name: /seat \d+ player/i });
    for (let index = 0; index < seats.length; index += 1) {
      await user.selectOptions(seats[index]!, availablePlayers[index]!.id);
    }

    await user.click(screen.getByRole("button", { name: /continue to music/i }));

    expect(onEvent).toHaveBeenCalledWith("setup.players-selected", expect.any(Object));
    expect(sessionStateAtEvent).toEqual(
      expect.objectContaining({ step: "music", setup: expect.any(Object) }),
    );
  });

  it("keeps random fill disabled when it would leave no player available to host", () => {
    render(<Harness players={availablePlayers.slice(0, 10)} onComplete={() => undefined} />);

    expect(screen.getByRole("button", { name: /randomly fill 10 seats/i })).toBeDisabled();
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
    expect(screen.getByRole("combobox", { name: "Host player" })).toHaveValue(generated[0]!.id);
    const seats = screen.getAllByRole("combobox", { name: /seat \d+ player/i });
    expect(seats.map((seat) => (seat as HTMLSelectElement).value)).toEqual(
      generated.slice(1).map(({ id }) => id),
    );
    expect(screen.getByRole("button", { name: /continue to music/i })).toBeEnabled();
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

    expect(screen.getByRole("heading", { name: /start table music/i })).toBeInTheDocument();
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

  it("gates ten players, music playback, and per-seat random role draws", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn<(game: GameState, hostPlayerId: string, hostName: string) => void>();
    render(<Harness onComplete={onComplete} />);

    expect(screen.getByRole("heading", { name: /select 10 players/i })).toBeInTheDocument();
    const continuePlayers = screen.getByRole("button", { name: /continue to music/i });
    expect(continuePlayers).toBeDisabled();

    const selectors = screen.getAllByRole("combobox", { name: /seat \d+ player/i });
    expect(selectors).toHaveLength(10);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Host player" }),
      availablePlayers[10]!.id,
    );
    for (let index = 0; index < selectors.length; index += 1) {
      await user.selectOptions(selectors[index]!, availablePlayers[index]!.id);
    }
    expect(continuePlayers).toBeEnabled();
    await user.click(continuePlayers);

    expect(screen.getByRole("heading", { name: /start table music/i })).toBeInTheDocument();
    const continueRoles = screen.getByRole("button", { name: /continue to role draw/i });
    expect(continueRoles).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /start.*fade in/i }));
    expect(screen.getByText(/^playing$/i)).toBeInTheDocument();
    expect(continueRoles).toBeEnabled();
    await user.click(continueRoles);

    expect(screen.getByRole("heading", { name: /draw roles at the table/i })).toBeInTheDocument();
    for (let seat = 1; seat <= 10; seat += 1) {
      await user.click(
        screen.getByRole("button", { name: new RegExp(`draw role for player ${seat}$`, "i") }),
      );
    }

    expect(screen.getByText(/roles remaining: 0/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /begin mafia negotiation/i }));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0]?.[0].phase).toBe("mafia-negotiation");
    expect(onComplete.mock.calls[0]?.[1]).toBe(availablePlayers[10]!.id);
    expect(onComplete.mock.calls[0]?.[2]).toBe(availablePlayers[10]!.nickname);
  });

  it("uses account playlists without exposing a generic YouTube video queue", async () => {
    const user = userEvent.setup();
    render(<Harness onComplete={() => undefined} />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Host player" }),
      availablePlayers[10]!.id,
    );
    const selectors = screen.getAllByRole("combobox", { name: /seat \d+ player/i });
    for (let index = 0; index < selectors.length; index += 1) {
      await user.selectOptions(selectors[index]!, availablePlayers[index]!.id);
    }
    await user.click(screen.getByRole("button", { name: /continue to music/i }));
    const accountPlaylist = screen.getByRole("combobox", { name: "YouTube Music playlist" });
    await user.selectOptions(accountPlaylist, "account-playlist");

    expect(accountPlaylist).toHaveValue("account-playlist");
    expect(screen.queryByRole("textbox", { name: /youtube video url or id/i })).toBeNull();
    expect(screen.queryByRole("heading", { name: /quick queue/i })).toBeNull();
  });

  it("prevents duplicate selections and guides an empty roster to player management", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness onComplete={() => undefined} />);
    const selectors = screen.getAllByRole("combobox", { name: /seat \d+ player/i });
    await user.selectOptions(selectors[0]!, availablePlayers[0]!.id);
    const duplicateOption = Array.from((selectors[1] as HTMLSelectElement).options).find(
      ({ value }) => value === availablePlayers[0]!.id,
    );
    expect(duplicateOption).toBeDisabled();

    unmount();
    render(<Harness players={[]} onComplete={() => undefined} />);
    expect(
      screen.getByText(/add at least 11 players in players & statistics/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue to music/i })).toBeDisabled();
  });
});

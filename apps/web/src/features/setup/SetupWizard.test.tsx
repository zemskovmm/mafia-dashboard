import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PlayerProfile } from "../../api/client.js";
import { SetupWizard } from "./SetupWizard.js";
import type { GameState } from "@mafia/game-domain";

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

const availablePlayers: readonly PlayerProfile[] = Array.from({ length: 10 }, (_, index) => ({
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
}: {
  onComplete: (game: GameState) => void;
  players?: readonly PlayerProfile[];
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
    />
  );
};

describe("SetupWizard", () => {
  it("gates ten players, music playback, and per-seat random role draws", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn<(game: GameState) => void>();
    render(<Harness onComplete={onComplete} />);

    expect(screen.getByRole("heading", { name: /select 10 players/i })).toBeInTheDocument();
    const continuePlayers = screen.getByRole("button", { name: /continue to music/i });
    expect(continuePlayers).toBeDisabled();

    const selectors = screen.getAllByRole("combobox", { name: /seat \d+ player/i });
    expect(selectors).toHaveLength(10);
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
  });

  it("uses account playlists without exposing a generic YouTube video queue", async () => {
    const user = userEvent.setup();
    render(<Harness onComplete={() => undefined} />);

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
      screen.getByText(/add at least 10 players in players & statistics/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue to music/i })).toBeDisabled();
  });
});

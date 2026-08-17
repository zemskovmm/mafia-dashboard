import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameState } from "@mafia/game-domain";
import type { PlayerProfile } from "./api/client.js";
import { App } from "./App.js";

const api = vi.hoisted(() => ({
  appendRemoteEvent: vi.fn().mockResolvedValue(undefined),
  createPlayer: vi.fn(),
  createRemoteGame: vi.fn().mockResolvedValue("00000000-0000-4000-8000-000000000099"),
  listPlayers: vi.fn(),
  saveGameResults: vi.fn().mockResolvedValue(undefined),
  updatePlayer: vi.fn(),
}));

const assignedGame = {
  phase: "mafia-negotiation",
  winner: null,
  players: Array.from({ length: 10 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: `Player ${index + 1}`,
    seat: index + 1,
    role: index === 0 ? "sheriff" : index < 7 ? "citizen" : index === 9 ? "don" : "mafia",
    status: "active",
    fouls: 0,
    mutePending: false,
  })),
} as unknown as GameState;

vi.mock("./api/client.js", () => ({
  ...api,
  ApiError: class ApiError extends Error {
    public constructor(
      message: string,
      public readonly status: number,
      public readonly code: string | null,
    ) {
      super(message);
    }
  },
}));

vi.mock("./features/setup/SetupWizard.js", () => ({
  SetupWizard: ({ onComplete }: { onComplete: (game: GameState) => void }) => (
    <main>
      <h1>Game setup</h1>
      <button type="button" onClick={() => onComplete(assignedGame)}>
        Start test game
      </button>
    </main>
  ),
}));

vi.mock("./features/game/GameScreen.js", () => ({
  GameScreen: ({
    game,
    onGameChange,
  }: {
    game: GameState;
    onGameChange: (game: GameState) => void;
  }) => (
    <main>
      <h1>Live test game</h1>
      <button
        type="button"
        onClick={() => onGameChange({ ...game, phase: "finished", winner: "red" })}
      >
        Finish test game
      </button>
    </main>
  ),
}));

vi.mock("./features/music/YouTubePlaylistPlayer.js", () => ({
  YouTubePlaylistPlayer: forwardRef(() => <div data-testid="youtube-player" />),
}));

const player = (nickname: string, id: string): PlayerProfile => ({
  id,
  nickname,
  consent: false,
  firstName: null,
  lastName: null,
  email: null,
  consentAt: null,
  createdAt: "2026-08-17T20:00:00.000Z",
  updatedAt: "2026-08-17T20:00:00.000Z",
  lastPlayedAt: null,
  statistics: {
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
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
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("App player navigation", () => {
  it("loads the roster and keeps Players & statistics separate from game setup", async () => {
    const user = userEvent.setup();
    api.listPlayers.mockResolvedValue([player("Alpha", "00000000-0000-4000-8000-000000000001")]);

    render(<App />);
    await waitFor(() => expect(api.listPlayers).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: /players & statistics/i }));

    expect(screen.getByRole("heading", { name: /players & statistics/i })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: /player alpha/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /game setup/i }));
    expect(screen.getByRole("heading", { name: /game setup/i })).toBeInTheDocument();
  });

  it("submits one retry-safe statistics snapshot when a game finishes", async () => {
    const user = userEvent.setup();
    api.listPlayers.mockResolvedValue([]);
    render(<App />);
    await waitFor(() => expect(api.createRemoteGame).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: /start test game/i }));
    await user.click(screen.getByRole("button", { name: /finish test game/i }));

    await waitFor(() => expect(api.saveGameResults).toHaveBeenCalledTimes(1));
    expect(api.saveGameResults).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000099",
      expect.objectContaining({
        winner: "red",
        players: expect.arrayContaining([
          expect.objectContaining({
            playerId: assignedGame.players[0]!.id,
            seat: 1,
            role: assignedGame.players[0]!.role,
          }),
        ]),
      }),
    );
  });
});

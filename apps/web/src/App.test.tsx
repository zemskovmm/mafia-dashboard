import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGameLogEntry,
  type CanonicalGameEventDraft,
  type GameState,
} from "@mafia/game-domain";
import type { Club, PlayerProfile, RemoteGameSession } from "./api/client.js";
import { App as WelcomeApp, ClubWorkspace } from "./App.js";
import { clearErrorConsole, reportError } from "./features/console/error-console.js";
import { musicPreferencesStorageKey } from "./features/music/music-preferences.js";
import { GLASS_SETTINGS_STORAGE_KEY } from "./features/theme/glass-settings.js";

const api = vi.hoisted(() => {
  const saveGameSession = vi.fn();
  return {
    clearAllData: vi.fn(),
    clearGameSession: vi.fn(),
    createPlayer: vi.fn(),
    deletePlayer: vi.fn(),
    getGameSession: vi.fn(),
    listActiveGameSessions: vi.fn(),
    listCompletedGameSessions: vi.fn(),
    listPlayers: vi.fn(),
    saveGameSession,
    saveGameSessionOperation: saveGameSession,
    updatePlayer: vi.fn(),
    getAuthSession: vi.fn(),
    signOut: vi.fn(),
    listClubs: vi.fn(),
    createClub: vi.fn(),
    deleteClub: vi.fn(),
    updateClub: vi.fn(),
  };
});

const gameScreenHarness = vi.hoisted(() => ({
  previewGame: null as GameState | null,
  previewOnGameChange: null as ((game: GameState) => void) | null,
  liveGame: null as GameState | null,
  liveOnGameChange: null as ((game: GameState) => void) | null,
}));

const musicPlayerHarness = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));

const hostPlayerId = "00000000-0000-4000-8000-000000000011";
const testClub: Club = {
  id: "00000000-0000-4000-8000-000000000101",
  name: "Mafia Malaga",
  city: "Málaga",
  headerLogo: null,
  cardLogo: null,
  role: "owner",
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
};
const App = () => (
  <ClubWorkspace
    club={testClub}
    onExit={() => undefined}
    onEditClub={() => undefined}
    onDeleteClub={() => Promise.resolve()}
  />
);
const assignedGame = {
  phase: "day",
  day: 1,
  winner: null,
  players: Array.from({ length: 10 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: `Player ${index + 1}`,
    seat: index + 1,
    role: index === 0 ? "sheriff" : index < 7 ? "citizen" : index === 9 ? "don" : "mafia",
    team: index >= 7 ? "black" : "red",
    status: "active",
    fouls: 0,
    mutePending: false,
  })),
  turnOrder: Array.from({ length: 10 }, (_, index) => index + 1),
  currentTurnIndex: 0,
  nominations: [],
  voteAssignments: {},
  shotAssignments: {},
} as unknown as GameState;

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

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
  SetupWizard: ({
    players,
    onComplete,
    initialSessionState,
    onSessionStateChange,
    onEvent,
    playlistId,
    onPlaylistIdChange,
    onPopulateDevelopmentPlayers,
    onOpenAvailablePlayers,
    showDevelopmentTools = false,
    fullscreenTouchPicker = false,
  }: {
    players: readonly PlayerProfile[];
    onComplete: (game: GameState, hostPlayerId: string, hostName: string) => void;
    initialSessionState?: { step: "players" | "music" | "roles" } | null;
    onSessionStateChange?: (state: {
      step: "players" | "music" | "roles";
      hostPlayerId?: string;
      selectedPlayerIds: readonly string[];
      setup: null;
    }) => void;
    onEvent: (type: string, payload: Record<string, unknown>) => void;
    playlistId: string;
    onPlaylistIdChange: (playlistId: string) => void;
    onPopulateDevelopmentPlayers?: () => Promise<readonly PlayerProfile[]>;
    onOpenAvailablePlayers?: () => void;
    showDevelopmentTools?: boolean;
    fullscreenTouchPicker?: boolean;
  }) => {
    const [step, setStep] = useState(initialSessionState?.step ?? "players");
    return (
      <main>
        <h1>
          {step === "roles" ? "Role giveaway" : step === "music" ? "Restored setup" : "Game setup"}
        </h1>
        <p>Playlist: {playlistId || "none"}</p>
        <output data-testid="setup-player-pool">
          {players.map(({ nickname }) => nickname).join(",")}
        </output>
        <output data-testid="touch-player-picker">{String(fullscreenTouchPicker)}</output>
        {onOpenAvailablePlayers === undefined ? null : (
          <button type="button" onClick={onOpenAvailablePlayers}>
            Select available players
          </button>
        )}
        <button type="button" onClick={() => onPlaylistIdChange("saved-playlist")}>
          Choose saved playlist
        </button>
        <button
          type="button"
          onClick={() => {
            setStep("music");
            onEvent("setup.players-selected", {
              hostPlayerId,
              players: [{ id: assignedGame.players[0]!.id, name: "Player 1", seat: 1 }],
            });
            onSessionStateChange?.({
              step: "music",
              hostPlayerId,
              selectedPlayerIds: [
                assignedGame.players[0]!.id,
                ...Array.from({ length: 9 }, () => ""),
              ],
              setup: null,
            });
          }}
        >
          Save setup progress
        </button>
        <button type="button" onClick={() => onComplete(assignedGame, hostPlayerId, "Host Player")}>
          Start test game
        </button>
        <button
          type="button"
          onClick={() => {
            setStep("roles");
            onSessionStateChange?.({
              step: "roles",
              hostPlayerId,
              selectedPlayerIds: Array.from({ length: 10 }, (_, index) =>
                String(index + 1).padStart(36, "0"),
              ),
              setup: null,
            });
          }}
        >
          Enter role giveaway
        </button>
        {!showDevelopmentTools || onPopulateDevelopmentPlayers === undefined ? null : (
          <button
            type="button"
            onClick={() => void onPopulateDevelopmentPlayers().catch(() => undefined)}
          >
            Generate test players
          </button>
        )}
      </main>
    );
  },
}));

vi.mock("./features/game/GameScreen.js", () => ({
  GameScreen: ({
    game,
    hostName,
    onGameChange,
    onEvent,
    onAcceptedEvent,
    mode,
    previewSequence,
    onExitPreview,
    onResetPreview,
    privacyHidden,
    onFinishGame,
    finishGameState,
  }: {
    game: GameState;
    hostName: string;
    onGameChange: (game: GameState) => void;
    onEvent: (type: string, payload: Record<string, unknown>) => void;
    onAcceptedEvent?: (event: CanonicalGameEventDraft) => void;
    mode?: "live" | "preview";
    previewSequence?: number;
    onExitPreview?: () => void;
    onResetPreview?: () => void;
    privacyHidden: boolean;
    onFinishGame: () => void;
    finishGameState: "ready" | "saving" | "saved" | "error";
  }) => {
    if (mode === "preview") {
      gameScreenHarness.previewGame = game;
      gameScreenHarness.previewOnGameChange = onGameChange;
    } else {
      gameScreenHarness.liveGame = game;
      gameScreenHarness.liveOnGameChange = onGameChange;
    }
    return mode === "preview" ? (
      <main>
        <h1>Preview game state</h1>
        <p>Preview log {previewSequence}</p>
        <button type="button" onClick={onExitPreview}>
          Exit preview
        </button>
        <button type="button" onClick={onResetPreview}>
          Reset game to this state
        </button>
      </main>
    ) : (
      <main>
        <h1>Live test game</h1>
        <p>Host: {hostName}</p>
        <p>Game day {game.day}</p>
        <p>Game turn {game.currentTurnIndex}</p>
        <p>Game fouls {game.players.reduce((total, player) => total + player.fouls, 0)}</p>
        <p>Private info {privacyHidden ? "hidden" : "visible"}</p>

        <button
          type="button"
          onClick={() => {
            const seat = game.turnOrder[game.currentTurnIndex];
            if (onAcceptedEvent !== undefined && seat !== undefined) {
              onAcceptedEvent({ type: "turn.completed", payload: { seat }, secret: false });
            } else {
              const nextTurn = game.currentTurnIndex + 1;
              onGameChange({ ...game, currentTurnIndex: nextTurn });
              onEvent("turn.completed", { turn: nextTurn });
            }
          }}
        >
          Record game action
        </button>
        <button
          type="button"
          onClick={() => {
            const foulCount = game.players.reduce((total, player) => total + player.fouls, 0);
            const player = game.players[foulCount % game.players.length];
            if (onAcceptedEvent !== undefined && player !== undefined) {
              onAcceptedEvent({
                type: "foul.issued",
                payload: { seat: player.seat, foulNumber: player.fouls + 1, redCarded: false },
                secret: false,
              });
            }
          }}
        >
          Record meaningful checkpoint
        </button>
        <button
          type="button"
          onClick={() => {
            const nextDay = game.day + 1;
            onGameChange({ ...game, day: nextDay });
            onEvent("day.started", { day: nextDay });
          }}
        >
          Start new day
        </button>
        <button type="button" onClick={() => onGameChange({ ...game, phase: "voting" })}>
          Enter voting phase
        </button>
        <button type="button" onClick={() => onGameChange({ ...game, phase: "night-mafia" })}>
          Enter night phase
        </button>
        <button
          type="button"
          onClick={() => {
            if (onAcceptedEvent !== undefined) {
              for (const player of game.players.filter(({ team }) => team === "black")) {
                onAcceptedEvent({
                  type: "player.red-carded",
                  payload: { seat: player.seat },
                  secret: false,
                });
              }
            } else onGameChange({ ...game, phase: "finished", winner: "red" });
          }}
        >
          Finish test game
        </button>
        {game.phase === "finished" ? (
          <button type="button" disabled={finishGameState === "saved"} onClick={onFinishGame}>
            {finishGameState === "saved" ? "Game safely saved" : "Finish the game"}
          </button>
        ) : null}
      </main>
    );
  },
}));

vi.mock("./features/music/YouTubePlaylistPlayer.js", () => ({
  YouTubePlaylistPlayer: forwardRef(
    (
      {
        playlistId,
        rememberedQueueOrder = [],
        onQueueOrderChange,
      }: {
        playlistId: string;
        rememberedQueueOrder?: readonly string[];
        onQueueOrderChange?: (playlistId: string, order: readonly string[]) => void;
      },
      _ref,
    ) => {
      void _ref;
      useEffect(() => {
        musicPlayerHarness.mounts += 1;
        return () => {
          musicPlayerHarness.unmounts += 1;
        };
      }, []);
      return (
        <>
          <div
            data-testid="youtube-player"
            data-playlist-id={playlistId}
            data-remembered-order={rememberedQueueOrder.join(",")}
          />
          <button
            type="button"
            aria-label="Remember mock queue order"
            onClick={() => onQueueOrderChange?.(playlistId, ["video-c:2", "video-a:0"])}
          />
        </>
      );
    },
  ),
}));

vi.mock("./features/music/AccountPlaylistPicker.js", () => ({
  AccountPlaylistPicker: ({
    playlistId,
    onPlaylistIdChange,
    onAccountDisconnected,
    stagePlaylistIds = {},
    onStagePlaylistIdsChange,
  }: {
    playlistId: string;
    onPlaylistIdChange: (playlistId: string) => void;
    onAccountDisconnected: () => void;
    stagePlaylistIds?: Partial<Record<"day" | "voting" | "night", string>>;
    onStagePlaylistIdsChange?: (
      playlistIds: Partial<Record<"day" | "voting" | "night", string>>,
    ) => void;
  }) => (
    <>
      <select
        aria-label="YouTube Music playlist"
        value={playlistId}
        onChange={(event) => onPlaylistIdChange(event.target.value)}
      >
        <option value="">No playlist</option>
        <option value="dev-playlist">Dev playlist</option>
      </select>
      <button type="button" onClick={onAccountDisconnected}>
        Disconnect account
      </button>
      {onStagePlaylistIdsChange ? (
        <select
          aria-label="Voting playlist"
          value={stagePlaylistIds.voting ?? ""}
          onChange={(event) =>
            onStagePlaylistIdsChange({ ...stagePlaylistIds, voting: event.target.value })
          }
        >
          <option value="">Use current playlist</option>
          <option value="dev-playlist">Dev playlist</option>
        </select>
      ) : null}
    </>
  ),
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
    hostedGames: 0,
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
    bestMoves: 0,
    bestMoveMafiaHits: 0,
  },
});

beforeEach(() => {
  musicPlayerHarness.mounts = 0;
  musicPlayerHarness.unmounts = 0;
  api.clearAllData.mockReset().mockResolvedValue(undefined);
  api.clearGameSession.mockReset().mockResolvedValue(undefined);
  api.createPlayer.mockReset();
  api.deletePlayer.mockReset().mockResolvedValue(undefined);
  api.getGameSession.mockReset();
  api.listActiveGameSessions.mockReset().mockResolvedValue([]);
  api.listCompletedGameSessions.mockReset().mockResolvedValue([]);
  api.listPlayers
    .mockReset()
    .mockResolvedValue([
      ...assignedGame.players.map(({ id, name }) => player(name, id)),
      player("Host Player", hostPlayerId),
    ]);
  api.saveGameSession
    .mockReset()
    .mockImplementation((_gameId: string, mutation: { baseRevision: number }) =>
      Promise.resolve({ revision: mutation.baseRevision + 1, duplicate: false }),
    );
  api.saveGameSessionOperation
    .mockReset()
    .mockImplementation((_gameId: string, operation: { baseRevision: number }) =>
      Promise.resolve({ revision: operation.baseRevision + 1, duplicate: false }),
    );
  api.updatePlayer.mockReset();
  api.getAuthSession.mockReset().mockResolvedValue({ configured: true, user: null });
  api.signOut.mockReset().mockResolvedValue(undefined);
  api.listClubs.mockReset().mockResolvedValue([]);
  api.createClub.mockReset();
  api.deleteClub.mockReset().mockResolvedValue(undefined);
  api.updateClub.mockReset();
});

afterEach(() => {
  clearErrorConsole();
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("club welcome", () => {
  it("starts with the secure Google authorization entry point", async () => {
    render(<WelcomeApp />);
    expect(screen.getByRole("heading", { name: "Choose your club" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Continue with Google" })).toHaveAttribute(
      "href",
      "/api/auth/google/start",
    );
  });

  it("offers a recoverable error when the sign-in session cannot be checked", async () => {
    api.getAuthSession.mockRejectedValue(new Error("offline"));

    render(<WelcomeApp />);

    expect(
      await screen.findByRole("alert", { name: "Sign-in status unavailable" }),
    ).toHaveTextContent("Reload this page to try again");
  });

  it("cycles through the available color schemes", async () => {
    const user = userEvent.setup();
    render(<WelcomeApp />);

    await user.click(screen.getByRole("button", { name: "Switch to Málaga gold theme" }));

    expect(document.documentElement).toHaveAttribute("data-theme", "malaga");

    await user.click(screen.getByRole("button", { name: "Switch to Málaga Glass theme" }));

    expect(document.documentElement).toHaveAttribute("data-theme", "malaga-glass");

    await user.click(screen.getByRole("button", { name: "Switch to Midnight theme" }));

    expect(document.documentElement).toHaveAttribute("data-theme", "midnight");
  });

  it("creates a club, returns to its card list, and opens the workspace through curtains", async () => {
    const user = userEvent.setup();
    api.getAuthSession.mockResolvedValue({
      configured: true,
      user: {
        id: "00000000-0000-4000-8000-000000000001",
        email: "owner@mafiamalaga.es",
        name: "Mafia Malaga owner",
        picture: null,
      },
    });
    api.listClubs.mockResolvedValue([testClub]);
    const newClub = {
      ...testClub,
      id: "00000000-0000-4000-8000-000000000202",
      name: "Mafia Sevilla",
      city: "Sevilla",
    };
    api.createClub.mockResolvedValue(newClub);
    render(<WelcomeApp />);

    await screen.findByRole("button", { name: /Mafia Malaga.*Málaga/i });
    await user.click(screen.getByRole("button", { name: /New club/i }));
    expect(screen.getByRole("heading", { name: "Create a new club" })).toBeInTheDocument();
    expect(screen.queryByText("Club identity")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Club name"), "Mafia Sevilla");
    await user.type(screen.getByLabelText("City"), "Sevilla");
    await user.click(screen.getByRole("button", { name: "Save club" }));

    expect(
      await screen.findByRole("button", { name: /Mafia Sevilla.*Sevilla/i }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Mafia Sevilla.*Sevilla/i }));
    expect(document.querySelector(".club-curtain-opening")).toBeInTheDocument();
    expect((await screen.findAllByRole("heading", { name: "Game setup" })).length).toBeGreaterThan(
      0,
    );
  });

  it("moves club editing from the welcome card into the workspace Dev menu", async () => {
    const user = userEvent.setup();
    api.getAuthSession.mockResolvedValue({
      configured: true,
      user: {
        id: "00000000-0000-4000-8000-000000000001",
        email: "owner@mafiamalaga.es",
        name: "Mafia Malaga owner",
        picture: null,
      },
    });
    api.listClubs.mockResolvedValue([testClub]);
    render(<WelcomeApp />);
    await screen.findByRole("button", { name: /Mafia Malaga.*Málaga/i });

    expect(screen.queryByRole("button", { name: "Edit Mafia Malaga" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Mafia Malaga" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Mafia Malaga.*Málaga/i }));
    await user.click(await screen.findByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Edit club" }));

    expect(screen.getByRole("heading", { name: "Edit Mafia Malaga" })).toBeInTheDocument();
    expect(screen.getByLabelText("Club name")).toHaveValue("Mafia Malaga");
  });

  it("deletes a club from Dev and returns to the welcome screen", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    api.getAuthSession.mockResolvedValue({
      configured: true,
      user: {
        id: "00000000-0000-4000-8000-000000000001",
        email: "owner@mafiamalaga.es",
        name: "Mafia Malaga owner",
        picture: null,
      },
    });
    api.listClubs.mockResolvedValue([testClub]);
    render(<WelcomeApp />);
    await screen.findByRole("button", { name: /Mafia Malaga.*Málaga/i });

    await user.click(screen.getByRole("button", { name: /Mafia Malaga.*Málaga/i }));
    await user.click(await screen.findByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Delete club" }));

    expect(confirm).toHaveBeenCalledWith(
      'Delete "Mafia Malaga" and all of its players, games, and statistics? This cannot be undone.',
    );
    expect(api.deleteClub).toHaveBeenCalledWith(testClub.id);
    expect(await screen.findByRole("heading", { name: "Choose your club" })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Mafia Malaga.*Málaga/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it("signs out the current application session", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem("mafia-dashboard.game-session.v3", "private game");
    window.sessionStorage.setItem("mafia-dashboard.game-session.v3.other-club", "private game");
    window.sessionStorage.setItem("mafia-dashboard.game-session.v4", "private game");
    window.sessionStorage.setItem("mafia-dashboard.game-session.v4.other-club", "private game");
    window.sessionStorage.setItem("unrelated", "keep");
    api.getAuthSession.mockResolvedValue({
      configured: true,
      user: {
        id: "00000000-0000-4000-8000-000000000001",
        email: "owner@mafiamalaga.es",
        name: "Mafia Malaga owner",
        picture: null,
      },
    });
    render(<WelcomeApp />);

    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(api.signOut).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem("mafia-dashboard.game-session.v3")).toBeNull();
    expect(window.sessionStorage.getItem("mafia-dashboard.game-session.v3.other-club")).toBeNull();
    expect(window.sessionStorage.getItem("mafia-dashboard.game-session.v4")).toBeNull();
    expect(window.sessionStorage.getItem("mafia-dashboard.game-session.v4.other-club")).toBeNull();
    expect(window.sessionStorage.getItem("unrelated")).toBe("keep");
    expect(await screen.findByRole("link", { name: "Continue with Google" })).toBeInTheDocument();
  });
});

describe("club roster gate", () => {
  it("opens Players, allows welcome exit, and blocks Game below eleven profiles", async () => {
    const user = userEvent.setup();
    const onExit = vi.fn();
    api.listPlayers.mockResolvedValue([]);
    render(
      <ClubWorkspace
        club={testClub}
        onExit={onExit}
        onEditClub={() => undefined}
        onDeleteClub={() => Promise.resolve()}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Players & statistics" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Mafia Malaga", { selector: ".active-club-title-name" }),
    ).toBeInTheDocument();
    expect(document.title).toBe("Mafia Malaga · Mafia Dashboard");
    expect(screen.getByText("Need 11 players · 0 registered")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Choose another club · current club Mafia Malaga" }),
    );
    expect(onExit).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Game screen" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Add 11 more registered players");
    expect(screen.getByRole("heading", { name: "Players & statistics" })).toBeInTheDocument();
  });
});

describe("developer menu", () => {
  it("previews and resets the active game from its current timeline", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));
    expect(screen.getByText("Game fouls 1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Past game timeline" }));
    expect(screen.getByText(/26\.08\.26 #1 · Checkpoint #2/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Foul 1: Player 1/i }));
    await user.click(screen.getByRole("button", { name: "Preview timeline checkpoint" }));
    expect(screen.getByRole("heading", { name: "Preview game state" })).toBeInTheDocument();
    expect(screen.getByText("Preview log 2")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Exit preview" }));
    expect(screen.getByText("Game fouls 1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Past game timeline" }));
    await user.click(screen.getByRole("button", { name: "Imported game checkpoint" }));
    await user.click(screen.getByRole("button", { name: "Reset game to timeline checkpoint" }));

    await screen.findByText("Game fouls 0");
    expect(confirm).toHaveBeenLastCalledWith(
      "Reset the active game to log #1? 1 later active action will leave the current branch. Their history will be preserved.",
    );
  });

  it("opens the full-screen past-game timeline and returns to the prior workspace", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Past game timeline" }));

    expect(screen.getByRole("heading", { name: "Game timeline" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Application tools")).toBeNull();
    expect(await screen.findByText("No completed games yet.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /back/i }));
    expect(screen.getAllByRole("heading", { name: "Game setup" })).toHaveLength(2);
    expect(screen.getByLabelText("Application tools")).toBeInTheDocument();
  });

  it("accepts a meaningful live action after inspecting a Timeline marker", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalled());
    api.saveGameSession.mockClear();

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Past game timeline" }));
    await user.click(screen.getByRole("button", { name: "Imported game checkpoint" }));
    await user.click(screen.getByRole("button", { name: /back/i }));
    await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));

    expect(screen.getByText("Game fouls 1")).toBeInTheDocument();
    await waitFor(() =>
      expect(api.saveGameSession).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ kind: "append-event" }),
        testClub.id,
      ),
    );
  });

  it("opens a full-screen error Console from Dev without changing the live session", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalled());
    const beforeConsole = window.sessionStorage.getItem("mafia-dashboard.game-session.v4");
    reportError(new Error("Captured before Console navigation"), {
      source: "application",
      context: "mafia.shots-resolved",
    });

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Console" }));
    expect(screen.getByRole("heading", { level: 1, name: "Console" })).toBeInTheDocument();
    expect(screen.getByText("Captured before Console navigation")).toBeInTheDocument();
    expect(screen.queryByLabelText("Application tools")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Live test game" })).toBeInTheDocument();
    expect(window.sessionStorage.getItem("mafia-dashboard.game-session.v4")).toBe(beforeConsole);
  });

  it("captures a handled player API failure in the Console", async () => {
    const user = userEvent.setup();
    api.listPlayers.mockRejectedValueOnce(new Error("Players endpoint failed"));
    render(<App />);
    await waitFor(() => expect(api.listPlayers).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Console" }));

    expect(screen.getByText("Players endpoint failed")).toBeInTheDocument();
    expect(screen.getByText("players.list")).toBeInTheDocument();
  });

  it("cycles the application theme from Dev", async () => {
    const user = userEvent.setup();
    api.getAuthSession.mockResolvedValue({
      configured: true,
      user: {
        id: "00000000-0000-4000-8000-000000000001",
        email: "owner@mafiamalaga.es",
        name: "Mafia Malaga owner",
        picture: null,
      },
    });
    api.listClubs.mockResolvedValue([testClub]);
    render(<WelcomeApp />);

    await user.click(await screen.findByRole("button", { name: /Mafia Malaga.*Málaga/i }));
    await user.click(await screen.findByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Use Málaga gold theme" }));

    expect(document.documentElement).toHaveAttribute("data-theme", "malaga");
    expect(screen.getByRole("button", { name: "Use Málaga Glass theme" })).toBeInTheDocument();
  });

  it("uses a dated sequence name for a new game", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-12T12:00:00"));
    render(<App />);

    expect(screen.getByRole("banner", { name: "Application status" })).toHaveTextContent(
      "Game setup · 12.02.26 #1",
    );
    vi.useRealTimers();
  });

  it("gates setup development tools behind the session Dev mode", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.queryByRole("button", { name: "Generate test players" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Enable dev mode" }));
    expect(screen.getByRole("button", { name: "Generate test players" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Past game timeline" }));
    expect(screen.getByRole("button", { name: "Generate sample game data" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Disable dev mode" }));
    expect(screen.queryByRole("button", { name: "Generate test players" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Past game timeline" }));
    expect(screen.queryByRole("button", { name: "Generate sample game data" })).toBeNull();
  });

  it("keeps the table center shadow permanent and removes its Dev setting", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("mafia-dashboard.center-shadow", "hidden");
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));

    expect(screen.queryByRole("button", { name: /table center shadow/i })).toBeNull();
    expect(document.querySelector(".app-shell")).not.toHaveClass("is-center-shadow-hidden");
  });

  it("does not expose a Day/night table indication setting", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    expect(screen.queryByRole("button", { name: /Day\/night table indication/i })).toBeNull();
    expect(window.localStorage.getItem("mafia-dashboard.day-night-indicator")).toBeNull();
  });

  it("uses the non-editable player picker on touch iPads outside fullscreen", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });

    render(<App />);

    expect(screen.getByTestId("touch-player-picker")).toHaveTextContent("true");
    Reflect.deleteProperty(navigator, "maxTouchPoints");
  });

  it("uses the non-editable player picker on Samsung Android tablets", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Linux; Android 14; SM-P613) AppleWebKit/537.36 Chrome/140 Safari/537.36",
    );
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });

    render(<App />);

    expect(screen.getByTestId("touch-player-picker")).toHaveTextContent("true");
    Reflect.deleteProperty(navigator, "maxTouchPoints");
  });

  it("keeps active game sessions in Dev without player-assignment controls", async () => {
    const user = userEvent.setup();
    api.listActiveGameSessions.mockResolvedValue([
      {
        gameId: "00000000-0000-4000-8000-0000000000d4",
        name: "Dev table",
        revision: 3,
        hostName: "Host Player",
        phase: "day",
        day: 2,
        updatedAt: "2026-08-18T12:00:00.000Z",
      },
    ]);
    render(<App />);
    await waitFor(() => expect(api.listActiveGameSessions).toHaveBeenCalledOnce());

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    expect(screen.getByRole("region", { name: "Active games" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume Dev table" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Randomly fill 10 seats" }),
    ).not.toBeInTheDocument();
  });

  it("uses one canonical status bar and opens the game players screen from Dev", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      `mafia-dashboard.available-player-ids.${testClub.id}`,
      JSON.stringify([...assignedGame.players.map(({ id }) => id), hostPlayerId]),
    );
    render(<App />);

    const status = screen.getByRole("banner", { name: "Application status" });
    expect(status).toHaveTextContent("Game setup");
    expect(status).toHaveTextContent("Select players");

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Players screen" }));

    expect(screen.getByRole("banner", { name: "Application status" })).toHaveTextContent(
      "Players & statistics",
    );
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Game screen" }));
    expect(screen.getByRole("banner", { name: "Application status" })).toHaveTextContent(
      "Game setup",
    );
  });

  it("limits setup Host and Seat choices to marked-available players", async () => {
    const [firstPlayer, secondPlayer] = assignedGame.players;
    window.localStorage.setItem(
      `mafia-dashboard.available-player-ids.${testClub.id}`,
      JSON.stringify([firstPlayer!.id, hostPlayerId]),
    );

    render(<App />);
    await waitFor(() => expect(api.listPlayers).toHaveBeenCalled());

    expect(screen.getByTestId("setup-player-pool")).toHaveTextContent(
      `${firstPlayer!.name},Host Player`,
    );
    expect(screen.getByTestId("setup-player-pool")).not.toHaveTextContent(secondPlayer!.name);
  });

  it("opens a searchable table-card availability screen and returns to setup", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(api.listPlayers).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "Select available players" }));
    expect(
      screen.getByText("Available players", { selector: ".availability-selection-card h1" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search available players" })).toBeInTheDocument();

    const firstPlayer = assignedGame.players[0]!;
    const secondPlayer = assignedGame.players[1]!;
    const firstCard = screen.getByRole("button", { name: `Mark ${firstPlayer.name} available` });
    await user.click(firstCard);
    expect(firstCard).toHaveAttribute("aria-pressed", "true");
    expect(firstCard).toHaveClass("is-availability-selected");

    await user.type(
      screen.getByRole("searchbox", { name: "Search available players" }),
      secondPlayer.name,
    );
    expect(
      screen.getByRole("button", { name: `Mark ${secondPlayer.name} available` }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: `Mark ${firstPlayer.name} unavailable` }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close available players" }));
    expect(screen.getByTestId("setup-player-pool")).toBeInTheDocument();
    expect(
      JSON.parse(
        window.localStorage.getItem(`mafia-dashboard.available-player-ids.${testClub.id}`) ??
          "null",
      ),
    ).toEqual([firstPlayer.id]);
  });

  it("uses the live table shell for the role giveaway stage", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Enter role giveaway" }));

    expect(screen.getByRole("heading", { name: "Role giveaway" })).toBeInTheDocument();
    expect(document.querySelector(".app-shell")).toHaveClass("has-live-game", "table-layout-shell");
  });

  it("keeps the save indicator inside the fixed application toolbar", () => {
    render(<App />);

    const toolbar = screen.getByLabelText("Application tools");
    expect(toolbar.querySelector(".save-indicator")).not.toBeNull();
  });

  it("renders Log with the same titled drawer shell as Dev", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Open game log" }));

    const log = screen.getByRole("dialog", { name: "Game log" });
    expect(log).toHaveClass("app-drawer", "game-log-drawer");
    expect(screen.getByRole("heading", { name: "Log" })).toBeInTheDocument();
  });

  it("keeps the compact music player mounted but hides it on Players", async () => {
    const user = userEvent.setup();
    render(<App />);
    const player = screen.getByTestId("youtube-player");
    const dock = player.closest(".youtube-dock");
    expect(dock).toHaveClass("is-compact");
    expect(dock).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Players screen" }));

    expect(screen.getByTestId("youtube-player")).toBe(player);
    expect(dock).toHaveClass("is-compact");
    expect(dock).toHaveAttribute("hidden");
    expect(dock).not.toBeVisible();
  });

  it("groups live Timer, Voting order, and the persistent music player in one side panel", async () => {
    const user = userEvent.setup();
    render(<App />);
    const player = screen.getByTestId("youtube-player");

    await user.click(screen.getByRole("button", { name: "Start test game" }));

    const rail = screen.getByRole("complementary", { name: "Live game controls" });
    expect(within(rail).getByRole("region", { name: "Timer controls" })).toBeInTheDocument();
    expect(within(rail).getByRole("region", { name: "Voting order" })).toBeInTheDocument();
    expect(rail.lastElementChild).toBe(player.closest(".youtube-dock"));
    expect(screen.getByTestId("youtube-player")).toBe(player);
  });

  it("keeps the music player mounted while previewing and exiting a log state", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    const player = screen.getByTestId("youtube-player");
    await user.click(screen.getByRole("button", { name: "Record game action" }));
    await user.click(screen.getByRole("button", { name: "Open game log" }));
    await user.click(screen.getByRole("button", { name: "Preview state after log #1" }));

    expect(screen.getByTestId("youtube-player")).toBe(player);
    expect(player.closest(".youtube-dock")).toHaveAttribute("hidden");
    expect(musicPlayerHarness).toEqual({ mounts: 1, unmounts: 0 });

    await user.click(screen.getByRole("button", { name: "Exit preview" }));
    expect(screen.getByTestId("youtube-player")).toBe(player);
    expect(musicPlayerHarness).toEqual({ mounts: 1, unmounts: 0 });
  });

  it("keeps music player setup behind the Dev menu", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.queryByRole("region", { name: "Music player setup" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    expect(screen.queryByRole("button", { name: "Reload music player" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Music player setup" }));

    expect(screen.getByRole("region", { name: "Music player setup" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload music player" })).toBeInTheDocument();
    expect(screen.getByLabelText("Low")).toHaveValue(50);
    expect(screen.getByLabelText("High")).toHaveValue(80);
    const playlist = screen.getByRole("combobox", { name: "YouTube Music playlist" });
    await user.selectOptions(playlist, "dev-playlist");
    expect(playlist).toHaveValue("dev-playlist");
  });

  it("persists and resets Málaga Glass effect settings from Dev", async () => {
    const user = userEvent.setup();
    render(
      <ClubWorkspace
        club={testClub}
        onExit={() => undefined}
        onEditClub={() => undefined}
        onDeleteClub={() => Promise.resolve()}
        colorTheme="malaga-glass"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));

    expect(screen.getByRole("group", { name: "Glass settings" })).toBeInTheDocument();
    expect(screen.getByText(/using fallback/i)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Enable glass effect" })).toBeChecked();
    for (const name of [
      "Glass thickness",
      "Bezel width",
      "Refractive index",
      "Specular opacity",
      "Specular angle",
      "Fallback opacity",
    ]) {
      expect(screen.getByRole("spinbutton", { name })).toBeInTheDocument();
    }
    const blur = screen.getByRole("spinbutton", { name: "Glass blur" });
    await user.clear(blur);
    await user.type(blur, "12");
    expect(
      JSON.parse(window.localStorage.getItem(GLASS_SETTINGS_STORAGE_KEY) ?? "null"),
    ).toMatchObject({
      blur: 12,
    });

    await user.click(screen.getByRole("button", { name: "Reset glass settings" }));
    expect(blur).toHaveValue(4);
  });

  it("restores the club's last playlist when no active game session supplies one", () => {
    window.localStorage.setItem(
      musicPreferencesStorageKey(testClub.id),
      JSON.stringify({
        version: 1,
        lastPlaylistId: "remembered-playlist",
        queueOrderByPlaylist: {},
        stagePlaylistIds: {},
      }),
    );

    render(<App />);

    expect(screen.getByText("Playlist: remembered-playlist")).toBeInTheDocument();
  });

  it("restores and updates each playlist's remembered queue order", async () => {
    window.localStorage.setItem(
      musicPreferencesStorageKey(testClub.id),
      JSON.stringify({
        version: 1,
        lastPlaylistId: "PL-base",
        queueOrderByPlaylist: { "PL-base": ["video-b:1", "video-a:0"] },
        stagePlaylistIds: {},
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    expect(screen.getByTestId("youtube-player")).toHaveAttribute(
      "data-remembered-order",
      "video-b:1,video-a:0",
    );

    await user.click(screen.getByRole("button", { name: "Remember mock queue order" }));
    expect(
      JSON.parse(window.localStorage.getItem(musicPreferencesStorageKey(testClub.id)) ?? "null"),
    ).toMatchObject({
      queueOrderByPlaylist: { "PL-base": ["video-c:2", "video-a:0"] },
    });
  });

  it("remembers a newly selected playlist for this club", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Choose saved playlist" }));

    expect(
      JSON.parse(window.localStorage.getItem(musicPreferencesStorageKey(testClub.id)) ?? "null"),
    ).toMatchObject({ version: 1, lastPlaylistId: "saved-playlist" });
  });

  it("stores stage playlist mappings from Dev music settings", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Music player setup" }));

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Voting playlist" }),
      "dev-playlist",
    );

    expect(
      JSON.parse(window.localStorage.getItem(musicPreferencesStorageKey(testClub.id)) ?? "null"),
    ).toMatchObject({ stagePlaylistIds: { voting: "dev-playlist" } });
  });

  it("hot-swaps configured playlists as the game enters Day, Voting, and Night", async () => {
    window.localStorage.setItem(
      musicPreferencesStorageKey(testClub.id),
      JSON.stringify({
        version: 1,
        lastPlaylistId: "PL-base",
        queueOrderByPlaylist: {},
        stagePlaylistIds: { day: "PL-day", voting: "PL-vote", night: "PL-night" },
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    const player = screen.getByTestId("youtube-player");

    await user.click(screen.getByRole("button", { name: "Start test game" }));
    expect(player).toHaveAttribute("data-playlist-id", "PL-day");
    await user.click(screen.getByRole("button", { name: "Enter voting phase" }));
    expect(player).toHaveAttribute("data-playlist-id", "PL-vote");
    await user.click(screen.getByRole("button", { name: "Enter night phase" }));
    expect(player).toHaveAttribute("data-playlist-id", "PL-night");
    expect(screen.getByTestId("youtube-player")).toBe(player);
    expect(musicPlayerHarness).toEqual({ mounts: 1, unmounts: 0 });
  });

  it("atomically clears mapped Day playback on account disconnect", async () => {
    window.localStorage.setItem(
      musicPreferencesStorageKey(testClub.id),
      JSON.stringify({
        version: 1,
        lastPlaylistId: "PL-base",
        queueOrderByPlaylist: {},
        stagePlaylistIds: { day: "PL-day", voting: "PL-vote", night: "PL-night" },
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    const player = screen.getByTestId("youtube-player");

    await user.click(screen.getByRole("button", { name: "Start test game" }));
    expect(player).toHaveAttribute("data-playlist-id", "PL-day");
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Music player setup" }));
    await user.click(screen.getByRole("button", { name: "Disconnect account" }));
    await act(async () => Promise.resolve());

    expect(player).toHaveAttribute("data-playlist-id", "");
    expect(
      JSON.parse(window.localStorage.getItem(musicPreferencesStorageKey(testClub.id)) ?? "null"),
    ).toEqual({
      version: 1,
      lastPlaylistId: "",
      queueOrderByPlaylist: {},
      stagePlaylistIds: {},
    });
  });

  it("keeps the fade controls directly below the persistent player during setup and live play", async () => {
    const user = userEvent.setup();
    render(<App />);

    const player = screen.getByTestId("youtube-player");
    const controls = screen.getByLabelText("Live music controls");
    expect(controls.parentElement).toBe(player.closest(".youtube-dock"));

    await user.click(screen.getByRole("button", { name: "Start test game" }));

    expect(screen.getByLabelText("Live music controls")).toBe(controls);
    expect(controls.parentElement).toBe(player.closest(".youtube-dock"));
  });

  it("keeps fullscreen, Undo, and the private mask visible across application views", async () => {
    const user = userEvent.setup();
    render(<App />);

    const fullscreen = screen.getByRole("button", { name: "Fullscreen unavailable" });
    const undo = screen.getByRole("button", { name: /undo last action.*0 available/i });
    const privacy = screen.getByRole("button", { name: "Hide private info" });
    expect(fullscreen).toBeVisible();
    expect(undo).toBeVisible();
    expect(undo).toBeDisabled();
    expect(privacy).toBeVisible();
    expect(privacy.querySelector("svg")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Players screen" }));

    expect(screen.getByRole("button", { name: "Fullscreen unavailable" })).toBe(fullscreen);
    expect(screen.getByRole("button", { name: /undo last action.*0 available/i })).toBe(undo);
    expect(screen.getByRole("button", { name: "Hide private info" })).toBe(privacy);
  });

  it("enters and exits fullscreen from the fixed application toolbar", async () => {
    const user = userEvent.setup();
    let fullscreenElement: Element | null = null;
    const requestFullscreen = vi.fn(async () => {
      fullscreenElement = document.documentElement;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    const exitFullscreen = vi.fn(async () => {
      fullscreenElement = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenElement,
    });
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: exitFullscreen,
    });
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(document.querySelector(".app-shell")).toHaveClass("is-fullscreen");
    await user.click(screen.getByRole("button", { name: "Exit fullscreen" }));
    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(document.querySelector(".app-shell")).not.toHaveClass("is-fullscreen");

    Reflect.deleteProperty(document, "fullscreenElement");
    Reflect.deleteProperty(document.documentElement, "requestFullscreen");
    Reflect.deleteProperty(document, "exitFullscreen");
  });

  it("blocks viewport touch panning while preserving internal vertical scrolling", () => {
    render(<App />);
    const shell = document.querySelector(".app-shell");
    expect(shell).toBeInstanceOf(HTMLElement);

    fireEvent.touchStart(shell!, { touches: [{ clientX: 200, clientY: 200 }] });
    expect(fireEvent.touchMove(shell!, { touches: [{ clientX: 200, clientY: 120 }] })).toBe(false);

    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, value: 50, writable: true },
    });
    shell!.append(scroller);

    fireEvent.touchStart(scroller, { touches: [{ clientX: 200, clientY: 200 }] });
    expect(fireEvent.touchMove(scroller, { touches: [{ clientX: 200, clientY: 120 }] })).toBe(true);

    scroller.scrollTop = 200;
    fireEvent.touchStart(scroller, { touches: [{ clientX: 200, clientY: 200 }] });
    expect(fireEvent.touchMove(scroller, { touches: [{ clientX: 200, clientY: 120 }] })).toBe(
      false,
    );
  });

  it("tracks the exact visual viewport height used by iPad Safari", () => {
    let height = 760;
    let resizeListener: EventListener | null = null;
    const visualViewport = {
      get height() {
        return height;
      },
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        if (type === "resize") resizeListener = listener;
      }),
      removeEventListener: vi.fn(),
    } as unknown as VisualViewport;
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: visualViewport,
    });

    render(<App />);
    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("760px");

    height = 820;
    act(() => resizeListener?.(new Event("resize")));
    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("820px");

    Reflect.deleteProperty(window, "visualViewport");
  });

  it("uses the fixed mask control to hide private game information", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    expect(screen.getByText("Private info visible")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Hide private info" }));

    expect(screen.getByText("Private info hidden")).toBeInTheDocument();
    const mask = screen.getByRole("button", { name: "Show private info" });
    expect(mask.querySelector("svg")).not.toBeNull();
  });

  it("cycles the application background through black, 33%, 66%, and white", async () => {
    const user = userEvent.setup();
    render(<App />);

    const logButton = screen.getByRole("button", { name: "Open game log" });
    const devButton = screen.getByRole("button", { name: "Open developer menu" });
    await user.click(devButton);

    expect(screen.getByRole("dialog", { name: "Developer menu" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use 33% grey background" }));
    expect(document.querySelector(".app-shell")).toHaveClass("is-background-grey-33");

    await user.click(screen.getByRole("button", { name: "Use 66% grey background" }));
    expect(document.querySelector(".app-shell")).toHaveClass("is-background-grey-66");

    await user.click(screen.getByRole("button", { name: "Use white background" }));
    expect(document.querySelector(".app-shell")).toHaveClass("is-light-background");

    await user.click(screen.getByRole("button", { name: "Use black background" }));

    expect(document.querySelector(".app-shell")).toHaveAttribute("data-background-shade", "black");
    expect(logButton).toBeVisible();
    expect(devButton).toBeVisible();
  });

  it("keeps browser-only clearing available when persistence is offline", async () => {
    const user = userEvent.setup();
    api.saveGameSession.mockRejectedValue(new Error("offline"));
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));

    expect(screen.getByRole("button", { name: "Clear all data" })).toBeEnabled();
  });

  it("clears all browser data without deleting server data", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    window.localStorage.setItem("other-local-data", "keep nowhere");
    window.sessionStorage.setItem("other-session-data", "keep nowhere");
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Clear all data" }));

    expect(confirm).toHaveBeenCalledWith(
      "Clear all data stored by Mafia Dashboard in this browser? Server players, sessions, results, and music will not be deleted.",
    );
    expect(api.clearAllData).not.toHaveBeenCalled();
    expect(screen.getByRole("banner", { name: "Application status" })).toHaveTextContent(
      "Game setup",
    );
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("resets browser-only settings and Console memory when clearing all data", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    window.localStorage.setItem(
      musicPreferencesStorageKey(testClub.id),
      JSON.stringify({
        version: 1,
        lastPlaylistId: "remembered-playlist",
        queueOrderByPlaylist: {
          "": ["stale-default:0"],
          "remembered-playlist": ["video-b:1"],
        },
        stagePlaylistIds: { voting: "dev-playlist" },
      }),
    );
    window.localStorage.setItem(GLASS_SETTINGS_STORAGE_KEY, JSON.stringify({ blur: 12 }));
    reportError(new Error("Stale Console entry"));
    render(<App />);
    const musicPlayer = screen.getByTestId("youtube-player");
    expect(musicPlayer).toHaveAttribute("data-playlist-id", "remembered-playlist");

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    expect(screen.getByRole("spinbutton", { name: "Glass blur" })).toHaveValue(12);
    await user.click(screen.getByRole("button", { name: "Clear all data" }));
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    const glassBlur = screen.getByRole("spinbutton", { name: "Glass blur" });
    await user.click(screen.getByRole("button", { name: "Music player setup" }));
    const votingPlaylist = screen.getByRole("combobox", { name: "Voting playlist" });
    await user.click(screen.getByRole("button", { name: "Console" }));

    expect({
      playlistId: musicPlayer.getAttribute("data-playlist-id"),
      rememberedOrder: musicPlayer.getAttribute("data-remembered-order"),
      votingPlaylist: (votingPlaylist as HTMLSelectElement).value,
      glassBlur: Number((glassBlur as HTMLInputElement).value),
      consoleIsEmpty: screen.queryByText("No errors have been captured.") !== null,
      localStorageItems: window.localStorage.length,
    }).toEqual({
      playlistId: "",
      rememberedOrder: "",
      votingPlaylist: "",
      glassBlur: 4,
      consoleIsEmpty: true,
      localStorageItems: 0,
    });
    expect(api.clearAllData).not.toHaveBeenCalled();
  });
});

describe("authoritative game session lifecycle", () => {
  it("persists setup without adding setup or music selections to the game log", async () => {
    const user = userEvent.setup();
    api.listPlayers.mockResolvedValue([
      ...assignedGame.players.map(({ id, name }) => player(name, id)),
      player("Host Player", hostPlayerId),
    ]);
    render(<App />);
    await waitFor(() => expect(api.listPlayers).toHaveBeenCalledOnce());
    expect(api.saveGameSession).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save setup progress" }));

    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalledOnce());
    expect(api.saveGameSession).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      expect.objectContaining({
        mutationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        baseRevision: 0,
        kind: "metadata",
        metadata: expect.objectContaining({
          setup: expect.objectContaining({ step: "music" }),
          hostPlayerId,
          hostName: "Host Player",
          legacyLog: [],
        }),
      }),
      testClub.id,
    );
  });

  it("keeps intermediate turns in memory and reloads the latest meaningful checkpoint", async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalled());
    api.saveGameSession.mockClear();

    await user.click(screen.getByRole("button", { name: "Record game action" }));
    expect(screen.getByText("Game turn 1")).toBeInTheDocument();
    await act(async () => Promise.resolve());
    expect(api.saveGameSession).not.toHaveBeenCalled();
    expect(
      JSON.parse(window.sessionStorage.getItem("mafia-dashboard.game-session.v4") ?? "null"),
    ).toMatchObject({ entries: [expect.objectContaining({ type: "game.checkpointed" })] });
    await user.click(screen.getByRole("button", { name: "Open game log" }));
    expect(screen.queryByText("turn.completed")).toBeNull();

    firstRender.unmount();
    render(<App />);
    expect(screen.getByText("Game turn 0")).toBeInTheDocument();
  });

  it("preserves a provisional ballot when a meaningful event is accepted", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    const liveGame = gameScreenHarness.liveGame;
    const changeLiveGame = gameScreenHarness.liveOnGameChange;
    if (liveGame === null || changeLiveGame === null) {
      throw new Error("Live game mutation callback was not captured");
    }

    act(() =>
      changeLiveGame({
        ...liveGame,
        phase: "voting",
        voteAssignments: { 1: 4 },
      }),
    );
    await waitFor(() => expect(gameScreenHarness.liveGame?.voteAssignments).toEqual({ 1: 4 }));

    await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));

    expect(screen.getByText("Game fouls 1")).toBeInTheDocument();
    expect(gameScreenHarness.liveGame?.voteAssignments).toEqual({ 1: 4 });
  });

  it("persists one baseline plus meaningful incremental checkpoints without game snapshots", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalled());
    api.saveGameSession.mockClear();

    await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));

    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalledOnce());
    const operation = api.saveGameSession.mock.calls[0]?.[1];
    expect(operation).toMatchObject({
      kind: "append-event",
      event: expect.objectContaining({
        type: "foul.issued",
        payload: { seat: 1, foulNumber: 1, redCarded: false },
      }),
    });
    expect(operation).not.toHaveProperty("state");
    expect(operation).not.toHaveProperty("events");
    expect(operation).not.toHaveProperty("log");
    expect(operation).not.toHaveProperty("undoHistory");
    expect(
      JSON.parse(window.sessionStorage.getItem("mafia-dashboard.game-session.v4") ?? "null"),
    ).toMatchObject({
      baseline: expect.objectContaining({
        replayVersion: 1,
        game: expect.objectContaining({ currentTurnIndex: 0, day: 1 }),
      }),
      entries: [
        expect.objectContaining({ type: "game.checkpointed" }),
        expect.objectContaining({
          type: "foul.issued",
          payload: expect.objectContaining({ seat: 1, foulNumber: 1 }),
        }),
      ],
    });
  });

  it("previews a Log state without mutation and resets by moving the active head", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));
    expect(screen.getByText("Game fouls 1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open game log" }));
    await user.click(screen.getByRole("button", { name: "Preview state after log #1" }));
    expect(screen.getByRole("heading", { name: "Preview game state" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Application tools")).toBeNull();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Exit preview",
      "Reset game to this state",
    ]);

    await user.click(screen.getByRole("button", { name: "Exit preview" }));
    expect(screen.getByText("Game fouls 1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open game log" }));
    await user.click(screen.getByRole("button", { name: "Preview state after log #1" }));
    await user.click(screen.getByRole("button", { name: "Reset game to this state" }));
    expect(screen.getByRole("heading", { name: "Preview game state" })).toBeInTheDocument();

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Reset game to this state" }));
    expect(screen.getByText("Game fouls 0")).toBeInTheDocument();
    expect(confirm).toHaveBeenLastCalledWith(
      "Reset the active game to log #1? 1 later active action will leave the current branch. Their history will be preserved.",
    );

    await user.click(screen.getByRole("button", { name: /undo last action/i }));
    expect(screen.getByText("Game fouls 1")).toBeInTheDocument();
  });

  it("keeps the live head unchanged when the server rejects a reset", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Save status: saved" })).toBeInTheDocument(),
    );
    const before = JSON.parse(
      window.sessionStorage.getItem("mafia-dashboard.game-session.v4") ?? "null",
    ) as { headEventId: string };
    api.saveGameSessionOperation.mockRejectedValueOnce(new Error("revision conflict"));

    await user.click(screen.getByRole("button", { name: "Open game log" }));
    await user.click(screen.getByRole("button", { name: "Preview state after log #1" }));
    await user.click(screen.getByRole("button", { name: "Reset game to this state" }));

    expect(screen.getByRole("heading", { name: "Preview game state" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Exit preview" }));
    expect(screen.getByText("Game fouls 1")).toBeInTheDocument();
    expect(
      JSON.parse(window.sessionStorage.getItem("mafia-dashboard.game-session.v4") ?? "null"),
    ).toMatchObject({ headEventId: before.headEventId, outbox: [] });
  });

  it("ignores a delayed component-local mutation captured during preview after exit", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await user.click(screen.getByRole("button", { name: "Record game action" }));
    expect(screen.getByText("Game turn 1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open game log" }));
    await user.click(screen.getByRole("button", { name: "Preview state after log #1" }));
    const delayedPreviewChange = gameScreenHarness.previewOnGameChange;
    const capturedPreviewGame = gameScreenHarness.previewGame;
    if (delayedPreviewChange === null || capturedPreviewGame === null) {
      throw new Error("Preview mutation callback was not captured");
    }
    await user.click(screen.getByRole("button", { name: "Exit preview" }));

    act(() => delayedPreviewChange({ ...capturedPreviewGame, currentTurnIndex: 99 }));

    expect(screen.getByText("Game turn 1")).toBeInTheDocument();
    expect(screen.queryByText("Game turn 99")).toBeNull();
  });

  it("ignores a delayed live mutation captured before undo moves the active head", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));
    await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));
    const delayedLiveChange = gameScreenHarness.liveOnGameChange;
    const capturedLiveGame = gameScreenHarness.liveGame;
    if (delayedLiveChange === null || capturedLiveGame === null) {
      throw new Error("Live mutation callback was not captured");
    }

    await user.click(screen.getByRole("button", { name: /undo last action/i }));
    expect(screen.getByText("Game fouls 1")).toBeInTheDocument();
    act(() => delayedLiveChange({ ...capturedLiveGame, currentTurnIndex: 99 }));

    expect(screen.getByText("Game fouls 1")).toBeInTheDocument();
    expect(screen.queryByText("Game turn 99")).toBeNull();
  });

  it("stores final results and returns to the initial setup after Finish the game", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalled());
    api.saveGameSession.mockClear();

    await user.click(screen.getByRole("button", { name: "Finish test game" }));
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalled());
    expect(api.saveGameSession.mock.calls.at(-1)?.[1]).toMatchObject({
      kind: "append-event",
      event: expect.objectContaining({ phaseAfter: "finished", type: "player.red-carded" }),
    });

    await user.click(screen.getByRole("button", { name: "Finish the game" }));
    await waitFor(() =>
      expect(api.saveGameSession.mock.calls.at(-1)?.[1]).toMatchObject({
        kind: "complete",
        results: expect.objectContaining({ hostPlayerId, winner: "red" }),
      }),
    );
    expect(api.saveGameSession.mock.calls.map(([, saved]) => saved)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "append-event",
          event: expect.objectContaining({ type: "game.completed" }),
        }),
      ]),
    );
    expect(await screen.findByRole("button", { name: "Start test game" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Game safely saved" })).not.toBeInTheDocument();
  });

  it("keeps Local only when the newer queued aggregate mutation fails", async () => {
    const user = userEvent.setup();
    const first = deferred<{ revision: number; duplicate: boolean }>();
    api.saveGameSession
      .mockImplementationOnce(() => first.promise)
      .mockRejectedValue(new Error("offline"));
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));
    expect(screen.getByRole("status", { name: "Save status: saving" })).toBeInTheDocument();

    first.resolve({ revision: 1, duplicate: false });

    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Save status: offline" })).toBeInTheDocument(),
    );
    expect(
      JSON.parse(window.sessionStorage.getItem("mafia-dashboard.game-session.v4") ?? "null"),
    ).toMatchObject({
      failed: true,
      outbox: expect.arrayContaining([expect.objectContaining({ baseRevision: 1 })]),
    });
  });

  it("uses latest-request-wins when two active sessions are resumed", async () => {
    const user = userEvent.setup();
    const sessionAId = "00000000-0000-4000-8000-0000000000a1";
    const sessionBId = "00000000-0000-4000-8000-0000000000b2";
    const sessionA = deferred<RemoteGameSession>();
    const sessionB = deferred<RemoteGameSession>();
    api.listActiveGameSessions.mockResolvedValue([
      {
        gameId: sessionAId,
        name: "Table A",
        revision: 4,
        hostName: "Host A",
        phase: "day",
        day: 2,
        updatedAt: "2026-08-18T08:00:00.000Z",
      },
      {
        gameId: sessionBId,
        name: "Table B",
        revision: 7,
        hostName: "Host B",
        phase: "day",
        day: 3,
        updatedAt: "2026-08-18T09:00:00.000Z",
      },
    ]);
    api.getGameSession.mockImplementation((gameId: string) =>
      gameId === sessionAId ? sessionA.promise : sessionB.promise,
    );
    const normalizedB = normalizedRemoteSession(
      remoteSession(sessionBId, "Table B", "Host B", 7, 3),
    );
    api.saveGameSessionOperation.mockImplementation(
      (_gameId: string, operation: { baseRevision: number; kind: string }) =>
        Promise.resolve(
          operation.kind === "normalize"
            ? { ...normalizedB, revision: operation.baseRevision + 1 }
            : { revision: operation.baseRevision + 1, duplicate: false },
        ),
    );
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await screen.findByRole("button", { name: "Resume Table A" });

    await user.click(screen.getByRole("button", { name: "Resume Table A" }));
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Resume Table B" }));
    sessionB.resolve(remoteSession(sessionBId, "Table B", "Host B", 7, 3));
    await screen.findByText("Host: Host B");
    sessionA.resolve(remoteSession(sessionAId, "Table A", "Host A", 4, 2));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("Host: Host B")).toBeInTheDocument();
    expect(screen.getByText("Game day 3")).toBeInTheDocument();
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalledOnce());
    expect(api.saveGameSession.mock.calls[0]?.[1]).toMatchObject({
      baseRevision: 7,
      kind: "normalize",
    });
    expect(
      JSON.parse(window.sessionStorage.getItem("mafia-dashboard.game-session.v4") ?? "null"),
    ).toMatchObject({
      gameId: sessionBId,
      revision: 8,
      baseline: { game: expect.objectContaining({ day: 3 }) },
      outbox: [],
    });
  });

  it("ignores a resume response after newer local setup is saved", async () => {
    const user = userEvent.setup();
    const remoteGameId = "00000000-0000-4000-8000-0000000000c3";
    const remote = deferred<RemoteGameSession>();
    api.listActiveGameSessions.mockResolvedValue([
      {
        gameId: remoteGameId,
        name: "Remote table",
        revision: 5,
        hostName: "Remote host",
        phase: "day",
        day: 2,
        updatedAt: "2026-08-18T09:00:00.000Z",
      },
    ]);
    api.getGameSession.mockReturnValue(remote.promise);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await screen.findByRole("button", { name: "Resume Remote table" });

    await user.click(screen.getByRole("button", { name: "Resume Remote table" }));
    await user.click(screen.getByRole("button", { name: "Save setup progress" }));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Save status: saved" })).toBeInTheDocument(),
    );
    const localGameId = api.saveGameSession.mock.calls[0]?.[0] as string;

    remote.resolve(remoteSession(remoteGameId, "Remote table", "Remote host", 5, 2));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole("heading", { name: "Restored setup" })).toBeInTheDocument();
    expect(
      JSON.parse(window.sessionStorage.getItem("mafia-dashboard.game-session.v4") ?? "null"),
    ).toMatchObject({ gameId: localGameId, revision: 1, outbox: [] });
  });

  it("restores the latest meaningful checkpoint from the durable browser aggregate", async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Save status: saved" })).toBeInTheDocument(),
    );
    const callsBeforeReload = api.saveGameSession.mock.calls.length;

    firstRender.unmount();
    render(<App />);

    expect(screen.getByRole("heading", { name: "Live test game" })).toBeInTheDocument();
    expect(screen.getByText("Host: Host Player")).toBeInTheDocument();
    expect(screen.getByText("Game fouls 1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open game log" }));
    expect(screen.getByText("foul.issued")).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.saveGameSession).toHaveBeenCalledTimes(callsBeforeReload);
  });

  it("restores setup and playlist progress from the durable browser aggregate", async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);
    await user.click(screen.getByRole("button", { name: "Choose saved playlist" }));
    await user.click(screen.getByRole("button", { name: "Save setup progress" }));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Save status: saved" })).toBeInTheDocument(),
    );

    firstRender.unmount();
    render(<App />);

    expect(screen.getByRole("heading", { name: "Restored setup" })).toBeInTheDocument();
    expect(screen.getByText("Playlist: saved-playlist")).toBeInTheDocument();
  });

  it("clears by known UUID while first save is pending and waits for the tombstone", async () => {
    const user = userEvent.setup();
    const firstSave = deferred<{ revision: number; duplicate: boolean }>();
    const clear = deferred<void>();
    api.saveGameSession.mockImplementationOnce(() => firstSave.promise);
    api.clearGameSession.mockImplementationOnce(() => clear.promise);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Save setup progress" }));
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalledOnce());
    const gameId = api.saveGameSession.mock.calls[0]?.[0] as string;

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Clear game state" }));

    expect(confirm).toHaveBeenCalledWith(
      "Delete this active game from the server? This is irreversible and removes its saved session and game log for every browser.",
    );
    expect(api.clearGameSession).toHaveBeenCalledWith(gameId, 0, testClub.id);
    expect(screen.getByRole("heading", { name: "Restored setup" })).toBeInTheDocument();
    clear.resolve();
    await screen.findByRole("heading", { name: "Game setup" });
    expect(window.sessionStorage.getItem("mafia-dashboard.game-session.v4")).toBeNull();
    firstSave.resolve({ revision: 1, duplicate: false });
  });

  it("does not reset newer local setup after an older clear completes", async () => {
    const user = userEvent.setup();
    const clear = deferred<void>();
    api.clearGameSession.mockImplementationOnce(() => clear.promise);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Save setup progress" }));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Save status: saved" })).toBeInTheDocument(),
    );
    const clearedGameId = api.saveGameSession.mock.calls[0]?.[0] as string;

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Clear game state" }));
    await user.click(screen.getByRole("button", { name: "Choose saved playlist" }));
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalledTimes(2));
    const newerGameId = api.saveGameSession.mock.calls[1]?.[0] as string;
    expect(newerGameId).not.toBe(clearedGameId);

    clear.resolve();
    await waitFor(() =>
      expect(api.clearGameSession).toHaveBeenCalledWith(clearedGameId, 1, testClub.id),
    );

    expect(screen.getByRole("heading", { name: "Restored setup" })).toBeInTheDocument();
    expect(screen.getByText("Playlist: saved-playlist")).toBeInTheDocument();
    expect(
      JSON.parse(window.sessionStorage.getItem("mafia-dashboard.game-session.v4") ?? "null"),
    ).toMatchObject({ gameId: newerGameId, metadata: { playlistId: "saved-playlist" } });
  });

  it("preserves local setup and outbox when remote clear fails", async () => {
    const user = userEvent.setup();
    api.clearGameSession.mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Save setup progress" }));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Save status: saved" })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Clear game state" }));

    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Save status: offline" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("heading", { name: "Restored setup" })).toBeInTheDocument();
    expect(
      JSON.parse(window.sessionStorage.getItem("mafia-dashboard.game-session.v4") ?? "null"),
    ).toMatchObject({
      metadata: { setup: { step: "music" } },
      failed: false,
      clearFailed: true,
    });
  });
});

const remoteSession = (
  gameId: string,
  name: string,
  restoredHostName: string,
  revision: number,
  day: number,
): RemoteGameSession => ({
  gameId,
  name,
  revision,
  duplicate: false,
  status: "active",
  updatedAt: "2026-08-18T09:00:00.000Z",
  state: {
    setup: null,
    game: { ...assignedGame, day },
    hostPlayerId,
    hostName: restoredHostName,
    playlistId: `PL-${name}`,
    log: [],
    undoHistory: [],
  },
  results: null,
});

const normalizedRemoteSession = (session: RemoteGameSession): RemoteGameSession => {
  const game = session.state.game as GameState | null;
  if (game === null) throw new Error("A normalization fixture requires a game");
  const baseline = { replayVersion: 1 as const, game };
  const started = createGameLogEntry({
    gameId: session.gameId,
    id: "00000000-0000-4000-8000-0000000000dd",
    sequence: 1,
    parentEventId: null,
    createdAt: "2026-08-18T09:00:00.000Z",
    before: game,
    draft: { type: "game.checkpointed", payload: {}, secret: true },
  });
  return {
    ...session,
    state: {
      ...session.state,
      game: null,
      initialGame: baseline,
      events: [started.entry],
      headEventId: started.entry.id,
      resetReturnEventId: null,
    },
  };
};

describe("undo checkpoints", () => {
  it("does not let cursor Undo cross the immutable game baseline", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    expect(screen.getByRole("button", { name: /undo last action/i })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));
    await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));
    expect(screen.getByText("Game fouls 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /undo last action/i })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /undo last action/i }));
    await user.click(screen.getByRole("button", { name: /undo last action/i }));
    expect(screen.getByText("Game fouls 0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /undo last action/i })).toBeDisabled();
  });

  it("preserves the remaining ordinary undo budget across reload", async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    for (let index = 0; index < 4; index += 1) {
      await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));
    }
    await user.click(screen.getByRole("button", { name: /undo last action/i }));
    await user.click(screen.getByRole("button", { name: /undo last action/i }));
    expect(screen.getByText("Game fouls 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /undo last action.*1 available/i })).toBeEnabled();
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Save status: saved" })).toBeInTheDocument(),
    );

    firstRender.unmount();
    render(<App />);

    expect(screen.getByText("Game fouls 2")).toBeInTheDocument();
    const remainingUndo = screen.getByRole("button", {
      name: /undo last action.*1 available/i,
    });
    await user.click(remainingUndo);
    expect(screen.getByText("Game fouls 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /undo last action.*0 available/i })).toBeDisabled();
  });

  it("preserves the pre-reset undo budget across reload and reset return", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const firstRender = render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    for (let index = 0; index < 3; index += 1) {
      await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));
    }
    await user.click(screen.getByRole("button", { name: /undo last action/i }));
    expect(screen.getByRole("button", { name: /undo last action.*2 available/i })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Open game log" }));
    await user.click(screen.getByRole("button", { name: "Preview state after log #1" }));
    await user.click(screen.getByRole("button", { name: "Reset game to this state" }));
    expect(screen.getByText("Game fouls 0")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Save status: saved" })).toBeInTheDocument(),
    );

    firstRender.unmount();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /undo last action.*1 available/i }));

    expect(screen.getByText("Game fouls 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /undo last action.*2 available/i })).toBeEnabled();
  });

  it("retains only three ordinary actions and undo removes matching log state", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    for (let index = 0; index < 4; index += 1) {
      await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));
    }
    expect(screen.getByText("Game fouls 4")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open game log" }));
    expect(screen.getAllByText("foul.issued")).toHaveLength(4);

    for (let index = 0; index < 3; index += 1) {
      await user.click(screen.getByRole("button", { name: /undo last action/i }));
    }
    expect(screen.getByText("Game fouls 1")).toBeInTheDocument();
    expect(screen.getAllByText("foul.issued")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /undo last action/i })).toBeDisabled();
  });
});

describe("player workflows", () => {
  it("loads players separately and protects the current roster from deletion", async () => {
    const user = userEvent.setup();
    api.listPlayers.mockResolvedValue([
      ...assignedGame.players.map(({ id, name }) => player(name, id)),
      player("Host Player", hostPlayerId),
    ]);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Players screen" }));

    expect(screen.getByRole("heading", { name: "Players & statistics" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Player 1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Host Player" })).toBeDisabled();
  });

  it("creates one host and ten nickname-only development players", async () => {
    const user = userEvent.setup();
    let created = 0;
    api.createPlayer.mockImplementation(async (input: { nickname: string }) => {
      created += 1;
      return player(input.nickname, `10000000-0000-4000-8000-${String(created).padStart(12, "0")}`);
    });
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Enable dev mode" }));
    await user.click(screen.getByRole("button", { name: "Generate test players" }));

    await waitFor(() => expect(api.createPlayer).toHaveBeenCalledTimes(11));
    expect(new Set(api.createPlayer.mock.calls.map(([input]) => input.nickname)).size).toBe(11);
  });

  it("rolls back a partially created development roster", async () => {
    const user = userEvent.setup();
    const first = player("Dev First", "00000000-0000-4000-8000-000000000001");
    const second = player("Dev Second", "00000000-0000-4000-8000-000000000002");
    api.createPlayer
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockRejectedValueOnce(new Error("network unavailable"));
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Enable dev mode" }));
    await user.click(screen.getByRole("button", { name: "Generate test players" }));

    await waitFor(() => expect(api.deletePlayer).toHaveBeenCalledTimes(2));
    expect(api.deletePlayer).toHaveBeenCalledWith(first.id, testClub.id);
    expect(api.deletePlayer).toHaveBeenCalledWith(second.id, testClub.id);
  });
});

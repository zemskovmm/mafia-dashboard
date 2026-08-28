import {
  act,
  cleanup,
  fireEvent,
  render as renderView,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGameLogEntry,
  replayGameLog,
  resolveMafiaShots,
  toggleAllMafiaShotsForTarget,
  type CanonicalGameEventDraft,
  type GameState,
  type InitialGameBaseline,
  type GameLogEntry,
} from "@mafia/game-domain";
import { ApiError, type Club, type PlayerProfile, type RemoteGameSession } from "./api/client.js";
import { App as WelcomeApp, ClubWorkspace } from "./App.js";
import {
  clearErrorConsole,
  getErrorConsoleSnapshot,
  reportError,
} from "./features/console/error-console.js";
import { musicPreferencesStorageKey } from "./features/music/music-preferences.js";
import { I18nProvider } from "./i18n/I18nProvider.js";
import { THEME_COLOR_STORAGE_KEY } from "./theme.js";

const api = vi.hoisted(() => {
  const saveGameSession = vi.fn();
  return {
    checkServerReady: vi.fn(),
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
  liveOnAcceptedEvent: null as ((event: CanonicalGameEventDraft) => void) | null,
}));

const musicPlayerHarness = vi.hoisted(() => ({
  mounts: 0,
  unmounts: 0,
  setState: null as ((state: "idle" | "loading" | "playing" | "paused" | "error") => void) | null,
  startOpeningQueue: vi.fn(() => true),
  playFirstRegularTrack: vi.fn(() => true),
  quickFadeOut: vi.fn(() => Promise.resolve()),
  slowFadeOut: vi.fn(() => Promise.resolve()),
  shuffleQueue: vi.fn(() => true),
}));

const hostPlayerId = "00000000-0000-4000-8000-000000000011";
const testClub: Club = {
  id: "00000000-0000-4000-8000-000000000101",
  name: "Mafia Malaga",
  city: "Málaga",
  headerLogo: null,
  cardLogo: null,
  language: "en",
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
const render = (...args: Parameters<typeof renderView>): ReturnType<typeof renderView> => {
  const result = renderView(...args);
  const privacy = screen.queryByRole("button", { name: /private info/i });
  if (privacy !== null) {
    for (let tap = 0; tap < 6; tap += 1) fireEvent.click(privacy);
  }
  return result;
};
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
    onStartGame = () => undefined,
    initialSessionState,
    onSessionStateChange,
    onEvent,
    onPopulateDevelopmentPlayers,
    onOpenAvailablePlayers,
    showDevelopmentTools = false,
  }: {
    players: readonly PlayerProfile[];
    onComplete: (game: GameState, hostPlayerId: string, hostName: string) => void;
    onStartGame?: () => void;
    initialSessionState?: { step: "players" | "music" | "roles" } | null;
    onSessionStateChange?: (state: {
      step: "players" | "music" | "roles";
      hostPlayerId?: string;
      selectedPlayerIds: readonly string[];
      setup: null;
    }) => void;
    onEvent: (type: string, payload: Record<string, unknown>) => void;
    onPopulateDevelopmentPlayers?: () => Promise<readonly PlayerProfile[]>;
    onOpenAvailablePlayers?: () => void;
    showDevelopmentTools?: boolean;
  }) => {
    const [step, setStep] = useState(initialSessionState?.step ?? "players");
    return (
      <main>
        <h1>
          {step === "roles" ? "Role giveaway" : step === "music" ? "Restored setup" : "Game setup"}
        </h1>
        <output data-testid="setup-player-pool">
          {players.map(({ nickname }) => nickname).join(",")}
        </output>
        {onOpenAvailablePlayers === undefined ? null : (
          <button type="button" onClick={onOpenAvailablePlayers}>
            Select available players
          </button>
        )}
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
            onStartGame();
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
    finishGameState: "ready" | "saving" | "saved" | "queued";
  }) => {
    if (mode === "preview") {
      gameScreenHarness.previewGame = game;
      gameScreenHarness.previewOnGameChange = onGameChange;
    } else {
      gameScreenHarness.liveGame = game;
      gameScreenHarness.liveOnGameChange = onGameChange;
      gameScreenHarness.liveOnAcceptedEvent = onAcceptedEvent ?? null;
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
              onAcceptedEvent({ type: "turn.completed", payload: { seat } });
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
            const nominatorSeat = game.turnOrder[game.currentTurnIndex];
            if (onAcceptedEvent !== undefined && nominatorSeat !== undefined) {
              onAcceptedEvent({
                type: "player.nominated",
                payload: { nominatorSeat, candidateSeat: 4 },
              });
            }
          }}
        >
          Record nomination
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
                });
              }
            } else onGameChange({ ...game, phase: "finished", winner: "red" });
          }}
        >
          Finish test game
        </button>
        {game.phase === "finished" ? (
          <button type="button" disabled={finishGameState !== "ready"} onClick={onFinishGame}>
            {finishGameState === "saved"
              ? "Game safely saved"
              : finishGameState === "queued"
                ? "Game saved offline"
                : finishGameState === "saving"
                  ? "Saving game…"
                  : "Finish the game"}
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
        onStateChange,
        initialStageEntryKeys = [],
        onInitialStageEntryKeysChange,
        endgameEntryKeys = [],
        onEndgameEntryKeysChange,
      }: {
        playlistId: string;
        rememberedQueueOrder?: readonly string[];
        onQueueOrderChange?: (playlistId: string, order: readonly string[]) => void;
        onStateChange: (state: "idle" | "loading" | "playing" | "paused" | "error") => void;
        initialStageEntryKeys?: readonly string[];
        onInitialStageEntryKeysChange?: (playlistId: string, entryKeys: readonly string[]) => void;
        endgameEntryKeys?: readonly string[];
        onEndgameEntryKeysChange?: (playlistId: string, entryKeys: readonly string[]) => void;
      },
      ref,
    ) => {
      musicPlayerHarness.setState = onStateChange;
      useImperativeHandle(ref, () => ({
        fadeIn: () => Promise.resolve(true),
        quickFadeOut: musicPlayerHarness.quickFadeOut,
        slowFadeOut: musicPlayerHarness.slowFadeOut,
        startOpeningQueue: musicPlayerHarness.startOpeningQueue,
        playFirstRegularTrack: musicPlayerHarness.playFirstRegularTrack,
        shuffleQueue: musicPlayerHarness.shuffleQueue,
      }));
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
            data-initial-keys={initialStageEntryKeys.join(",")}
            data-endgame-keys={endgameEntryKeys.join(",")}
          />
          <button
            type="button"
            aria-label="Remember mock queue order"
            onClick={() => onQueueOrderChange?.(playlistId, ["video-c:2", "video-a:0"])}
          />
          <button
            type="button"
            aria-label="Remember mock queue tags"
            onClick={() => {
              onInitialStageEntryKeysChange?.(playlistId, ["video-a:0"]);
              onEndgameEntryKeysChange?.(playlistId, ["video-c:2"]);
            }}
          />
          <button
            type="button"
            aria-label={`${initialStageEntryKeys.includes("video-a:0") ? "Unmark" : "Mark"} mock Initial`}
            onClick={() =>
              onInitialStageEntryKeysChange?.(
                playlistId,
                initialStageEntryKeys.includes("video-a:0")
                  ? initialStageEntryKeys.filter((entryKey) => entryKey !== "video-a:0")
                  : [...initialStageEntryKeys, "video-a:0"],
              )
            }
          />
          <button
            type="button"
            aria-label={`${endgameEntryKeys.includes("video-a:0") ? "Unmark" : "Mark"} mock Endgame`}
            onClick={() =>
              onEndgameEntryKeysChange?.(
                playlistId,
                endgameEntryKeys.includes("video-a:0")
                  ? endgameEntryKeys.filter((entryKey) => entryKey !== "video-a:0")
                  : [...endgameEntryKeys, "video-a:0"],
              )
            }
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
  }: {
    playlistId: string;
    onPlaylistIdChange: (playlistId: string) => void;
    onAccountDisconnected: () => void;
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
    </>
  ),
}));

const player = (nickname: string, id: string): PlayerProfile => ({
  id,
  nickname,
  consent: false,
  clubManager: false,
  managerLocked: false,
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
  gameScreenHarness.previewGame = null;
  gameScreenHarness.previewOnGameChange = null;
  gameScreenHarness.liveGame = null;
  gameScreenHarness.liveOnGameChange = null;
  gameScreenHarness.liveOnAcceptedEvent = null;
  musicPlayerHarness.mounts = 0;
  musicPlayerHarness.unmounts = 0;
  musicPlayerHarness.setState = null;
  musicPlayerHarness.startOpeningQueue.mockReset().mockReturnValue(true);
  musicPlayerHarness.playFirstRegularTrack.mockReset().mockReturnValue(true);
  musicPlayerHarness.quickFadeOut.mockReset().mockResolvedValue(undefined);
  musicPlayerHarness.slowFadeOut.mockReset().mockResolvedValue(undefined);
  musicPlayerHarness.shuffleQueue.mockReset().mockReturnValue(true);
  api.checkServerReady.mockReset().mockResolvedValue(undefined);
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
  vi.useRealTimers();
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

  it("applies and persists the selected glass color", () => {
    render(<WelcomeApp />);

    fireEvent.change(screen.getByLabelText("Glass color"), { target: { value: "#7170ff" } });

    expect(document.documentElement.style.getPropertyValue("--theme-base")).toBe("#7170ff");
    expect(document.documentElement).not.toHaveAttribute("data-theme");
    expect(window.localStorage.getItem(THEME_COLOR_STORAGE_KEY)).toBe("#7170ff");
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
    await user.click(
      screen.getByRole("checkbox", {
        name: "I consent to store my Google name and email in the Owner player profile.",
      }),
    );
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

  it("moves club editing from the welcome card into the workspace Manage menu", async () => {
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
    await user.click(await screen.findByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Edit club" }));

    expect(screen.getByRole("heading", { name: "Edit Mafia Malaga" })).toBeInTheDocument();
    expect(screen.getByLabelText("Club name")).toHaveValue("Mafia Malaga");
  });

  it("switches from browser locale to club locale and persists live language changes", async () => {
    const user = userEvent.setup();
    const russianClub = { ...testClub, language: "ru" as const };
    const englishClub = { ...russianClub, language: "en" as const };
    api.getAuthSession.mockResolvedValue({
      configured: true,
      user: {
        id: "00000000-0000-4000-8000-000000000001",
        email: "owner@mafiamalaga.es",
        name: "Mafia Malaga owner",
        picture: null,
      },
    });
    api.listClubs.mockResolvedValue([russianClub]);
    api.updateClub.mockResolvedValue(englishClub);
    render(
      <I18nProvider>
        <WelcomeApp />
      </I18nProvider>,
    );

    await user.click(await screen.findByRole("button", { name: /Mafia Malaga.*Málaga/i }));
    const player = await screen.findByTestId("youtube-player");
    await user.click(await screen.findByRole("button", { name: "Открыть меню управления" }));
    const language = screen.getByRole("combobox", { name: "Язык" });
    expect(language).toHaveValue("ru");

    await user.selectOptions(language, "en");
    await waitFor(() =>
      expect(api.updateClub).toHaveBeenCalledWith(russianClub.id, {
        name: russianClub.name,
        city: russianClub.city,
        headerLogo: null,
        cardLogo: null,
        language: "en",
      }),
    );
    expect(await screen.findByRole("combobox", { name: "Language" })).toHaveValue("en");
    expect(screen.getByTestId("youtube-player")).toBe(player);

    await user.click(
      screen.getByRole("button", { name: "Choose another club · current club Mafia Malaga" }),
    );
    expect(await screen.findByRole("heading", { name: "Choose your club" })).toBeInTheDocument();
  });

  it("deletes a club from Manage and returns to the welcome screen", async () => {
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
    await user.click(await screen.findByRole("button", { name: "Open Manage menu" }));
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
    window.localStorage.setItem("mafia-dashboard.game-session.v3", "private game");
    window.localStorage.setItem("mafia-dashboard.game-session.v3.other-club", "private game");
    window.localStorage.setItem("mafia-dashboard.game-session.v4", "private game");
    window.localStorage.setItem("mafia-dashboard.game-session.v4.other-club", "private game");
    window.localStorage.setItem("unrelated-local", "keep");
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
    expect(window.localStorage.getItem("mafia-dashboard.game-session.v3")).toBeNull();
    expect(window.localStorage.getItem("mafia-dashboard.game-session.v3.other-club")).toBeNull();
    expect(window.localStorage.getItem("mafia-dashboard.game-session.v4")).toBeNull();
    expect(window.localStorage.getItem("mafia-dashboard.game-session.v4.other-club")).toBeNull();
    expect(window.localStorage.getItem("unrelated-local")).toBe("keep");
    expect(window.sessionStorage.getItem("mafia-dashboard.game-session.v3")).toBeNull();
    expect(window.sessionStorage.getItem("mafia-dashboard.game-session.v3.other-club")).toBeNull();
    expect(window.sessionStorage.getItem("mafia-dashboard.game-session.v4")).toBeNull();
    expect(window.sessionStorage.getItem("mafia-dashboard.game-session.v4.other-club")).toBeNull();
    expect(window.sessionStorage.getItem("unrelated")).toBe("keep");
    expect(await screen.findByRole("link", { name: "Continue with Google" })).toBeInTheDocument();
  });
});

describe("workspace localization", () => {
  it("renders Russian shell status, controls, and Manage copy", async () => {
    const user = userEvent.setup();
    api.listPlayers.mockResolvedValue([]);

    renderView(
      <I18nProvider locale="ru">
        <ClubWorkspace
          club={{ ...testClub, language: "ru" }}
          onExit={() => undefined}
          onEditClub={() => undefined}
          onDeleteClub={() => Promise.resolve()}
        />
      </I18nProvider>,
    );

    expect(await screen.findByRole("banner", { name: "Статус приложения" })).toHaveTextContent(
      "Требуется 11 игроков · зарегистрировано: 0",
    );
    expect(screen.getByLabelText("Инструменты приложения")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Открыть меню управления" }));

    const manage = screen.getByRole("dialog", { name: "Управление" });
    expect(within(manage).getByRole("button", { name: "Начать новую игру" })).toBeInTheDocument();
    expect(within(manage).getByRole("button", { name: "Экран игроков" })).toBeInTheDocument();
    expect(
      within(manage).getByRole("button", { name: "Настройка музыкального плеера" }),
    ).toBeInTheDocument();
  });
});

describe("club player gate", () => {
  it("opens Players, allows welcome exit, and blocks a new game below eleven profiles", async () => {
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

    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Start new game" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Add 11 more registered players");
    expect(screen.getByRole("heading", { name: "Players & statistics" })).toBeInTheDocument();
  });
});

describe("manage menu", () => {
  it("owns ordinary club, game, player, music, and active-game workflows", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));

    const manage = screen.getByRole("dialog", { name: "Manage" });
    for (const name of [
      "Start new game",
      "Players screen",
      "Music player setup",
      "Edit club",
      "Delete club",
    ]) {
      expect(within(manage).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(within(manage).getByLabelText("Glass color")).toHaveAttribute("type", "color");
    expect(within(manage).getByRole("region", { name: "Active games" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    const dev = screen.getByRole("dialog", { name: "Developer menu" });
    expect(within(dev).queryByRole("button", { name: "Players screen" })).not.toBeInTheDocument();
    expect(
      within(dev).queryByRole("button", { name: "Music player setup" }),
    ).not.toBeInTheDocument();
    expect(within(dev).queryByRole("button", { name: "Edit club" })).not.toBeInTheDocument();
    expect(within(dev).queryByRole("button", { name: "Delete club" })).not.toBeInTheDocument();
    expect(within(dev).queryByRole("region", { name: "Active games" })).not.toBeInTheDocument();
  });
});

describe("developer menu", () => {
  it("stays hidden until five rapid privacy taps launch the canary firework", () => {
    renderView(<App />);

    expect(screen.queryByRole("button", { name: "Open developer menu" })).not.toBeInTheDocument();
    const privacy = screen.getByRole("button", { name: "Hide private info" });
    for (let tap = 0; tap < 4; tap += 1) fireEvent.click(privacy);
    expect(screen.queryByRole("button", { name: "Open developer menu" })).not.toBeInTheDocument();

    fireEvent.click(privacy);

    expect(screen.getByRole("button", { name: "Open developer menu" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show private info" })).toBe(privacy);
    expect(document.querySelectorAll("[data-canary-particle]")).toHaveLength(32);
  });

  it("resets the hidden Dev tap sequence after a slow privacy tap", () => {
    renderView(<App />);
    vi.useFakeTimers();
    const privacy = screen.getByRole("button", { name: "Hide private info" });

    fireEvent.click(privacy);
    fireEvent.click(privacy);
    vi.advanceTimersByTime(501);
    fireEvent.click(privacy);
    fireEvent.click(privacy);
    fireEvent.click(privacy);

    expect(screen.queryByRole("button", { name: "Open developer menu" })).not.toBeInTheDocument();
  });

  it("clears the pending privacy tap window when the workspace unmounts", () => {
    const view = renderView(<App />);
    vi.spyOn(window, "setTimeout").mockReturnValue(
      42 as unknown as ReturnType<typeof window.setTimeout>,
    );
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    fireEvent.click(screen.getByRole("button", { name: "Hide private info" }));

    view.unmount();

    expect(clearTimeout).toHaveBeenCalledWith(42);
  });

  it("shows the canary app version with a bird icon at the top", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));

    const menu = screen.getByRole("dialog", { name: "Developer menu" });
    const version = within(menu).getByLabelText("Canary version 0.1.0");
    expect(version).toHaveTextContent("Canary v0.1.0");
    expect(version.querySelector(".lucide-bird")).toBeInTheDocument();
    expect(menu.firstElementChild).toContainElement(version);
  });

  it("uses the Save icon as a server readiness button", async () => {
    const user = userEvent.setup();
    render(<App />);

    const save = screen.getByRole("button", {
      name: "Saved to server · tap to check connection",
    });
    await user.click(save);

    await waitFor(() => expect(api.checkServerReady).toHaveBeenCalledOnce());
    expect(save).toHaveAttribute("data-status", "saved");
  });

  it("flushes setup queued while a manual readiness check is in flight", async () => {
    const user = userEvent.setup();
    const readiness = deferred<void>();
    api.checkServerReady.mockReturnValue(readiness.promise);
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: "Saved to server · tap to check connection" }),
    );
    await waitFor(() => expect(api.checkServerReady).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "Save setup progress" }));
    expect(api.saveGameSession).not.toHaveBeenCalled();

    readiness.resolve();
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalledOnce());
    expect(
      screen.getByRole("button", { name: "Saved to server · tap to check connection" }),
    ).toHaveAttribute("data-status", "saved");
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v4") ?? "null"),
    ).toMatchObject({ outbox: [] });
  });

  it("previews and resets the active game from its current timeline", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));
    expect(screen.getByText("Game fouls 1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Past game timeline" }));
    expect(screen.getByText(/#1 · Checkpoint #2/)).toBeInTheDocument();
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
    const beforeConsole = window.localStorage.getItem("mafia-dashboard.game-session.v4");
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
    expect(window.localStorage.getItem("mafia-dashboard.game-session.v4")).toBe(beforeConsole);
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

  it("changes the glass color from Manage", async () => {
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
    await user.click(await screen.findByRole("button", { name: "Open Manage menu" }));
    fireEvent.change(screen.getByLabelText("Glass color"), { target: { value: "#7170ff" } });

    expect(document.documentElement.style.getPropertyValue("--theme-base")).toBe("#7170ff");
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

  it("keeps active game sessions in Manage without player-assignment controls", async () => {
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

    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    expect(screen.getByRole("region", { name: "Active games" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume Dev table" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Randomly fill 10 seats" }),
    ).not.toBeInTheDocument();
  });

  it("localizes canonical active-session phases for a Russian club", async () => {
    const user = userEvent.setup();
    api.listActiveGameSessions.mockResolvedValue([
      {
        gameId: "00000000-0000-4000-8000-0000000000d4",
        name: "Ночной стол",
        revision: 3,
        hostName: "Host Player",
        phase: "night-mafia",
        day: 2,
        updatedAt: "2026-08-18T12:00:00.000Z",
      },
    ]);
    render(
      <I18nProvider locale="ru">
        <App />
      </I18nProvider>,
    );
    await waitFor(() => expect(api.listActiveGameSessions).toHaveBeenCalledOnce());

    await user.click(screen.getByRole("button", { name: "Открыть меню управления" }));

    expect(screen.getByText("Host Player · Выстрелы мафии · день 2")).toBeInTheDocument();
    expect(screen.queryByText(/night-mafia/)).toBeNull();
  });

  it("uses one canonical status bar and opens player and game setup from Manage", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      `mafia-dashboard.available-player-ids.${testClub.id}`,
      JSON.stringify([...assignedGame.players.map(({ id }) => id), hostPlayerId]),
    );
    render(<App />);

    const status = screen.getByRole("banner", { name: "Application status" });
    expect(status).toHaveTextContent("Game setup");
    expect(status).toHaveTextContent("Select players");

    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Players screen" }));

    expect(screen.getByRole("banner", { name: "Application status" })).toHaveTextContent(
      "Players & statistics",
    );
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Start new game" }));
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

  it("localizes canonical game-log event and phase identifiers for a Russian club", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider locale="ru">
        <App />
      </I18nProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));

    await user.click(screen.getByRole("button", { name: "Открыть журнал игры" }));

    expect(screen.getByText("Контрольная точка игры")).toBeInTheDocument();
    expect(screen.getByText("Выдан фол")).toBeInTheDocument();
    expect(screen.getAllByText(/^День ·/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/game\.checkpointed|foul\.issued|^day$/)).toBeNull();
  });

  it("keeps the compact music player mounted but hides it on Players", async () => {
    const user = userEvent.setup();
    render(<App />);
    const player = screen.getByTestId("youtube-player");
    const dock = player.closest(".youtube-dock");
    expect(dock).toHaveClass("is-compact");
    expect(dock).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
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

  it("keeps the complete right pane unchanged across setup, Available players, and Role giveaway", async () => {
    const user = userEvent.setup();
    render(<App />);
    const rail = screen.getByRole("complementary", { name: "Live game controls" });
    const player = screen.getByTestId("youtube-player");
    const timer = within(rail).getByRole("region", { name: "Timer controls" });
    expect(within(rail).getByRole("region", { name: "Voting order" })).toHaveTextContent(
      "No nominations yet",
    );

    await user.click(screen.getByRole("button", { name: "Select available players" }));
    expect(screen.getAllByRole("heading", { name: "Available players" })).toHaveLength(2);
    expect(screen.getByRole("complementary", { name: "Live game controls" })).toBe(rail);
    expect(screen.getByRole("region", { name: "Timer controls" })).toBe(timer);
    expect(screen.getByTestId("youtube-player")).toBe(player);

    await user.click(screen.getByRole("button", { name: "Close available players" }));
    await user.click(screen.getByRole("button", { name: "Enter role giveaway" }));
    expect(screen.getByRole("heading", { name: "Role giveaway" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Live game controls" })).toBe(rail);
    expect(screen.getByRole("region", { name: "Timer controls" })).toBe(timer);
    expect(screen.getByTestId("youtube-player")).toBe(player);
  });

  it("starts the constrained opening music queue when Start game enters Role giveaway", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Enter role giveaway" }));

    expect(musicPlayerHarness.startOpeningQueue).toHaveBeenCalledOnce();
  });

  it("advances to the first non-Initial track when a playing Role giveaway completes", async () => {
    const user = userEvent.setup();
    render(<App />);
    act(() => musicPlayerHarness.setState?.("playing"));
    await user.click(screen.getByRole("button", { name: "Enter role giveaway" }));
    await user.click(screen.getByRole("button", { name: "Start test game" }));

    expect(musicPlayerHarness.playFirstRegularTrack).toHaveBeenCalledOnce();
  });

  it("quick-fades before an Endgame-preferred shuffle when Night ends in Critical Best move", async () => {
    const user = userEvent.setup();
    const fade = deferred<void>();
    musicPlayerHarness.quickFadeOut.mockReturnValueOnce(fade.promise);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    act(() => musicPlayerHarness.setState?.("playing"));
    let activeCitizens = 0;
    const players = assignedGame.players.map((player) => ({
      ...player,
      status: player.team === "red" ? (activeCitizens++ < 4 ? "active" : "eliminated") : "active",
    })) as GameState["players"];

    act(() => {
      gameScreenHarness.liveOnGameChange?.({
        ...assignedGame,
        players,
        phase: "night-resolution",
      } as GameState);
    });
    act(() => {
      gameScreenHarness.liveOnGameChange?.({
        ...assignedGame,
        players,
        phase: "best-move",
      } as GameState);
    });

    expect(musicPlayerHarness.quickFadeOut).toHaveBeenCalledOnce();
    expect(musicPlayerHarness.slowFadeOut).not.toHaveBeenCalled();
    expect(musicPlayerHarness.shuffleQueue).not.toHaveBeenCalled();
    fade.resolve();
    await waitFor(() =>
      expect(musicPlayerHarness.shuffleQueue).toHaveBeenCalledWith({ preferEndgame: true }),
    );
  });

  it("still performs an ordinary shuffle when the slow Day fade rejects", async () => {
    const user = userEvent.setup();
    musicPlayerHarness.slowFadeOut.mockRejectedValueOnce(new Error("fade failed"));
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    act(() => musicPlayerHarness.setState?.("playing"));
    act(() => {
      gameScreenHarness.liveOnGameChange?.({
        ...assignedGame,
        phase: "night-resolution",
      } as GameState);
    });
    act(() => {
      gameScreenHarness.liveOnGameChange?.({ ...assignedGame, phase: "day" } as GameState);
    });

    await waitFor(() => expect(musicPlayerHarness.slowFadeOut).toHaveBeenCalledOnce());
    expect(musicPlayerHarness.quickFadeOut).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(musicPlayerHarness.shuffleQueue).toHaveBeenCalledWith({ preferEndgame: false }),
    );
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
    expect(player.closest(".youtube-dock")).not.toHaveAttribute("hidden");
    expect(screen.getByRole("region", { name: "Timer controls" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Voting order" })).toBeInTheDocument();
    expect(musicPlayerHarness).toMatchObject({ mounts: 1, unmounts: 0 });

    await user.click(screen.getByRole("button", { name: "Exit preview" }));
    expect(screen.getByTestId("youtube-player")).toBe(player);
    expect(musicPlayerHarness).toMatchObject({ mounts: 1, unmounts: 0 });
  });

  it("keeps music player setup behind the Manage menu", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.queryByRole("region", { name: "Music player setup" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    expect(screen.queryByRole("button", { name: "Reload music player" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Music player setup" }));

    expect(screen.getByRole("region", { name: "Music player setup" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload music player" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Low")).toBeNull();
    expect(screen.queryByLabelText("High")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Voting playlist" })).toBeNull();
    const playlist = screen.getByRole("combobox", { name: "YouTube Music playlist" });
    await user.selectOptions(playlist, "dev-playlist");
    expect(playlist).toHaveValue("dev-playlist");
  });

  it("does not expose runtime glass settings in Dev", async () => {
    const user = userEvent.setup();
    render(
      <ClubWorkspace
        club={testClub}
        onExit={() => undefined}
        onEditClub={() => undefined}
        onDeleteClub={() => Promise.resolve()}
        themeColor="#c39a58"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));

    expect(screen.queryByRole("group", { name: "Glass settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: /Glass/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset glass settings" })).not.toBeInTheDocument();
  });

  it("restores the club's last playlist when no active game session supplies one", () => {
    window.localStorage.setItem(
      musicPreferencesStorageKey(testClub.id),
      JSON.stringify({
        version: 1,
        lastPlaylistId: "remembered-playlist",
        queueOrder: [],
        initialStageEntryKeys: [],
        endgameEntryKeys: [],
      }),
    );

    render(<App />);

    expect(screen.getByTestId("youtube-player")).toHaveAttribute(
      "data-playlist-id",
      "remembered-playlist",
    );
  });

  it("restores and updates the one remembered queue order", async () => {
    window.localStorage.setItem(
      musicPreferencesStorageKey(testClub.id),
      JSON.stringify({
        version: 1,
        lastPlaylistId: "PL-base",
        queueOrder: ["video-b:1", "video-a:0"],
        initialStageEntryKeys: [],
        endgameEntryKeys: [],
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
    ).toMatchObject({ queueOrder: ["video-c:2", "video-a:0"] });
  });

  it("persists Initial and Endgame tags for the one active playlist", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Music player setup" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "YouTube Music playlist" }),
      "dev-playlist",
    );
    await user.click(screen.getByRole("button", { name: "Remember mock queue tags" }));

    expect(
      JSON.parse(window.localStorage.getItem(musicPreferencesStorageKey(testClub.id)) ?? "null"),
    ).toMatchObject({
      lastPlaylistId: "dev-playlist",
      initialStageEntryKeys: ["video-a:0"],
      endgameEntryKeys: ["video-c:2"],
    });

    await user.click(screen.getByRole("button", { name: "Mark mock Endgame" }));
    expect(
      JSON.parse(window.localStorage.getItem(musicPreferencesStorageKey(testClub.id)) ?? "null"),
    ).toMatchObject({
      initialStageEntryKeys: [],
      endgameEntryKeys: ["video-c:2", "video-a:0"],
    });

    await user.click(screen.getByRole("button", { name: "Mark mock Initial" }));
    expect(
      JSON.parse(window.localStorage.getItem(musicPreferencesStorageKey(testClub.id)) ?? "null"),
    ).toMatchObject({
      initialStageEntryKeys: ["video-a:0"],
      endgameEntryKeys: ["video-c:2"],
    });

    await user.click(screen.getByRole("button", { name: "Unmark mock Initial" }));
    expect(
      JSON.parse(window.localStorage.getItem(musicPreferencesStorageKey(testClub.id)) ?? "null"),
    ).toMatchObject({
      initialStageEntryKeys: [],
      endgameEntryKeys: ["video-c:2"],
    });
  });

  it("remembers a newly selected playlist for this club", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Music player setup" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "YouTube Music playlist" }),
      "dev-playlist",
    );

    expect(
      JSON.parse(window.localStorage.getItem(musicPreferencesStorageKey(testClub.id)) ?? "null"),
    ).toEqual({
      version: 1,
      lastPlaylistId: "dev-playlist",
      queueOrder: [],
      initialStageEntryKeys: [],
      endgameEntryKeys: [],
    });
  });

  it("keeps one selected playlist as the game enters Day, Voting, and Night", async () => {
    window.localStorage.setItem(
      musicPreferencesStorageKey(testClub.id),
      JSON.stringify({
        version: 1,
        lastPlaylistId: "PL-base",
        queueOrder: [],
        initialStageEntryKeys: [],
        endgameEntryKeys: [],
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    const player = screen.getByTestId("youtube-player");

    await user.click(screen.getByRole("button", { name: "Start test game" }));
    expect(player).toHaveAttribute("data-playlist-id", "PL-base");
    await user.click(screen.getByRole("button", { name: "Enter voting phase" }));
    expect(player).toHaveAttribute("data-playlist-id", "PL-base");
    await user.click(screen.getByRole("button", { name: "Enter night phase" }));
    expect(player).toHaveAttribute("data-playlist-id", "PL-base");
    expect(screen.getByTestId("youtube-player")).toBe(player);
    expect(musicPlayerHarness).toMatchObject({ mounts: 1, unmounts: 0 });
  });

  it("atomically clears the one remembered playlist on account disconnect", async () => {
    window.localStorage.setItem(
      musicPreferencesStorageKey(testClub.id),
      JSON.stringify({
        version: 1,
        lastPlaylistId: "PL-base",
        queueOrder: ["video-a:0"],
        initialStageEntryKeys: ["video-a:0"],
        endgameEntryKeys: ["video-b:1"],
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    const player = screen.getByTestId("youtube-player");

    await user.click(screen.getByRole("button", { name: "Start test game" }));
    expect(player).toHaveAttribute("data-playlist-id", "PL-base");
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Music player setup" }));
    await user.click(screen.getByRole("button", { name: "Disconnect account" }));
    await act(async () => Promise.resolve());

    expect(player).toHaveAttribute("data-playlist-id", "");
    expect(
      JSON.parse(window.localStorage.getItem(musicPreferencesStorageKey(testClub.id)) ?? "null"),
    ).toEqual({
      version: 1,
      lastPlaylistId: "",
      queueOrder: [],
      initialStageEntryKeys: [],
      endgameEntryKeys: [],
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

    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
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
        queueOrder: ["video-b:1"],
        initialStageEntryKeys: ["video-b:1"],
        endgameEntryKeys: ["video-b:1"],
      }),
    );
    reportError(new Error("Stale Console entry"));
    render(<App />);
    const musicPlayer = screen.getByTestId("youtube-player");
    expect(musicPlayer).toHaveAttribute("data-playlist-id", "remembered-playlist");

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Clear all data" }));
    const privacy = screen.getByRole("button", { name: "Hide private info" });
    for (let tap = 0; tap < 5; tap += 1) fireEvent.click(privacy);
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Music player setup" }));
    const playlist = screen.getByRole("combobox", { name: "YouTube Music playlist" });
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Console" }));

    expect({
      playlistId: musicPlayer.getAttribute("data-playlist-id"),
      rememberedOrder: musicPlayer.getAttribute("data-remembered-order"),
      selectedPlaylist: (playlist as HTMLSelectElement).value,
      consoleIsEmpty: screen.queryByText("No errors have been captured.") !== null,
      localStorageItems: window.localStorage.length,
    }).toEqual({
      playlistId: "",
      rememberedOrder: "",
      selectedPlaylist: "",
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
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v4") ?? "null"),
    ).toMatchObject({ entries: [expect.objectContaining({ type: "game.checkpointed" })] });
    await user.click(screen.getByRole("button", { name: "Open game log" }));
    expect(screen.queryByText("turn.completed")).toBeNull();

    firstRender.unmount();
    render(<App />);
    expect(screen.getByText("Game turn 0")).toBeInTheDocument();
  });

  it("persists a day-one nominee and folds omitted turns into the Mafia shot checkpoint", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalled());
    api.saveGameSession.mockClear();

    await user.click(screen.getByRole("button", { name: "Record nomination" }));
    await waitFor(() =>
      expect(api.saveGameSession).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          kind: "append-event",
          event: expect.objectContaining({ type: "player.nominated" }),
        }),
        testClub.id,
      ),
    );
    api.saveGameSession.mockClear();

    for (let turn = 0; turn < assignedGame.turnOrder.length; turn += 1) {
      await user.click(screen.getByRole("button", { name: "Record game action" }));
    }
    const displayed = gameScreenHarness.liveGame;
    const accept = gameScreenHarness.liveOnAcceptedEvent;
    if (displayed === null || accept === null)
      throw new Error("Live game callbacks were not captured");
    expect(displayed.phase).toBe("night-mafia");

    const target = displayed.players.find(
      ({ team, status }) => team === "red" && status === "active",
    )!;
    const assigned = toggleAllMafiaShotsForTarget(displayed, target.seat);
    const resolution = resolveMafiaShots(assigned);
    act(() =>
      accept({
        type: "mafia.shots-resolved",
        payload: { shots: resolution.secretShots, result: resolution.result },
      }),
    );

    await waitFor(() => expect(gameScreenHarness.liveGame?.phase).toBe("night-mafia-result"));
    await waitFor(() =>
      expect(api.saveGameSession).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          kind: "append-event",
          event: expect.objectContaining({ type: "mafia.shots-resolved" }),
        }),
        testClub.id,
      ),
    );
    expect(
      getErrorConsoleSnapshot().some(({ message }) =>
        message.includes("Mafia shots can only be recorded during the Mafia night phase"),
      ),
    ).toBe(false);

    const persisted = JSON.parse(
      window.localStorage.getItem("mafia-dashboard.game-session.v4") ?? "null",
    ) as {
      baseline: InitialGameBaseline;
      entries: GameLogEntry[];
      headEventId: string;
    };
    expect(persisted.entries).toHaveLength(3);
    expect(persisted.entries[1]).toMatchObject({
      type: "player.nominated",
      parentEventId: persisted.entries[0]!.id,
    });
    expect(persisted.entries[2]).toMatchObject({
      type: "mafia.shots-resolved",
      parentEventId: persisted.entries[1]!.id,
    });
    expect(persisted.headEventId).toBe(persisted.entries[2]!.id);
    expect(replayGameLog(persisted.baseline, persisted.entries).game).toEqual(
      gameScreenHarness.liveGame,
    );
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
        day: 2,
        phase: "voting",
        nominations: [{ nominatorSeat: 1, candidateSeat: 4, order: 1 }],
        turnOrder: [4],
        currentTurnIndex: 0,
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
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v4") ?? "null"),
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
    expect(
      within(screen.getByRole("main"))
        .getAllByRole("button")
        .map((button) => button.textContent?.trim()),
    ).toEqual(["Exit preview", "Reset game to this state"]);

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

  it("applies a reset locally while its server operation remains queued", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Saved to server · tap to check connection" }),
      ).toBeInTheDocument(),
    );
    const before = JSON.parse(
      window.localStorage.getItem("mafia-dashboard.game-session.v4") ?? "null",
    ) as { headEventId: string };
    api.saveGameSessionOperation.mockRejectedValue(new Error("offline"));

    await user.click(screen.getByRole("button", { name: "Open game log" }));
    await user.click(screen.getByRole("button", { name: "Preview state after log #1" }));
    await user.click(screen.getByRole("button", { name: "Reset game to this state" }));

    expect(screen.getByText("Game fouls 0")).toBeInTheDocument();
    const persisted = JSON.parse(
      window.localStorage.getItem("mafia-dashboard.game-session.v4") ?? "null",
    );
    expect(persisted.headEventId).not.toBe(before.headEventId);
    expect(persisted.outbox).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "move-head" })]),
    );
    expect(screen.getByRole("button", { name: /^Save failed · retry 1 of 3/ })).toHaveAttribute(
      "data-status",
      "retrying",
    );
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

  it("finishes locally while offline and uploads exactly once after Save is pressed", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Saved to server · tap to check connection" }),
      ).toBeInTheDocument(),
    );

    api.saveGameSession.mockRejectedValue(new ApiError("save rejected", 400, "invalid"));
    await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Save blocked ·/ })).toHaveAttribute(
        "data-status",
        "offline",
      ),
    );

    await user.click(screen.getByRole("button", { name: "Finish test game" }));
    await user.click(screen.getByRole("button", { name: "Finish the game" }));
    expect(screen.getByRole("button", { name: "Game saved offline" })).toBeDisabled();
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v4") ?? "null").outbox,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "complete" })]));

    api.saveGameSession.mockImplementation((_gameId: string, operation: { baseRevision: number }) =>
      Promise.resolve({ revision: operation.baseRevision + 1, duplicate: false }),
    );
    await user.click(screen.getByRole("button", { name: /^Save blocked ·/ }));

    expect(await screen.findByRole("button", { name: "Start test game" })).toBeInTheDocument();
    expect(
      api.saveGameSession.mock.calls.filter(([, operation]) => operation.kind === "complete"),
    ).toHaveLength(1);
    expect(window.localStorage.getItem("mafia-dashboard.game-session.v4")).toBeNull();
  });

  it("keeps Local only when the newer queued aggregate mutation fails", async () => {
    const user = userEvent.setup();
    const first = deferred<{ revision: number; duplicate: boolean }>();
    api.saveGameSession
      .mockImplementationOnce(() => first.promise)
      .mockRejectedValue(new ApiError("save rejected", 400, "invalid"));
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));
    expect(screen.getByRole("button", { name: /^Saving ·/ })).toHaveAttribute(
      "data-status",
      "saving",
    );

    first.resolve({ revision: 1, duplicate: false });

    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Save blocked ·/ })).toHaveAttribute(
        "data-status",
        "offline",
      ),
    );
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v4") ?? "null"),
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
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await screen.findByRole("button", { name: "Resume Table A" });

    await user.click(screen.getByRole("button", { name: "Resume Table A" }));
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
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
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v4") ?? "null"),
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
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await screen.findByRole("button", { name: "Resume Remote table" });

    await user.click(screen.getByRole("button", { name: "Resume Remote table" }));
    await user.click(screen.getByRole("button", { name: "Save setup progress" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Saved to server · tap to check connection" }),
      ).toBeInTheDocument(),
    );
    const localGameId = api.saveGameSession.mock.calls[0]?.[0] as string;

    remote.resolve(remoteSession(remoteGameId, "Remote table", "Remote host", 5, 2));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole("heading", { name: "Restored setup" })).toBeInTheDocument();
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v4") ?? "null"),
    ).toMatchObject({ gameId: localGameId, revision: 1, outbox: [] });
  });

  it("restores the latest meaningful checkpoint from the durable browser aggregate", async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Saved to server · tap to check connection" }),
      ).toBeInTheDocument(),
    );
    const callsBeforeReload = api.saveGameSession.mock.calls.length;

    firstRender.unmount();
    render(<App />);

    expect(screen.getByRole("heading", { name: "Live test game" })).toBeInTheDocument();
    expect(screen.getByText("Host: Host Player")).toBeInTheDocument();
    expect(screen.getByText("Game fouls 1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open game log" }));
    expect(screen.getByText("Foul issued")).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.saveGameSession).toHaveBeenCalledTimes(callsBeforeReload);
  });

  it("restores setup and playlist progress from the durable browser aggregate", async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Music player setup" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "YouTube Music playlist" }),
      "dev-playlist",
    );
    await user.click(screen.getByRole("button", { name: "Save setup progress" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Saved to server · tap to check connection" }),
      ).toBeInTheDocument(),
    );

    firstRender.unmount();
    render(<App />);

    expect(screen.getByRole("heading", { name: "Restored setup" })).toBeInTheDocument();
    expect(screen.getByTestId("youtube-player")).toHaveAttribute(
      "data-playlist-id",
      "dev-playlist",
    );
  });

  it("migrates an existing session-storage game into durable local storage", async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);
    await user.click(screen.getByRole("button", { name: "Save setup progress" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Saved to server · tap to check connection" }),
      ).toBeInTheDocument(),
    );
    const saved = window.localStorage.getItem("mafia-dashboard.game-session.v4");
    expect(saved).not.toBeNull();
    window.sessionStorage.setItem("mafia-dashboard.game-session.v4", saved!);
    window.localStorage.removeItem("mafia-dashboard.game-session.v4");

    firstRender.unmount();
    render(<App />);

    expect(screen.getByRole("heading", { name: "Restored setup" })).toBeInTheDocument();
    expect(window.localStorage.getItem("mafia-dashboard.game-session.v4")).toBe(saved);
    expect(window.sessionStorage.getItem("mafia-dashboard.game-session.v4")).toBeNull();
  });

  it("removes a stale session copy before local clear can resurrect it", async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);
    await user.click(screen.getByRole("button", { name: "Save setup progress" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Saved to server · tap to check connection" }),
      ).toBeInTheDocument(),
    );
    const saved = window.localStorage.getItem("mafia-dashboard.game-session.v4");
    expect(saved).not.toBeNull();
    firstRender.unmount();
    window.sessionStorage.setItem("mafia-dashboard.game-session.v4", saved!);

    const restored = render(<App />);
    expect(screen.getByRole("heading", { name: "Restored setup" })).toBeInTheDocument();
    expect(window.sessionStorage.getItem("mafia-dashboard.game-session.v4")).toBeNull();

    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Start new game" }));
    await screen.findByRole("button", { name: "Start test game" });
    expect(window.localStorage.getItem("mafia-dashboard.game-session.v4")).toBeNull();

    restored.unmount();
    render(<App />);
    expect(screen.getAllByRole("heading", { name: "Game setup" })).not.toHaveLength(0);
    expect(screen.queryByRole("heading", { name: "Restored setup" })).toBeNull();
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

    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Start new game" }));

    expect(confirm).toHaveBeenCalledWith(
      "Delete this active game from the server? This is irreversible and removes its saved session and game log for every browser.",
    );
    expect(api.clearGameSession).toHaveBeenCalledWith(gameId, 0, testClub.id);
    expect(screen.getByRole("heading", { name: "Restored setup" })).toBeInTheDocument();
    clear.resolve();
    await screen.findByRole("heading", { name: "Game setup" });
    expect(window.localStorage.getItem("mafia-dashboard.game-session.v4")).toBeNull();
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
      expect(
        screen.getByRole("button", { name: "Saved to server · tap to check connection" }),
      ).toBeInTheDocument(),
    );
    const clearedGameId = api.saveGameSession.mock.calls[0]?.[0] as string;

    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Start new game" }));
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Music player setup" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "YouTube Music playlist" }),
      "dev-playlist",
    );
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalledTimes(2));
    const newerGameId = api.saveGameSession.mock.calls[1]?.[0] as string;
    expect(newerGameId).not.toBe(clearedGameId);

    clear.resolve();
    await waitFor(() =>
      expect(api.clearGameSession).toHaveBeenCalledWith(clearedGameId, 1, testClub.id),
    );

    expect(screen.getByRole("heading", { name: "Restored setup" })).toBeInTheDocument();
    expect(screen.getByTestId("youtube-player")).toHaveAttribute(
      "data-playlist-id",
      "dev-playlist",
    );
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v4") ?? "null"),
    ).toMatchObject({ gameId: newerGameId, metadata: { playlistId: "dev-playlist" } });
  });

  it("preserves local setup and outbox when remote clear fails", async () => {
    const user = userEvent.setup();
    api.clearGameSession.mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Save setup progress" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Saved to server · tap to check connection" }),
      ).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Start new game" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Offline ·/ })).toHaveAttribute(
        "data-status",
        "offline",
      ),
    );
    expect(screen.getByRole("heading", { name: "Restored setup" })).toBeInTheDocument();
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v4") ?? "null"),
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
    draft: { type: "game.checkpointed", payload: {} },
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
      expect(
        screen.getByRole("button", { name: "Saved to server · tap to check connection" }),
      ).toBeInTheDocument(),
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
      expect(
        screen.getByRole("button", { name: "Saved to server · tap to check connection" }),
      ).toBeInTheDocument(),
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
    expect(screen.getAllByText("Foul issued")).toHaveLength(4);

    for (let index = 0; index < 3; index += 1) {
      await user.click(screen.getByRole("button", { name: /undo last action/i }));
    }
    expect(screen.getByText("Game fouls 1")).toBeInTheDocument();
    expect(screen.getAllByText("Foul issued")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /undo last action/i })).toBeDisabled();
  });
});

describe("player workflows", () => {
  it("loads players separately and protects current players from deletion", async () => {
    const user = userEvent.setup();
    api.listPlayers.mockResolvedValue([
      ...assignedGame.players.map(({ id, name }) => player(name, id)),
      player("Host Player", hostPlayerId),
    ]);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
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

  it("rolls back partially created development players", async () => {
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

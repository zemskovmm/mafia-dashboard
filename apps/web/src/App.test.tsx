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
import { forwardRef, StrictMode, useEffect, useImperativeHandle, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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

import { GameSessionOutbox } from "./session-outbox.js";
import { withBrowserGameStorageGuard } from "./browser-game-storage-lock.js";
import {
  clearErrorConsole,
  getErrorConsoleSnapshot,
  reportError,
} from "./features/console/error-console.js";
import {
  LIGHTING_RENDERER_STORAGE_KEY,
  PLAYER_PULSE_STORAGE_KEY,
} from "./features/effects/lighting-preferences.js";
import {
  DEVELOPER_MODE_ENABLED_STORAGE_KEY,
  DEVELOPER_UNLOCKED_STORAGE_KEY,
} from "./features/developer/developer-preferences.js";
import { musicPreferencesStorageKey } from "./features/music/music-preferences.js";
import * as gameScreenModule from "./features/game/GameScreen.js";
import * as setupWizardModule from "./features/setup/SetupWizard.js";
import type { SetupWizardSessionState } from "./features/setup/SetupWizard.js";
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
    createGameSession: vi.fn(),
    saveGameSession,
    saveGameSessionOperation: saveGameSession,
    updatePlayer: vi.fn(),
    getAuthSession: vi.fn(),
    signOut: vi.fn(),
    listClubs: vi.fn(),
    createClub: vi.fn(),
    deleteClub: vi.fn(),
    getMusicAccountStatus: vi.fn(),
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
  bestMoveEnabled: true,
  role: "manager",
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
};
const otherClub: Club = {
  ...testClub,
  id: "00000000-0000-4000-8000-000000000202",
  name: "Mafia Sevilla",
  city: "Sevilla",
};
const authenticatedUser = {
  configured: true,
  user: {
    id: "00000000-0000-4000-8000-000000000001",
    email: "owner@mafiamalaga.es",
    name: "Mafia Malaga owner",
    picture: null,
  },
} as const;
const browserSessionState = (playlistId: string) => ({
  setup: null,
  game: null,
  hostPlayerId: null,
  hostName: null,
  playlistId,
  log: [],
  undoHistory: [],
  undoBudget: 0,
  initialGame: null,
  events: [],
  headEventId: null,
  resetReturnEventId: null,
  legacyLog: [],
});
const seedBrowserGame = (club: Club, gameId: string, name: string, pending = false) => {
  const outbox = new GameSessionOutbox({
    storage: window.localStorage,
    clubId: club.id,
    createId: () => gameId,
    save: vi.fn(),
  });
  outbox.activateRemote({
    ...remoteSession(gameId, name, "Host Player", 1, 1),
    state: browserSessionState(name),
  });
  if (pending) outbox.enqueue(name, browserSessionState(`${name}-pending`), null);
  return outbox;
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

vi.mock(import("./api/client.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  ...api,
}));

vi.mock("./features/setup/SetupWizard.js", () => ({
  SetupWizard: ({
    players,
    onComplete,
    onStartGame = () => undefined,
    initialSessionState,
    onSessionStateChange,
    onRoleDrawBackActionChange,
    onEvent,
    onPopulateDevelopmentPlayers,
    onOpenAvailablePlayers,
    showDevelopmentTools = false,
    persistencePending = false,
  }: {
    players: readonly PlayerProfile[];
    onComplete: (game: GameState, hostPlayerId: string, hostName: string) => void;
    onStartGame?: () => void;
    initialSessionState?: SetupWizardSessionState | null;
    onSessionStateChange?: (state: SetupWizardSessionState) => void;
    onRoleDrawBackActionChange?: (action: (() => void) | null) => void;
    onEvent: (type: string, payload: Record<string, unknown>) => void;
    onPopulateDevelopmentPlayers?: () => Promise<readonly PlayerProfile[]>;
    onOpenAvailablePlayers?: () => void;
    showDevelopmentTools?: boolean;
    persistencePending?: boolean;
  }) => {
    const [session, setSession] = useState<SetupWizardSessionState | null>(
      initialSessionState ?? null,
    );
    const [autoStart, setAutoStart] = useState(false);
    const [seenPending, setSeenPending] = useState(false);
    const step = session?.step ?? "players";
    const roleDeck = assignedGame.players.map(({ role }) => role);
    const roleGiveawaySession: SetupWizardSessionState = {
      step: "roles",
      hostPlayerId,
      selectedPlayerIds: assignedGame.players.map(({ id }) => id),
      setup: {
        step: "role-draw",
        players: assignedGame.players.map(({ id, name, seat }) => ({ id, name, seat })),
        roleDeck,
        remainingRoles: roleDeck,
        assignments: {},
      },
    };
    useEffect(() => {
      if (!autoStart) return;
      if (persistencePending) setSeenPending(true);
      else if (seenPending) {
        setAutoStart(false);
        onComplete(assignedGame, hostPlayerId, "Host Player");
      }
    }, [autoStart, seenPending, persistencePending, onComplete]);
    useEffect(() => {
      if (session?.step !== "roles" || session.setup === null) {
        onRoleDrawBackActionChange?.(null);
        return;
      }
      onRoleDrawBackActionChange?.(() => {
        const next: SetupWizardSessionState = { ...session, step: "players" };
        setSession(next);
        onSessionStateChange?.(next);
      });
      return () => onRoleDrawBackActionChange?.(null);
    }, [onRoleDrawBackActionChange, onSessionStateChange, session]);
    return (
      <main>
        <h1>
          {step === "roles" ? "Role giveaway" : step === "music" ? "Restored setup" : "Game setup"}
        </h1>
        <output data-testid="setup-player-pool">
          {players.map(({ nickname }) => nickname).join(",")}
        </output>
        <output data-testid="setup-session">{JSON.stringify(session)}</output>
        {onOpenAvailablePlayers === undefined ? null : (
          <button type="button" onClick={onOpenAvailablePlayers}>
            Select available players
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            const next: SetupWizardSessionState = {
              step: "music",
              hostPlayerId,
              selectedPlayerIds: [
                assignedGame.players[0]!.id,
                ...Array.from({ length: 9 }, () => ""),
              ],
              setup: null,
            };
            setSession(next);
            onEvent("setup.players-selected", {
              hostPlayerId,
              players: [{ id: assignedGame.players[0]!.id, name: "Player 1", seat: 1 }],
            });
            onSessionStateChange?.(next);
          }}
        >
          Save setup progress
        </button>
        <button
          type="button"
          disabled={persistencePending}
          onClick={() => {
            if (step === "roles" && !persistencePending) {
              onComplete(assignedGame, hostPlayerId, "Host Player");
            } else {
              onStartGame();
              setAutoStart(true);
              const next = session?.setup?.step === "role-draw" ? session : roleGiveawaySession;
              setSession(next);
              onSessionStateChange?.(next);
            }
          }}
        >
          Start test game
        </button>
        <button
          type="button"
          onClick={() => {
            const next: SetupWizardSessionState =
              session?.setup?.step === "role-draw"
                ? { ...session, step: "roles" }
                : roleGiveawaySession;
            if (session?.setup?.step !== "role-draw") onStartGame();
            setSession(next);
            onSessionStateChange?.(next);
          }}
        >
          Enter role giveaway
        </button>
        {session?.step !== "roles" || session.setup === null ? null : (
          <button
            type="button"
            disabled={persistencePending}
            onClick={() => {
              if (session.setup === null) return;
              const [role, ...remainingRoles] = session.setup.remainingRoles;
              if (role === undefined) return;
              const next: SetupWizardSessionState = {
                ...session,
                setup: {
                  ...session.setup,
                  remainingRoles,
                  assignments: { ...session.setup.assignments, 1: role },
                },
              };
              setSession(next);
              onSessionStateChange?.(next);
            }}
          >
            Assign first role
          </button>
        )}
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
    finishGameState: "ready" | "saving" | "saved" | "queued" | "blocked";
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
        <button
          type="button"
          onClick={() =>
            onGameChange({
              ...game,
              phase: "voting",
              nominations: [
                { candidateSeat: 2, nominatorSeat: 1, order: 1 },
                { candidateSeat: 3, nominatorSeat: 2, order: 2 },
              ],
              turnOrder: [2, 3],
              currentTurnIndex: 0,
            })
          }
        >
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
                : finishGameState === "blocked"
                  ? "Game upload blocked"
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
    onStatusChange,
    onRetry,
    status = { configured: true, connected: true, accountLabel: "Mafia Host" },
    statusError = false,
  }: {
    playlistId: string;
    onPlaylistIdChange: (playlistId: string) => void;
    onAccountDisconnected: () => void;
    onStatusChange?: (status: {
      configured: boolean;
      connected: boolean;
      accountLabel: string | null;
    }) => void;
    onRetry?: () => void;
    status?: { configured: boolean; connected: boolean; accountLabel: string | null } | null;
    statusError?: boolean;
  }) => {
    if (statusError) {
      return (
        <button type="button" onClick={onRetry}>
          Retry music account check
        </button>
      );
    }
    if (status === null) return <p>Checking YouTube Music account…</p>;
    if (!status.configured) {
      return (
        <button type="button" disabled>
          Connect YouTube Music account unavailable
        </button>
      );
    }
    if (!status.connected) {
      return <a href="/api/music/oauth/start">Connect YouTube Music account</a>;
    }
    return (
      <>
        <select
          aria-label="YouTube Music playlist"
          value={playlistId}
          onChange={(event) => onPlaylistIdChange(event.target.value)}
        >
          <option value="">No playlist</option>
          <option value="dev-playlist">Dev playlist</option>
        </select>
        <button
          type="button"
          onClick={() => {
            onAccountDisconnected();
            onStatusChange?.({ configured: true, connected: false, accountLabel: null });
          }}
        >
          Disconnect account
        </button>
      </>
    );
  },
}));

const player = (nickname: string, id: string): PlayerProfile => ({
  id,
  nickname,
  consent: false,
  clubAccess: "none",
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
  api.saveGameSession.mockReset().mockResolvedValue({ revision: 2, duplicate: false });
  api.createGameSession.mockReset().mockImplementation(
    async (
      input: {
        creationId: string;
        name: string;
        state: RemoteGameSession["state"];
        results: RemoteGameSession["results"];
      },
      clubId: string,
    ) => {
      const gameId = "00000000-0000-4000-8000-000000000090";
      await api.saveGameSession(
        gameId,
        {
          kind: "snapshot",
          mutationId: input.creationId,
          state: input.state,
          name: input.name,
          results: input.results,
        },
        {},
        clubId,
      );
      return {
        ...remoteSession(gameId, input.name, "Host Player", 1, 1),
        state: input.state,
        results: input.results,
      };
    },
  );
  api.updatePlayer.mockReset();
  api.getAuthSession.mockReset().mockResolvedValue({ configured: true, user: null });
  api.getMusicAccountStatus.mockReset().mockResolvedValue({
    configured: true,
    connected: true,
    accountLabel: "Mafia Host",
  });
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
  it("localizes the other-tab error in Russian", async () => {
    api.getAuthSession.mockResolvedValue(authenticatedUser);
    api.listClubs.mockResolvedValue([testClub]);
    const lifetime = deferred<void>();
    const owner = withBrowserGameStorageGuard(() => lifetime.promise);
    const view = render(
      <I18nProvider locale="ru">
        <WelcomeApp />
      </I18nProvider>,
    );
    try {
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Mafia Dashboard уже открыт в другой вкладке. Используйте её или закройте и перезагрузите эту страницу.",
      );
      expect(screen.queryByRole("button")).toBeNull();
    } finally {
      view.unmount();
      lifetime.resolve();
      await owner;
    }
  });

  it("distinguishes unavailable storage locking from another-tab contention", async () => {
    api.getAuthSession.mockResolvedValue(authenticatedUser);
    api.listClubs.mockResolvedValue([testClub]);
    vi.stubEnv("MODE", "production");
    try {
      render(<WelcomeApp />);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "This browser cannot safely lock local game storage.",
      );
      expect(screen.queryByRole("button")).toBeNull();
      expect(api.listPlayers).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps a club API failure distinct from a storage error", async () => {
    api.getAuthSession.mockResolvedValue(authenticatedUser);
    api.listClubs.mockRejectedValue(new Error("offline"));
    render(<WelcomeApp />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Clubs are temporarily unavailable");
    expect(screen.queryByText(/already open in another tab/)).toBeNull();
  });

  it("blocks workspace entry if another tab takes the lock after the club list loads", async () => {
    const user = userEvent.setup();
    api.getAuthSession.mockResolvedValue(authenticatedUser);
    api.listClubs.mockResolvedValue([testClub]);
    const view = render(<WelcomeApp />);
    const open = await screen.findByRole("button", { name: /Mafia Malaga.*Málaga/i });
    const lifetime = deferred<void>();
    const owner = withBrowserGameStorageGuard(() => lifetime.promise);
    try {
      await user.click(open);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Mafia Dashboard is already open in another tab. Please use that tab, or close it and reload this page.",
      );
      expect(api.listPlayers).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: /New club|Sign out|Open Manage/ })).toBeNull();
      await act(async () => {
        lifetime.resolve();
        await owner;
      });
      expect(screen.getByRole("alert")).toHaveTextContent("already open in another tab");
      expect(api.listPlayers).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      lifetime.resolve();
      await owner;
    }
  });

  it("opens and reopens an uncontended workspace under StrictMode", async () => {
    const user = userEvent.setup();
    api.getAuthSession.mockResolvedValue(authenticatedUser);
    api.listClubs.mockResolvedValue([testClub]);
    render(
      <StrictMode>
        <WelcomeApp />
      </StrictMode>,
    );
    for (let visit = 0; visit < 2; visit += 1) {
      await user.click(await screen.findByRole("button", { name: /Mafia Malaga.*Málaga/i }));
      await user.click(
        await screen.findByRole("button", {
          name: "Choose another club · current club Mafia Malaga",
        }),
      );
    }
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("blocks startup when another tab owns game storage until the page is reloaded", async () => {
    api.getAuthSession.mockResolvedValue(authenticatedUser);
    api.listClubs.mockResolvedValue([{ ...testClub, name: "La Verdad" }]);
    seedBrowserGame(testClub, "00000000-0000-4000-8000-000000000301", "Unsynced game", true);
    const original = window.localStorage.getItem("mafia-dashboard.game-session.v5");
    const lifetime = deferred<void>();
    const owner = withBrowserGameStorageGuard(() => lifetime.promise);
    const view = render(<WelcomeApp />);
    try {
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Mafia Dashboard is already open in another tab. Please use that tab, or close it and reload this page.",
      );
      expect(screen.queryByRole("button", { name: /New club|Sign out|La Verdad/ })).toBeNull();
      expect(api.listPlayers).not.toHaveBeenCalled();
      expect(api.signOut).not.toHaveBeenCalled();
      expect(window.localStorage.getItem("mafia-dashboard.game-session.v5")).toBe(original);

      await act(async () => {
        lifetime.resolve();
        await owner;
      });
      expect(screen.getByRole("alert")).toHaveTextContent("already open in another tab");
      expect(api.listPlayers).not.toHaveBeenCalled();
      expect(window.localStorage.getItem("mafia-dashboard.game-session.v5")).toBe(original);
    } finally {
      view.unmount();
      lifetime.resolve();
      await owner;
    }

    render(<WelcomeApp />);
    expect(
      await screen.findByRole("button", { name: "Choose another club · current club La Verdad" }),
    ).toBeInTheDocument();
  });

  it.each(["en", "ru"] as const)(
    "keeps the workspace title without a Host view suffix in %s",
    (locale) => {
      const { container } = render(
        <I18nProvider locale={locale}>
          <App />
        </I18nProvider>,
      );
      const header = container.querySelector(".app-status-bar");
      expect(header).toHaveTextContent("Mafia Malaga");
      expect(header?.querySelector(".eyebrow")?.textContent).not.toMatch(
        /host view|панель ведущего|режим ведущего|·\s*$/i,
      );
    },
  );

  it("restores the browser game owner before rendering a club workspace", async () => {
    api.getAuthSession.mockResolvedValue(authenticatedUser);
    api.listClubs.mockResolvedValue([testClub, otherClub]);
    seedBrowserGame(otherClub, "00000000-0000-4000-8000-000000000301", "Sevilla table");

    render(<WelcomeApp />);

    expect(
      await screen.findByRole("button", {
        name: "Choose another club · current club Mafia Sevilla",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mafia Malaga.*Málaga/i })).toBeNull();
  });

  it("blocks another club until the synchronized local game is explicitly released", async () => {
    const user = userEvent.setup();
    api.getAuthSession.mockResolvedValue(authenticatedUser);
    api.listClubs.mockResolvedValue([testClub, otherClub]);
    const gameId = "00000000-0000-4000-8000-000000000302";
    seedBrowserGame(testClub, gameId, "Malaga table");

    render(<WelcomeApp />);
    await user.click(
      await screen.findByRole("button", {
        name: "Choose another club · current club Mafia Malaga",
      }),
    );
    await user.click(await screen.findByRole("button", { name: /Mafia Sevilla.*Sevilla/i }));

    const dialog = screen.getByRole("dialog", { name: "Game attached to another club" });
    expect(dialog).toHaveTextContent("Malaga table");
    expect(dialog).toHaveTextContent("Mafia Malaga");
    await user.click(
      within(dialog).getByRole("button", { name: "Release and open Mafia Sevilla" }),
    );

    expect(window.localStorage.getItem("mafia-dashboard.game-session.v5")).toBeNull();
    expect(
      await screen.findByRole("button", {
        name: "Choose another club · current club Mafia Sevilla",
      }),
    ).toBeInTheDocument();
  });

  it("refreshes and opens the captured club when another tab already released the game", async () => {
    const user = userEvent.setup();
    api.getAuthSession.mockResolvedValue(authenticatedUser);
    api.listClubs.mockResolvedValue([testClub, otherClub]);
    const gameId = "00000000-0000-4000-8000-000000000302";
    seedBrowserGame(testClub, gameId, "Malaga table");

    render(<WelcomeApp />);
    await user.click(
      await screen.findByRole("button", {
        name: "Choose another club · current club Mafia Malaga",
      }),
    );
    await user.click(await screen.findByRole("button", { name: /Mafia Sevilla.*Sevilla/i }));

    const dialog = screen.getByRole("dialog", { name: "Game attached to another club" });
    expect(dialog).toHaveTextContent("Malaga table");
    expect(dialog).toHaveTextContent("Mafia Malaga");
    window.localStorage.removeItem("mafia-dashboard.game-session.v5");
    await user.click(
      within(dialog).getByRole("button", { name: "Release and open Mafia Sevilla" }),
    );

    expect(window.localStorage.getItem("mafia-dashboard.game-session.v5")).toBeNull();
    expect(
      await screen.findByRole("button", {
        name: "Choose another club · current club Mafia Sevilla",
      }),
    ).toBeInTheDocument();
  });

  it.each(["replacement", "invalid"] as const)(
    "does not release a %s record or open the blocked club",
    async (mode) => {
      const user = userEvent.setup();
      api.getAuthSession.mockResolvedValue(authenticatedUser);
      api.listClubs.mockResolvedValue([testClub, otherClub]);
      const gameId = "00000000-0000-4000-8000-000000000302";
      seedBrowserGame(testClub, gameId, "Malaga table");

      render(<WelcomeApp />);
      await user.click(
        await screen.findByRole("button", {
          name: "Choose another club · current club Mafia Malaga",
        }),
      );
      await user.click(await screen.findByRole("button", { name: /Mafia Sevilla.*Sevilla/i }));

      const dialog = screen.getByRole("dialog", { name: "Game attached to another club" });
      expect(dialog).toHaveTextContent("Malaga table");
      expect(dialog).toHaveTextContent("Mafia Malaga");
      window.localStorage.removeItem("mafia-dashboard.game-session.v5");
      if (mode === "replacement") {
        seedBrowserGame(testClub, "00000000-0000-4000-8000-000000000309", "Replacement");
      } else {
        window.localStorage.setItem("mafia-dashboard.game-session.v5", "invalid replacement");
      }
      const expected = window.localStorage.getItem("mafia-dashboard.game-session.v5");
      await user.click(
        within(dialog).getByRole("button", { name: "Release and open Mafia Sevilla" }),
      );

      expect(window.localStorage.getItem("mafia-dashboard.game-session.v5")).toBe(expected);
      expect(
        screen.queryByRole("button", {
          name: "Choose another club · current club Mafia Sevilla",
        }),
      ).toBeNull();
    },
  );

  it("keeps an unsynced game attached when another club is selected", async () => {
    const user = userEvent.setup();
    api.getAuthSession.mockResolvedValue(authenticatedUser);
    api.listClubs.mockResolvedValue([testClub, otherClub]);
    api.saveGameSessionOperation.mockRejectedValue(new Error("offline"));
    seedBrowserGame(testClub, "00000000-0000-4000-8000-000000000303", "Offline table", true);

    render(<WelcomeApp />);
    await user.click(
      await screen.findByRole("button", {
        name: "Choose another club · current club Mafia Malaga",
      }),
    );
    await user.click(await screen.findByRole("button", { name: /Mafia Sevilla.*Sevilla/i }));

    const dialog = screen.getByRole("dialog", { name: "Game attached to another club" });
    expect(
      within(dialog).getByRole("button", { name: "Release and open Mafia Sevilla" }),
    ).toBeDisabled();
    expect(dialog).toHaveTextContent("Sync the attached game before releasing it.");
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5")!),
    ).toMatchObject({
      clubId: testClub.id,
      outbox: [expect.any(Object)],
    });
  });

  it("discards an unavailable owner's unresolved local game before opening the captured target", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    api.getAuthSession.mockResolvedValue(authenticatedUser);
    api.listClubs.mockResolvedValue([testClub, otherClub]);
    const missingClub = {
      ...testClub,
      id: "00000000-0000-4000-8000-000000000399",
      name: "Unavailable club",
    };
    seedBrowserGame(
      missingClub,
      "00000000-0000-4000-8000-000000000398",
      "Unfinished unavailable table",
      true,
    );

    render(<WelcomeApp />);
    await user.click(await screen.findByRole("button", { name: /Mafia Sevilla.*Sevilla/i }));

    const dialog = screen.getByRole("dialog", { name: "Game attached to another club" });
    const discard = within(dialog).getByRole("button", {
      name: "Discard local game and open Mafia Sevilla",
    });
    expect(discard).toBeEnabled();
    await user.click(discard);

    expect(window.localStorage.getItem("mafia-dashboard.game-session.v5")).toBeNull();
    expect(
      await screen.findByRole("button", {
        name: "Choose another club · current club Mafia Sevilla",
      }),
    ).toBeInTheDocument();
  });

  it("refuses a stale missing-owner discard after another tab attaches a newer game", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    api.getAuthSession.mockResolvedValue(authenticatedUser);
    api.listClubs.mockResolvedValue([testClub, otherClub]);
    const missingClub = {
      ...testClub,
      id: "00000000-0000-4000-8000-000000000399",
      name: "Missing club",
    };
    seedBrowserGame(missingClub, "00000000-0000-4000-8000-000000000398", "Missing table");

    render(<WelcomeApp />);
    const dialog = await screen.findByRole("dialog", { name: "Game attached to another club" });
    expect(dialog).toHaveTextContent("Missing table");

    window.localStorage.removeItem("mafia-dashboard.game-session.v5");
    seedBrowserGame(otherClub, "00000000-0000-4000-8000-000000000397", "Newer Sevilla table", true);
    await user.click(within(dialog).getByRole("button", { name: "Discard local game" }));

    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5")!),
      ).toMatchObject({
        clubId: otherClub.id,
        gameId: "00000000-0000-4000-8000-000000000397",
      }),
    );
  });

  it("shows invalid current storage without changing it, then clears only after confirmation", async () => {
    const user = userEvent.setup();
    const raw = '{"version":5,"current":{}}';
    window.localStorage.setItem("mafia-dashboard.game-session.v5", raw);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    api.getAuthSession.mockResolvedValue(authenticatedUser);
    api.listClubs.mockResolvedValue([testClub, otherClub]);

    render(<WelcomeApp />);

    const dialog = await screen.findByRole("dialog", {
      name: "Browser game data needs attention",
    });
    expect(window.localStorage.getItem("mafia-dashboard.game-session.v5")).toBe(raw);
    await user.click(within(dialog).getByRole("button", { name: "Clear invalid local game" }));
    await waitFor(() =>
      expect(window.localStorage.getItem("mafia-dashboard.game-session.v5")).toBeNull(),
    );
    expect(
      window.sessionStorage.getItem(`mafia-dashboard.game-session.v5.claim.${testClub.id}.tab`),
    ).toBeNull();
  });

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

  it("moves focus into a toolbar drawer and restores it when Escape closes the drawer", async () => {
    const user = userEvent.setup();
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "Open Manage menu" });

    await user.click(trigger);

    const drawer = screen.getByRole("dialog", { name: "Manage" });
    expect(within(drawer).getByRole("heading", { name: "Manage" })).toHaveFocus();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "Manage" })).toBeNull();
    expect(trigger).toHaveFocus();
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
        bestMoveEnabled: true,
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
    seedBrowserGame(testClub, "00000000-0000-4000-8000-000000000308", "Deleted table");
    window.localStorage.setItem("unrelated-local", "keep");
    await user.click(await screen.findByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Delete club" }));

    expect(confirm).toHaveBeenCalledWith(
      'Delete "Mafia Malaga" and all of its players, games, and statistics? This cannot be undone.',
    );
    expect(api.deleteClub).toHaveBeenCalledWith(testClub.id);
    expect(window.localStorage.getItem("mafia-dashboard.game-session.v5")).toBeNull();
    expect(window.localStorage.getItem("unrelated-local")).toBe("keep");
    expect(await screen.findByRole("heading", { name: "Choose your club" })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Mafia Malaga.*Málaga/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it("signs out the current application session", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("unrelated-local", "keep");
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
    expect(window.localStorage.getItem("mafia-dashboard.game-session.v5")).toBeNull();
    expect(window.localStorage.getItem("unrelated-local")).toBe("keep");
    expect(
      window.sessionStorage.getItem(`mafia-dashboard.game-session.v5.claim.${testClub.id}.tab`),
    ).toBeNull();
    expect(window.sessionStorage.getItem("unrelated")).toBe("keep");
    expect(await screen.findByRole("link", { name: "Continue with Google" })).toBeInTheDocument();
  });
});

describe("workspace role authorization", () => {
  it("keeps regular users in the game workflow without manager, music, timeline, or Dev controls", async () => {
    const user = userEvent.setup();
    render(
      <ClubWorkspace
        club={{ ...testClub, role: "user" }}
        onExit={vi.fn()}
        onEditClub={vi.fn()}
        onDeleteClub={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const manage = await screen.findByRole("button", { name: "Open Manage menu" });
    expect(screen.queryByRole("button", { name: "Open game log" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Developer menu" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Select available players" }));
    expect(
      within(screen.getByRole("main")).getByRole("heading", { name: "Available players" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close available players" }));
    expect(musicPlayerHarness.mounts).toBe(0);

    await user.click(manage);
    expect(screen.getByRole("button", { name: "Start new game" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Active games" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Players screen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Music player setup" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit club" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete club" })).toBeNull();
    expect(screen.queryByLabelText("Glass color")).toBeNull();
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

  it("returns from the under-eleven player directory to the existing setup without a navigation trap", async () => {
    const user = userEvent.setup();
    api.listPlayers.mockResolvedValue([]);
    render(
      <ClubWorkspace
        club={testClub}
        onExit={() => undefined}
        onEditClub={() => undefined}
        onDeleteClub={() => Promise.resolve()}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Players & statistics" }),
    ).toBeInTheDocument();
    const back = screen.getByRole("button", { name: "Back to game" });
    back.focus();
    await user.keyboard("{Enter}");

    expect(screen.getAllByRole("heading", { name: "Game setup" })).not.toHaveLength(0);
    expect(screen.queryByRole("heading", { name: "Players & statistics" })).toBeNull();
  });
});

describe("manage menu", () => {
  it("does not mount a saved playlist player until the account is confirmed connected", async () => {
    const status = deferred<{
      configured: boolean;
      connected: boolean;
      accountLabel: string | null;
    }>();
    api.getMusicAccountStatus.mockReturnValueOnce(status.promise);
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
    const user = userEvent.setup();

    render(<App />);

    expect(screen.queryByTestId("youtube-player")).toBeNull();
    status.resolve({ configured: true, connected: false, accountLabel: null });
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    expect(
      await screen.findByRole("link", { name: "Connect YouTube Music account" }),
    ).toHaveAttribute("href", "/api/music/oauth/start");
    expect(screen.queryByTestId("youtube-player")).toBeNull();
  });

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

  it("moves role-giveaway return into Manage without resetting the draw", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Enter role giveaway" }));
    await user.click(screen.getByRole("button", { name: "Assign first role" }));
    const beforeBack = JSON.parse(screen.getByTestId("setup-session").textContent ?? "null");
    const clearCallsBeforeBack = api.clearGameSession.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));

    const manage = screen.getByRole("dialog", { name: "Manage" });
    const back = within(manage).getByRole("button", { name: "Back to player selection" });
    back.focus();
    await user.keyboard("{Enter}");

    expect(screen.queryByRole("dialog", { name: "Manage" })).toBeNull();
    expect(screen.getAllByRole("heading", { name: "Game setup" })).not.toHaveLength(0);
    expect(JSON.parse(screen.getByTestId("setup-session").textContent ?? "null")).toEqual({
      ...beforeBack,
      step: "players",
    });
    expect(api.clearGameSession).toHaveBeenCalledTimes(clearCallsBeforeBack);
  });

  it("returns the player directory to an active game without resetting it", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("heading", { name: "Live test game" });
    const liveGame = gameScreenHarness.liveGame;
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Players screen" }));
    await user.click(screen.getByRole("button", { name: "Back to game" }));

    expect(screen.getByRole("heading", { name: "Live test game" })).toBeInTheDocument();
    expect(gameScreenHarness.liveGame).toBe(liveGame);
    expect(api.clearGameSession).not.toHaveBeenCalled();
  });
});

describe("developer menu", () => {
  it("keeps player lighting enabled with a retired disabled setting while retaining Raytracing and pulse controls", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("mafia-dashboard.player-lighting.v1", "disabled");
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));

    expect(screen.queryByRole("button", { name: /player LEDs/i })).toBeNull();
    expect(document.querySelector(".app-shell")).not.toHaveAttribute("data-player-lighting");

    const raytracing = screen.getByRole("button", { name: "Disable Raytracing" });
    expect(raytracing).toHaveAttribute("aria-pressed", "true");
    await user.click(raytracing);
    expect(window.localStorage.getItem(LIGHTING_RENDERER_STORAGE_KEY)).toBe("legacy");
    expect(document.querySelector(".app-shell")).toHaveAttribute(
      "data-lighting-renderer",
      "legacy",
    );
    expect(screen.getByRole("button", { name: "Enable Raytracing" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "Disable player glow pulse" })).toBeDisabled();

    const enableRaytracing = screen.getByRole("button", { name: "Enable Raytracing" });
    enableRaytracing.focus();
    expect(enableRaytracing).toHaveFocus();
    await user.click(enableRaytracing);
    expect(window.localStorage.getItem(LIGHTING_RENDERER_STORAGE_KEY)).toBe("vgpu");
    expect(document.querySelector(".app-shell")).toHaveAttribute(
      "data-lighting-renderer-requested",
      "vgpu",
    );

    await user.click(screen.getByRole("button", { name: "Disable player glow pulse" }));
    fireEvent.change(screen.getByLabelText("Player glow pulse speed"), {
      target: { value: "2.5" },
    });
    fireEvent.change(screen.getByLabelText("Player glow pulse strength"), {
      target: { value: "29" },
    });
    expect(screen.getByText("Strength: 29%")).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(PLAYER_PULSE_STORAGE_KEY) ?? "null")).toEqual({
      enabled: false,
      speed: 2.5,
      strength: 0.29,
    });
  });

  it("resolves a historical SVG request to V-GPU and falls back to existing CSS", async () => {
    window.localStorage.setItem(LIGHTING_RENDERER_STORAGE_KEY, "svg");
    render(<App />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Open developer menu" }));

    expect(screen.getByRole("button", { name: "Disable Raytracing" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(document.querySelector(".app-shell")).toHaveAttribute(
      "data-lighting-renderer-requested",
      "vgpu",
    );
    expect(await screen.findByText("V-GPU unavailable — using existing CSS")).toBeInTheDocument();
    expect(window.localStorage.getItem(LIGHTING_RENDERER_STORAGE_KEY)).toBe("svg");
    expect(document.querySelector(".app-shell")).toHaveAttribute(
      "data-lighting-renderer",
      "legacy",
    );
    expect(document.querySelector(".app-shell")).toHaveAttribute("data-vgpu-status", "fallback");
  });

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

  it("restores developer access and enabled tools independently after remount", async () => {
    const user = userEvent.setup();
    const firstView = renderView(<App />);
    const privacy = screen.getByRole("button", { name: "Hide private info" });
    for (let tap = 0; tap < 5; tap += 1) fireEvent.click(privacy);
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    expect(screen.getByRole("button", { name: "Enable dev mode" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Enable dev mode" }));
    expect(window.localStorage.getItem(DEVELOPER_UNLOCKED_STORAGE_KEY)).toBe("unlocked");
    expect(window.localStorage.getItem(DEVELOPER_MODE_ENABLED_STORAGE_KEY)).toBe("enabled");
    firstView.unmount();

    renderView(<App />);
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    expect(screen.getByRole("button", { name: "Disable dev mode" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate test players" })).toBeInTheDocument();
  });

  it("rejects malformed persisted developer flags and keeps manager guards authoritative", () => {
    window.localStorage.setItem(DEVELOPER_UNLOCKED_STORAGE_KEY, "yes");
    window.localStorage.setItem(DEVELOPER_MODE_ENABLED_STORAGE_KEY, "true");
    renderView(
      <ClubWorkspace
        club={{ ...testClub, role: "user" }}
        onExit={() => undefined}
        onEditClub={() => undefined}
        onDeleteClub={() => Promise.resolve()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Open developer menu" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate test players" })).not.toBeInTheDocument();
  });

  it("hides developer access, disables tools, and preserves lighting preferences", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(LIGHTING_RENDERER_STORAGE_KEY, "legacy");
    window.localStorage.setItem(
      PLAYER_PULSE_STORAGE_KEY,
      JSON.stringify({ enabled: false, speed: 2, strength: 0.25 }),
    );
    render(<App />);
    const privacy = screen.getByRole("button", { name: "Hide private info" });
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Enable dev mode" }));
    await user.click(screen.getByRole("button", { name: "Hide developer mode" }));

    expect(screen.queryByRole("dialog", { name: "Developer menu" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open developer menu" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate test players" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(DEVELOPER_UNLOCKED_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(DEVELOPER_MODE_ENABLED_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(LIGHTING_RENDERER_STORAGE_KEY)).toBe("legacy");
    expect(JSON.parse(window.localStorage.getItem(PLAYER_PULSE_STORAGE_KEY) ?? "null")).toEqual({
      enabled: false,
      speed: 2,
      strength: 0.25,
    });
    await waitFor(() => expect(privacy).toHaveFocus());
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
    const version = within(menu).getByLabelText("Canary version 1.0.0");
    expect(version).toHaveTextContent("Canary v1.0.0");
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

  it("flushes role giveaway queued while a manual readiness check is in flight", async () => {
    const user = userEvent.setup();
    const readiness = deferred<void>();
    api.checkServerReady.mockReturnValue(readiness.promise);
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: "Saved to server · tap to check connection" }),
    );
    await waitFor(() => expect(api.checkServerReady).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "Enter role giveaway" }));
    expect(api.saveGameSession).not.toHaveBeenCalled();

    readiness.resolve();
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalledOnce());
    expect(
      screen.getByRole("button", { name: "Saved to server · tap to check connection" }),
    ).toHaveAttribute("data-status", "saved");
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null"),
    ).toMatchObject({ outbox: [] });
  });

  it("previews and resets the active game from its current timeline", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("button", { name: "Record meaningful checkpoint" });
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
      "Reset the active game to log #1? 1 later action will be permanently deleted.",
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
    await screen.findByRole("heading", { name: "Live test game" });
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
        expect.objectContaining({
          kind: "snapshot",
          state: expect.objectContaining({
            events: expect.arrayContaining([expect.objectContaining({ type: "foul.issued" })]),
          }),
        }),
        testClub.id,
      ),
    );
  });

  it("opens a full-screen error Console from Dev without changing the live session", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("heading", { name: "Live test game" });
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalled());
    const beforeConsole = window.localStorage.getItem("mafia-dashboard.game-session.v5");
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
    expect(window.localStorage.getItem("mafia-dashboard.game-session.v5")).toBe(beforeConsole);
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

  it.each([0, 4, 10])(
    "routes New game from Players to availability with %i available players",
    async (availableCount) => {
      const user = userEvent.setup();
      const playerIds = [...assignedGame.players.map(({ id }) => id), hostPlayerId];
      const storageKey = `mafia-dashboard.available-player-ids.${testClub.id}`;
      const otherStorageKey = `mafia-dashboard.available-player-ids.${otherClub.id}`;
      const selectedIds = playerIds.slice(0, availableCount);
      window.localStorage.setItem(storageKey, JSON.stringify(selectedIds));
      window.localStorage.setItem(otherStorageKey, JSON.stringify(playerIds));
      render(<App />);
      await waitFor(() => expect(api.listPlayers).toHaveBeenCalledWith(testClub.id));

      await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
      await user.click(screen.getByRole("button", { name: "Players screen" }));
      await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
      await user.click(screen.getByRole("button", { name: "Start new game" }));

      expect(
        within(screen.getByRole("main")).getByRole("heading", { name: "Available players" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("banner", { name: "Application status" })).toHaveTextContent(
        "Available players",
      );
      expect(screen.queryByRole("dialog", { name: "Manage" })).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      const cards = within(screen.getByRole("group", { name: "Player availability" }));
      expect(cards.queryAllByRole("button", { pressed: true })).toHaveLength(availableCount);
      expect(window.localStorage.getItem(storageKey)).toBe(JSON.stringify(selectedIds));

      for (const card of cards.getAllByRole("button", { pressed: false })) {
        await user.click(card);
      }
      await user.click(screen.getByRole("button", { name: "Close available players" }));
      expect(
        within(screen.getByRole("main")).getByRole("heading", { name: "Game setup" }),
      ).toBeInTheDocument();
      expect(screen.getByTestId("setup-player-pool")).toHaveTextContent(
        [...assignedGame.players.map(({ name }) => name), "Host Player"].join(","),
      );
      expect(JSON.parse(window.localStorage.getItem(storageKey) ?? "null")).toEqual(playerIds);
      expect(window.localStorage.getItem(otherStorageKey)).toBe(JSON.stringify(playerIds));
      expect(api.saveGameSession).not.toHaveBeenCalled();
      expect(api.clearGameSession).not.toHaveBeenCalled();
    },
  );

  it("routes New game from setup to availability when none are selected", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(api.listPlayers).toHaveBeenCalledWith(testClub.id));
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Start new game" }));

    expect(
      within(screen.getByRole("main")).getByRole("heading", { name: "Available players" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
    window.localStorage.setItem("mafia-dashboard.player-lighting.v1", "disabled");
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
    expect(firstCard.querySelector(".vgpu-player-lighting")).not.toBeNull();
    expect(document.querySelector(".app-shell")).not.toHaveAttribute("data-player-lighting");

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

  it("resets workspace scrolling when role giveaway enters the live table", async () => {
    const user = userEvent.setup();
    render(<App />);
    const appShell = document.querySelector<HTMLElement>(".app-shell")!;
    appShell.scrollTop = 120;
    appShell.scrollLeft = 40;

    await user.click(screen.getByRole("button", { name: "Enter role giveaway" }));

    expect(screen.getByRole("heading", { name: "Role giveaway" })).toBeInTheDocument();
    expect(appShell).toHaveClass("has-live-game", "table-layout-shell");
    expect(appShell.scrollTop).toBe(0);
    expect(appShell.scrollLeft).toBe(0);
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
    await screen.findByRole("button", { name: "Record meaningful checkpoint" });
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
    const player = await screen.findByTestId("youtube-player");
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
    const player = await screen.findByTestId("youtube-player");

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
    const player = await screen.findByTestId("youtube-player");
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
    await screen.findByTestId("youtube-player");
    act(() => musicPlayerHarness.setState?.("playing"));
    await user.click(screen.getByRole("button", { name: "Enter role giveaway" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start test game" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Start test game" }));

    expect(musicPlayerHarness.playFirstRegularTrack).toHaveBeenCalledOnce();
  });

  it("quick-fades before an Endgame-preferred shuffle when Night ends in Critical Best move", async () => {
    const user = userEvent.setup();
    const fade = deferred<void>();
    musicPlayerHarness.quickFadeOut.mockReturnValueOnce(fade.promise);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("heading", { name: "Live test game" });
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
    await screen.findByRole("heading", { name: "Live test game" });
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
    const player = await screen.findByTestId("youtube-player");
    await user.click(await screen.findByRole("button", { name: "Record game action" }));
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
    const player = await screen.findByTestId("youtube-player");

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
    expect(screen.getByTestId("youtube-player")).toBe(player);
    expect(musicPlayerHarness).toMatchObject({ mounts: 1, unmounts: 0 });
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

  it("restores the club's last playlist when no active game session supplies one", async () => {
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

    expect(await screen.findByTestId("youtube-player")).toHaveAttribute(
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
    expect(await screen.findByTestId("youtube-player")).toHaveAttribute(
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
    const player = await screen.findByTestId("youtube-player");

    await user.click(screen.getByRole("button", { name: "Start test game" }));
    expect(player).toHaveAttribute("data-playlist-id", "PL-base");
    await user.click(await screen.findByRole("button", { name: "Enter voting phase" }));
    expect(player).toHaveAttribute("data-playlist-id", "PL-base");
    await user.click(screen.getByRole("button", { name: "Enter night phase" }));
    expect(player).toHaveAttribute("data-playlist-id", "PL-base");
    expect(screen.getByTestId("youtube-player")).toBe(player);
    expect(musicPlayerHarness).toMatchObject({ mounts: 1, unmounts: 0 });
  });

  it.each(["success", "failure"] as const)(
    "ignores an in-flight account refresh %s after disconnect",
    async (outcome) => {
      const refresh = deferred<{
        configured: boolean;
        connected: boolean;
        accountLabel: string | null;
      }>();
      const user = userEvent.setup();
      render(<App />);
      const player = await screen.findByTestId("youtube-player");
      api.getMusicAccountStatus.mockReturnValueOnce(refresh.promise);

      await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
      await user.click(screen.getByRole("button", { name: "Music player setup" }));
      await waitFor(() => expect(api.getMusicAccountStatus).toHaveBeenCalledTimes(2));
      expect(screen.getByTestId("youtube-player")).toBe(player);
      await user.click(screen.getByRole("button", { name: "Disconnect account" }));
      expect(screen.queryByTestId("youtube-player")).toBeNull();

      await act(async () => {
        if (outcome === "success") {
          refresh.resolve({ configured: true, connected: true, accountLabel: "Mafia Host" });
        } else {
          refresh.reject(new Error("Stale status request failed"));
        }
      });
      expect(screen.queryByTestId("youtube-player")).toBeNull();
      expect(
        screen.queryAllByRole("link", { name: "Connect YouTube Music account" }),
      ).not.toHaveLength(0);
      expect(musicPlayerHarness).toMatchObject({ mounts: 1, unmounts: 1 });
    },
  );

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
    const player = await screen.findByTestId("youtube-player");

    await user.click(screen.getByRole("button", { name: "Start test game" }));
    expect(player).toHaveAttribute("data-playlist-id", "PL-base");
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Music player setup" }));
    await user.click(screen.getByRole("button", { name: "Disconnect account" }));
    await act(async () => Promise.resolve());

    expect(screen.queryByTestId("youtube-player")).toBeNull();
    expect(musicPlayerHarness).toMatchObject({ mounts: 1, unmounts: 1 });
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

    const player = await screen.findByTestId("youtube-player");
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

  it.each([false, true])(
    "ignores privacy during real role giveaway (initially hidden: %s) but preserves it for gameplay",
    async (initiallyHidden) => {
      const { SetupWizard: RealSetupWizard } = await vi.importActual<typeof setupWizardModule>(
        "./features/setup/SetupWizard.js",
      );
      const setupMock = vi
        .spyOn(setupWizardModule, "SetupWizard")
        .mockImplementation(RealSetupWizard);
      const { GameScreen: RealGameScreen } = await vi.importActual<typeof gameScreenModule>(
        "./features/game/GameScreen.js",
      );
      const gameMock = vi.spyOn(gameScreenModule, "GameScreen").mockImplementation(RealGameScreen);
      window.localStorage.setItem(
        `mafia-dashboard.available-player-ids.${testClub.id}`,
        JSON.stringify([...assignedGame.players.map(({ id }) => id), hostPlayerId]),
      );
      const user = userEvent.setup();
      try {
        renderView(<App />);
        const host = await screen.findByRole("combobox", { name: "Host player" });
        await user.click(host);
        await user.click(screen.getByRole("option", { name: "Host Player" }));
        for (const { seat, name } of assignedGame.players) {
          await user.click(screen.getByRole("combobox", { name: `Seat ${seat} player` }));
          await user.click(screen.getByRole("option", { name }));
        }
        if (initiallyHidden) {
          await user.click(screen.getByRole("button", { name: "Hide private info" }));
        }
        await user.click(screen.getByRole("button", { name: /^start game$/i }));
        await waitFor(() => expect(api.createGameSession).toHaveBeenCalledOnce());
        await user.click(screen.getByRole("button", { name: "Draw role for Player 1" }));
        const table = screen.getByRole("region", { name: "Mafia table" });
        const firstBadge = table.querySelector(".role-badge");
        expect(firstBadge).toBeVisible();
        expect(table.querySelectorAll(".role-badge")).toHaveLength(1);
        expect(screen.getByText("Draw roles · 9 remaining")).toBeVisible();

        for (let toggle = 0; toggle < 2; toggle += 1) {
          await user.click(screen.getByRole("button", { name: /^(show|hide) private info$/i }));
          expect(table.querySelector(".role-badge")).toBe(firstBadge);
          expect(firstBadge).toBeVisible();
          expect(table.querySelectorAll(".role-badge")).toHaveLength(1);
          expect(screen.getAllByRole("button", { name: /^Draw role for/ })).toHaveLength(9);
          expect(screen.getByText("Draw roles · 9 remaining")).toBeVisible();
        }
        if (!initiallyHidden) {
          await user.click(screen.getByRole("button", { name: "Hide private info" }));
        }
        for (const { name } of assignedGame.players.slice(1)) {
          await user.click(screen.getByRole("button", { name: `Draw role for ${name}` }));
        }
        expect(table.querySelectorAll(".role-badge")).toHaveLength(10);
        expect(screen.getByText("Draw roles · 0 remaining")).toBeVisible();
        await user.click(screen.getByRole("button", { name: "Begin Mafia planning stage" }));
        expect(screen.queryByRole("heading", { name: "Role giveaway" })).not.toBeInTheDocument();
        const gameTable = screen.getByRole("region", { name: "Mafia table" });
        expect(gameTable.querySelectorAll(".role-badge")).toHaveLength(0);
        expect(screen.getByRole("button", { name: "Show private info" })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        await user.click(screen.getByRole("button", { name: "Show private info" }));
        expect(gameTable.querySelectorAll(".role-badge")).toHaveLength(10);
      } finally {
        cleanup();
        setupMock.mockRestore();
        gameMock.mockRestore();
      }
    },
  );

  it("uses the fixed mask control to hide private game information", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    expect(await screen.findByText("Private info visible")).toBeInTheDocument();

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
    await user.click(screen.getByRole("button", { name: "Enter role giveaway" }));
    await waitFor(() => expect(api.createGameSession).toHaveBeenCalled());
    expect(screen.getByRole("heading", { name: "Role giveaway" })).toBeInTheDocument();

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
    await screen.findByRole("heading", { name: "Live test game" });
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Clear all data" }));

    expect(confirm).toHaveBeenCalledWith(
      "Clear all data stored by Mafia Dashboard in this browser? Server players, sessions, results, and music will not be deleted.",
    );
    expect(api.clearAllData).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(window.localStorage.getItem("other-local-data")).toBeNull();
      expect(window.sessionStorage.getItem("other-session-data")).toBeNull();
    });
    await waitFor(() =>
      expect(screen.getByRole("banner", { name: "Application status" })).toHaveTextContent(
        "Game setup",
      ),
    );
    api.saveGameSession.mockClear();
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("heading", { name: "Live test game" });
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalled());
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
    const musicPlayer = await screen.findByTestId("youtube-player");
    expect(musicPlayer).toHaveAttribute("data-playlist-id", "remembered-playlist");

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Clear all data" }));
    await waitFor(() =>
      expect(window.localStorage.getItem(musicPreferencesStorageKey(testClub.id))).toBeNull(),
    );
    await waitFor(() => {
      expect(musicPlayer).toHaveAttribute("data-playlist-id", "");
    });
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
    }).toEqual({
      playlistId: "",
      rememberedOrder: "",
      selectedPlaylist: "",
      consoleIsEmpty: true,
    });
    expect(window.localStorage.getItem(musicPreferencesStorageKey(testClub.id))).toBeNull();
    expect(api.clearAllData).not.toHaveBeenCalled();
  });
});

describe("authoritative game session lifecycle", () => {
  it("holds role assignment and gameplay until POST returns a server GUID", async () => {
    const user = userEvent.setup();
    const pending = deferred<RemoteGameSession>();
    api.createGameSession.mockReturnValueOnce(pending.promise);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Enter role giveaway" }));
    await waitFor(() => expect(api.createGameSession).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Assign first role" })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: "Start test game" })).toBeDisabled();
    expect(api.saveGameSession).not.toHaveBeenCalled();
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null"),
    ).toMatchObject({
      gameId: null,
      creationId: expect.any(String),
      current: { state: { game: null, setup: { step: "roles" } } },
    });

    pending.resolve(
      remoteSession("00000000-0000-4000-8000-000000000090", "Table", "Host Player", 1, 1),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Assign first role" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("heading", { name: "Live test game" });
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null"),
    ).toMatchObject({ gameId: "00000000-0000-4000-8000-000000000090" });
  });

  it("treats a 404 for an acknowledged legacy game as removed, never a new POST", async () => {
    const id = "00000000-0000-4000-8000-000000000081";
    seedBrowserGame(testClub, id, "Deleted table");
    const raw = JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5")!);
    delete raw.creationId;
    delete raw.removed;
    delete raw.legacyGameId;
    window.localStorage.setItem("mafia-dashboard.game-session.v5", JSON.stringify(raw));
    api.getGameSession.mockRejectedValueOnce(new ApiError("missing", 404, "not_found"));
    render(<App />);
    await waitFor(() => expect(api.getGameSession).toHaveBeenCalledWith(id, testClub.id));
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null"),
      ).toMatchObject({ gameId: id, removed: true, creationId: null }),
    );
    expect(api.createGameSession).not.toHaveBeenCalled();
    expect(api.saveGameSession).not.toHaveBeenCalled();
  });
  it("starts a new game without deleting the saved previous game", async () => {
    const user = userEvent.setup();
    const oldId = "00000000-0000-4000-8000-000000000081";
    seedBrowserGame(testClub, oldId, "Table A");
    api.listActiveGameSessions.mockResolvedValue([
      {
        gameId: oldId,
        name: "Table A",
        revision: 1,
        hostName: "Host Player",
        phase: "day",
        day: 1,
        updatedAt: "2026-08-18T09:00:00.000Z",
      },
    ]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Start new game" }));

    expect(api.clearGameSession).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("mafia-dashboard.game-session.v5")).toBeNull();
    expect(screen.getByRole("searchbox", { name: "Search available players" })).toBeInTheDocument();
    for (const { name } of assignedGame.players) {
      await user.click(screen.getByRole("button", { name: `Mark ${name} available` }));
    }
    await user.click(screen.getByRole("button", { name: "Mark Host Player available" }));
    await user.click(screen.getByRole("button", { name: "Close available players" }));
    await user.click(screen.getByRole("button", { name: "Enter role giveaway" }));
    await waitFor(() => expect(api.createGameSession).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null"),
      ).toMatchObject({ gameId: "00000000-0000-4000-8000-000000000090" }),
    );
    expect(api.clearGameSession).not.toHaveBeenCalled();
    api.getGameSession.mockResolvedValueOnce(remoteSession(oldId, "Table A", "Host Player", 1, 1));
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(await screen.findByRole("button", { name: "Resume Table A" }));
    await waitFor(() => expect(api.getGameSession).toHaveBeenCalledWith(oldId, testClub.id));
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null"),
      ).toMatchObject({ gameId: oldId }),
    );
  });

  it.each(["success", "failure"])(
    "reconciles deleted A after opening B returns %s",
    async (outcome) => {
      const user = userEvent.setup();
      const oldId = "00000000-0000-4000-8000-000000000081";
      const newId = "00000000-0000-4000-8000-000000000082";
      const deletion = deferred<void>();
      seedBrowserGame(testClub, oldId, "Table A");
      const seeded = JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5")!);
      seeded.current.state = remoteSession(oldId, "Table A", "Host A", 1, 1).state;
      window.localStorage.setItem("mafia-dashboard.game-session.v5", JSON.stringify(seeded));
      api.clearGameSession.mockReturnValue(deletion.promise);
      if (outcome === "success") {
        api.getGameSession.mockResolvedValue(remoteSession(newId, "Table B", "Host B", 2, 3));
      } else {
        api.getGameSession.mockRejectedValue(new Error("B could not be opened"));
      }
      api.listActiveGameSessions.mockResolvedValue([
        {
          gameId: oldId,
          name: "Table A",
          revision: 1,
          hostName: "Host A",
          phase: "day",
          day: 1,
          updatedAt: "2026-08-18T09:00:00.000Z",
        },
        {
          gameId: newId,
          name: "Table B",
          revision: 2,
          hostName: "Host B",
          phase: "day",
          day: 3,
          updatedAt: "2026-08-18T09:00:00.000Z",
        },
      ]);
      vi.spyOn(window, "confirm").mockReturnValue(true);
      render(<App />);
      await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
      await user.click(await screen.findByRole("button", { name: "Delete Table A" }));
      await waitFor(() => expect(api.clearGameSession).toHaveBeenCalledWith(oldId, testClub.id));
      await user.click(screen.getByRole("button", { name: "Resume Table B" }));
      if (outcome === "success") await screen.findByText("Host: Host B");
      else await waitFor(() => expect(api.getGameSession).toHaveBeenCalledWith(newId, testClub.id));
      deletion.resolve();
      await act(async () => {
        await deletion.promise;
        await Promise.resolve();
      });

      if (outcome === "success") {
        expect(screen.getByText("Host: Host B")).toBeInTheDocument();
        expect(
          JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null"),
        ).toMatchObject({ gameId: newId });
      } else {
        expect(screen.queryByRole("heading", { name: "Live test game" })).not.toBeInTheDocument();
        expect(window.localStorage.getItem("mafia-dashboard.game-session.v5")).toBeNull();
      }
    },
  );
  it("ignores a pending resume response after that game is deleted", async () => {
    const user = userEvent.setup();
    const gameId = "00000000-0000-4000-8000-000000000081";
    const remote = remoteSession(gameId, "Table A", "Host A", 1, 1);
    const pendingResume = deferred<typeof remote>();
    seedBrowserGame(testClub, gameId, "Table A");
    api.getGameSession.mockReturnValue(pendingResume.promise);
    api.listActiveGameSessions.mockResolvedValue([remote]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(await screen.findByRole("button", { name: "Resume Table A" }));
    await waitFor(() => expect(api.getGameSession).toHaveBeenCalledWith(gameId, testClub.id));
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(await screen.findByRole("button", { name: "Delete Table A" }));
    await waitFor(() =>
      expect(window.localStorage.getItem("mafia-dashboard.game-session.v5")).toBeNull(),
    );

    await act(async () => {
      pendingResume.resolve(remote);
      await pendingResume.promise;
    });

    expect(window.localStorage.getItem("mafia-dashboard.game-session.v5")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Live test game" })).not.toBeInTheDocument();
  });

  it("keeps incomplete player and music setup out of the durable game session", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(api.listPlayers).toHaveBeenCalledOnce());

    await user.click(screen.getByRole("button", { name: "Save setup progress" }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Restored setup" })).toBeVisible(),
    );
    expect(api.saveGameSession).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("mafia-dashboard.game-session.v5")).toBeNull();
  });

  it("creates the first durable snapshot when valid setup enters role giveaway", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Enter role giveaway" }));

    await waitFor(() => expect(api.createGameSession).toHaveBeenCalledOnce());
    const gameId = "00000000-0000-4000-8000-000000000090";
    const roleDeck = assignedGame.players.map(({ role }) => role);
    expect(api.createGameSession).toHaveBeenCalledWith(
      expect.objectContaining({
        creationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        state: expect.objectContaining({
          setup: {
            step: "roles",
            hostPlayerId,
            selectedPlayerIds: assignedGame.players.map(({ id }) => id),
            setup: {
              step: "role-draw",
              players: assignedGame.players.map(({ id, name, seat }) => ({ id, name, seat })),
              roleDeck,
              remainingRoles: roleDeck,
              assignments: {},
            },
          },
          hostPlayerId,
          hostName: "Host Player",
          log: [],
        }),
      }),
      testClub.id,
    );
    expect(gameId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null"),
    ).toMatchObject({
      gameId,
      current: { state: { setup: { step: "roles", setup: { assignments: {} } } } },
    });
  });

  it("restores zero and partial role giveaway snapshots and completes on the same game ID", async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);
    await user.click(screen.getByRole("button", { name: "Enter role giveaway" }));
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalledOnce());
    const gameId = api.saveGameSession.mock.calls[0]?.[0] as string;
    firstRender.unmount();

    const secondRender = render(<App />);
    expect(JSON.parse(screen.getByTestId("setup-session").textContent ?? "null")).toMatchObject({
      step: "roles",
      setup: { assignments: {}, remainingRoles: expect.any(Array) },
    });
    await user.click(screen.getByRole("button", { name: "Assign first role" }));
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalledTimes(2));
    secondRender.unmount();

    render(<App />);
    const restored = JSON.parse(screen.getByTestId("setup-session").textContent ?? "null");
    expect(restored).toMatchObject({
      step: "roles",
      setup: { assignments: { "1": "sheriff" }, remainingRoles: expect.any(Array) },
    });
    expect(restored.setup.remainingRoles).toHaveLength(9);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalledTimes(3));
    expect(api.saveGameSession.mock.calls.map(([savedGameId]) => savedGameId)).toEqual([
      gameId,
      gameId,
      gameId,
    ]);
  });

  it("persists role-giveaway back-navigation and reuses its game ID across reloads", async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);
    await user.click(screen.getByRole("button", { name: "Enter role giveaway" }));
    await user.click(screen.getByRole("button", { name: "Assign first role" }));
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Manage" })).getByRole("button", {
        name: "Back to player selection",
      }),
    );

    let persisted: {
      gameId: string;
      current: { state: { setup: SetupWizardSessionState } };
    } | null = null;
    await waitFor(() => {
      persisted = JSON.parse(
        window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null",
      );
      expect(persisted).toMatchObject({
        gameId: expect.any(String),
        current: {
          state: { setup: { step: "players", setup: { assignments: { 1: expect.any(String) } } } },
        },
      });
    });
    const gameId = persisted!.gameId;
    const assignment = persisted!.current.state.setup.setup!.assignments[1];
    firstRender.unmount();

    const secondRender = render(<App />);
    expect(screen.getAllByRole("heading", { name: "Game setup" })).not.toHaveLength(0);
    expect(JSON.parse(screen.getByTestId("setup-session").textContent ?? "null")).toMatchObject({
      step: "players",
      setup: { assignments: { 1: assignment } },
    });
    await user.click(screen.getByRole("button", { name: "Enter role giveaway" }));
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null"),
      ).toMatchObject({
        gameId,
        current: { state: { setup: { step: "roles", setup: { assignments: { 1: assignment } } } } },
      }),
    );
    secondRender.unmount();

    render(<App />);
    expect(screen.getByRole("heading", { name: "Role giveaway" })).toBeInTheDocument();
    expect(new Set(api.saveGameSession.mock.calls.map(([savedGameId]) => savedGameId))).toEqual(
      new Set([gameId]),
    );
  });

  it("retries an offline first role-giveaway save with its durable identity and mutation", async () => {
    const user = userEvent.setup();
    api.saveGameSession.mockRejectedValue(new Error("offline"));
    api.checkServerReady.mockRejectedValue(new Error("offline"));
    const firstRender = render(<App />);
    await user.click(screen.getByRole("button", { name: "Enter role giveaway" }));
    await waitFor(() => expect(api.createGameSession).toHaveBeenCalledOnce());
    const operation = api.createGameSession.mock.calls[0]?.[0] as { creationId: string };
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null"),
    ).toMatchObject({
      gameId: null,
      creationId: operation.creationId,
      failed: true,
      outbox: [],
      current: { state: { setup: { step: "roles" } } },
    });
    firstRender.unmount();

    api.saveGameSession.mockResolvedValue({ revision: 2, duplicate: false });
    api.checkServerReady.mockResolvedValue(undefined);
    render(<App />);

    await waitFor(() => expect(api.createGameSession).toHaveBeenCalledTimes(2));
    expect(api.createGameSession.mock.calls[1]?.[0]).toMatchObject({
      creationId: operation.creationId,
    });
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null"),
      ).toMatchObject({ gameId: "00000000-0000-4000-8000-000000000090", creationId: null }),
    );
  });

  it("persists the complete browser state after an intermediate turn without adding a semantic event", async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("heading", { name: "Live test game" });
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalled());
    api.saveGameSession.mockClear();

    await user.click(screen.getByRole("button", { name: "Record game action" }));
    expect(screen.getByText("Game turn 1")).toBeInTheDocument();
    await waitFor(() =>
      expect(api.saveGameSession).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          kind: "snapshot",
          state: expect.objectContaining({
            game: expect.objectContaining({ currentTurnIndex: 1 }),
          }),
        }),
        testClub.id,
      ),
    );
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null"),
    ).toMatchObject({
      current: {
        state: {
          game: expect.objectContaining({ currentTurnIndex: 1 }),
          events: [expect.objectContaining({ type: "game.checkpointed" })],
        },
      },
    });
    await user.click(screen.getByRole("button", { name: "Open game log" }));
    expect(screen.queryByText("turn.completed")).toBeNull();

    firstRender.unmount();
    render(<App />);
    expect(screen.getByText("Game turn 1")).toBeInTheDocument();
  });

  it("persists a day-one nominee and folds omitted turns into the Mafia shot checkpoint", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("heading", { name: "Live test game" });
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalled());
    api.saveGameSession.mockClear();

    await user.click(screen.getByRole("button", { name: "Record nomination" }));
    await waitFor(() =>
      expect(api.saveGameSession).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          kind: "snapshot",
          state: expect.objectContaining({
            events: expect.arrayContaining([expect.objectContaining({ type: "player.nominated" })]),
          }),
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
          kind: "snapshot",
          state: expect.objectContaining({
            events: expect.arrayContaining([
              expect.objectContaining({ type: "mafia.shots-resolved" }),
            ]),
          }),
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
      window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null",
    ) as {
      current: {
        state: {
          initialGame: InitialGameBaseline;
          events: GameLogEntry[];
          headEventId: string;
        };
      };
    };
    const { state } = persisted.current;
    expect(state.events).toHaveLength(3);
    expect(state.events[1]).toMatchObject({
      type: "player.nominated",
      parentEventId: state.events[0]!.id,
    });
    expect(state.events[2]).toMatchObject({
      type: "mafia.shots-resolved",
      parentEventId: state.events[1]!.id,
    });
    expect(state.headEventId).toBe(state.events[2]!.id);
    expect(replayGameLog(state.initialGame, state.events).game).toEqual(gameScreenHarness.liveGame);
  });

  it("preserves a provisional ballot when a meaningful event is accepted", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("heading", { name: "Live test game" });
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

  it("persists a full game snapshot alongside semantic Log and Timeline events", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("heading", { name: "Live test game" });
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalled());
    api.saveGameSession.mockClear();

    await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));

    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalledOnce());
    const operation = api.saveGameSession.mock.calls[0]?.[1];
    expect(operation).toMatchObject({
      kind: "snapshot",
      state: expect.objectContaining({
        game: expect.objectContaining({
          players: expect.arrayContaining([expect.objectContaining({ seat: 1, fouls: 1 })]),
        }),
        events: [
          expect.objectContaining({ type: "game.checkpointed" }),
          expect.objectContaining({
            type: "foul.issued",
            payload: { seat: 1, foulNumber: 1, redCarded: false },
          }),
        ],
      }),
    });
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null"),
    ).toMatchObject({
      current: {
        state: {
          game: expect.objectContaining({
            players: expect.arrayContaining([expect.objectContaining({ seat: 1, fouls: 1 })]),
          }),
          initialGame: expect.objectContaining({
            replayVersion: 1,
            game: expect.objectContaining({ currentTurnIndex: 0, day: 1 }),
          }),
          events: [
            expect.objectContaining({ type: "game.checkpointed" }),
            expect.objectContaining({
              type: "foul.issued",
              payload: expect.objectContaining({ seat: 1, foulNumber: 1 }),
            }),
          ],
        },
      },
    });
  });

  it("previews a Log state without mutation and destructively resets the browser snapshot", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("button", { name: "Record meaningful checkpoint" });
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
      "Reset the active game to log #1? 1 later action will be permanently deleted.",
    );

    expect(screen.getByRole("button", { name: /undo last action/i })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Open game log" }));
    expect(screen.queryByText("Foul issued")).toBeNull();
  });

  it("applies a reset locally while its server operation remains queued", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("button", { name: "Record meaningful checkpoint" });
    await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Saved to server · tap to check connection" }),
      ).toBeInTheDocument(),
    );
    const before = JSON.parse(
      window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null",
    ) as { current: { state: { headEventId: string } } };
    api.saveGameSessionOperation.mockRejectedValue(new Error("offline"));

    await user.click(screen.getByRole("button", { name: "Open game log" }));
    await user.click(screen.getByRole("button", { name: "Preview state after log #1" }));
    await user.click(screen.getByRole("button", { name: "Reset game to this state" }));

    expect(screen.getByText("Game fouls 0")).toBeInTheDocument();
    const persisted = JSON.parse(
      window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null",
    );
    expect(persisted.current.state.headEventId).not.toBe(before.current.state.headEventId);
    expect(persisted.outbox).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "snapshot",
          state: expect.objectContaining({
            game: expect.objectContaining({
              players: expect.arrayContaining([expect.objectContaining({ seat: 1, fouls: 0 })]),
            }),
            events: [expect.objectContaining({ type: "game.checkpointed" })],
          }),
        }),
      ]),
    );
    expect(screen.getByRole("button", { name: /^Save failed · retry 1 of 3/ })).toHaveAttribute(
      "data-status",
      "retrying",
    );
  });

  it("keeps the destructive browser reset when a duplicate response contains older server state", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("button", { name: "Record meaningful checkpoint" });
    await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Saved to server · tap to check connection" }),
      ).toBeInTheDocument(),
    );
    const persisted = JSON.parse(
      window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null",
    ) as {
      gameId: string;
      current: {
        name: string;
        state: {
          setup: unknown | null;
          hostPlayerId: string | null;
          hostName: string | null;
          playlistId: string;
          legacyLog: readonly unknown[];
          undoBudget: number;
          initialGame: InitialGameBaseline;
          events: readonly GameLogEntry[];
          headEventId: string;
          resetReturnEventId: string | null;
          game: GameState | null;
          log: readonly unknown[];
          undoHistory: readonly unknown[];
        };
      };
    };
    const authoritativeState = persisted.current.state;
    const authoritativeHead = authoritativeState.events.at(-1)!;
    const authoritativeGame = replayGameLog(
      authoritativeState.initialGame,
      authoritativeState.events,
    ).game;
    api.saveGameSession
      .mockResolvedValueOnce({
        gameId: persisted.gameId,
        name: persisted.current.name,
        revision: 8,
        duplicate: true,
        state: {
          ...authoritativeState,
          game: authoritativeGame,
          headEventId: authoritativeHead.id,
        },
        results: null,
      })
      .mockImplementation((_gameId: string, operation: { baseRevision: number }) =>
        Promise.resolve({ revision: operation.baseRevision + 1, duplicate: false }),
      );

    await user.click(screen.getByRole("button", { name: "Open game log" }));
    await user.click(screen.getByRole("button", { name: "Preview state after log #1" }));
    await user.click(screen.getByRole("button", { name: "Reset game to this state" }));

    await waitFor(() => expect(screen.getByText("Game fouls 0")).toBeInTheDocument());
    expect(api.saveGameSession).toHaveBeenCalledWith(
      persisted.gameId,
      expect.objectContaining({
        kind: "snapshot",
        state: expect.objectContaining({
          events: [expect.objectContaining({ type: "game.checkpointed" })],
        }),
      }),
      testClub.id,
    );
  });

  it("ignores a delayed component-local mutation captured during preview after exit", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("heading", { name: "Live test game" });
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
    await screen.findByRole("button", { name: "Record meaningful checkpoint" });
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
    await screen.findByRole("heading", { name: "Live test game" });
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalled());
    api.saveGameSession.mockClear();

    await user.click(screen.getByRole("button", { name: "Finish test game" }));
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalled());
    expect(api.saveGameSession.mock.calls.at(-1)?.[1]).toMatchObject({
      kind: "snapshot",
      state: expect.objectContaining({
        game: expect.objectContaining({ phase: "finished" }),
        events: expect.arrayContaining([
          expect.objectContaining({ phaseAfter: "finished", type: "player.red-carded" }),
        ]),
      }),
    });

    await user.click(screen.getByRole("button", { name: "Finish the game" }));
    await waitFor(() =>
      expect(api.saveGameSession.mock.calls.at(-1)?.[1]).toMatchObject({
        kind: "snapshot",
        results: expect.objectContaining({ hostPlayerId, winner: "red" }),
        state: expect.objectContaining({
          events: expect.arrayContaining([expect.objectContaining({ type: "game.completed" })]),
        }),
      }),
    );
    expect(screen.getByRole("button", { name: /undo last action/i })).toBeDisabled();
    expect(await screen.findByRole("button", { name: "Start test game" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Game safely saved" })).not.toBeInTheDocument();
  });

  it.each([
    ["game.drawn", "draw", "Three quiet cycles"],
    ["game.cancelled", "cancelled", "Venue closed"],
  ] as const)(
    "persists a reasoned %s event as a terminal result",
    async (type, outcome, reason) => {
      const user = userEvent.setup();
      render(<App />);
      await user.click(screen.getByRole("button", { name: "Start test game" }));
      await waitFor(() => expect(api.saveGameSession).toHaveBeenCalled());
      api.saveGameSession.mockClear();

      act(() => gameScreenHarness.liveOnAcceptedEvent?.({ type, payload: { reason } }));

      await waitFor(() =>
        expect(api.saveGameSession.mock.calls.at(-1)?.[1]).toMatchObject({
          kind: "snapshot",
          results: { outcome, winner: null, reason },
          state: expect.objectContaining({
            game: expect.objectContaining({ phase: outcome }),
            events: expect.arrayContaining([
              expect.objectContaining({ type, payload: { reason } }),
            ]),
          }),
        }),
      );
    },
  );

  it("keeps a rejected completion local and uploads exactly once after Save is pressed", async () => {
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
    expect(screen.getByRole("button", { name: "Game upload blocked" })).toBeDisabled();
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null").outbox,
    ).toEqual([
      expect.objectContaining({
        kind: "snapshot",
        results: expect.objectContaining({ hostPlayerId, winner: "red" }),
      }),
    ]);

    api.saveGameSession.mockImplementation((_gameId: string, operation: { baseRevision: number }) =>
      Promise.resolve({ revision: operation.baseRevision + 1, duplicate: false }),
    );
    await user.click(screen.getByRole("button", { name: /^Save blocked ·/ }));

    expect(await screen.findByRole("button", { name: "Start test game" })).toBeInTheDocument();
    expect(
      api.saveGameSession.mock.calls.filter(
        ([, operation]) => operation.kind === "snapshot" && operation.results !== null,
      ),
    ).toHaveLength(1);
    expect(window.localStorage.getItem("mafia-dashboard.game-session.v5")).toBeNull();
  });

  it("keeps Local only when the newer queued aggregate mutation fails", async () => {
    const user = userEvent.setup();
    const first = deferred<{ revision: number; duplicate: boolean }>();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("heading", { name: "Live test game" });
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalled());
    api.saveGameSession
      .mockImplementationOnce(() => first.promise)
      .mockRejectedValue(new ApiError("save rejected", 400, "invalid"));
    await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalledTimes(3));
    await user.click(screen.getByRole("button", { name: "Record game action" }));
    expect(screen.getByRole("button", { name: /^Saving ·/ })).toHaveAttribute(
      "data-status",
      "saving",
    );

    first.resolve({ revision: 2, duplicate: false });

    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalledTimes(4));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Save blocked ·/ })).toHaveAttribute(
        "data-status",
        "offline",
      ),
    );
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null"),
    ).toMatchObject({
      failed: true,
      outbox: expect.arrayContaining([
        expect.objectContaining({
          state: expect.objectContaining({
            game: expect.objectContaining({ currentTurnIndex: 1 }),
          }),
        }),
      ]),
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
    expect(api.saveGameSession).not.toHaveBeenCalled();
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null"),
    ).toMatchObject({
      gameId: sessionBId,
      revision: 7,
      current: { state: { game: expect.objectContaining({ day: 3 }) } },
      outbox: [],
    });
  });

  it("ignores a resume response after newer local role setup is saved", async () => {
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
    await user.click(screen.getByRole("button", { name: "Enter role giveaway" }));
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

    expect(screen.getByRole("heading", { name: "Role giveaway" })).toBeInTheDocument();
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null"),
    ).toMatchObject({ gameId: localGameId, revision: 1, outbox: [] });
  });

  it("restores the latest meaningful checkpoint from the durable browser aggregate", async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("button", { name: "Record meaningful checkpoint" });
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
    await user.click(screen.getByRole("button", { name: "Enter role giveaway" }));
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Music player setup" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "YouTube Music playlist" }),
      "dev-playlist",
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Saved to server · tap to check connection" }),
      ).toBeInTheDocument(),
    );

    firstRender.unmount();
    render(<App />);

    expect(screen.getByRole("heading", { name: "Role giveaway" })).toBeInTheDocument();
    expect(await screen.findByTestId("youtube-player")).toHaveAttribute(
      "data-playlist-id",
      "dev-playlist",
    );
  });

  it("does not open availability or clear the game when New game is cancelled", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Enter role giveaway" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Saved to server · tap to check connection" }),
      ).toBeInTheDocument(),
    );
    const savedSession = window.localStorage.getItem("mafia-dashboard.game-session.v5");
    expect(savedSession).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Start new game" }));

    expect(confirm).toHaveBeenCalledOnce();
    expect(api.clearGameSession).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Role giveaway" })).toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "Search available players" })).toBeNull();
    expect(window.localStorage.getItem("mafia-dashboard.game-session.v5")).toBe(savedSession);
  });

  it("parks an unresolved POST without inventing a GUID or deleting another game", async () => {
    const user = userEvent.setup();
    const firstCreate = deferred<{ revision: number; duplicate: boolean }>();
    api.saveGameSession.mockImplementationOnce(() => firstCreate.promise);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Enter role giveaway" }));
    await waitFor(() => expect(api.createGameSession).toHaveBeenCalledOnce());
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null"),
    ).toMatchObject({ gameId: null, creationId: expect.any(String) });

    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Start new game" }));
    expect(confirm).toHaveBeenCalledWith(
      "Start a new game? The current game will stay saved and can be resumed later.",
    );
    expect(api.clearGameSession).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("mafia-dashboard.game-session.v5")).toBeNull();
    expect(
      [...Array(window.localStorage.length).keys()]
        .map((index) => window.localStorage.key(index))
        .some((key) => key?.includes(".parked.")),
    ).toBe(true);
    firstCreate.resolve({ revision: 1, duplicate: false });
    await act(async () => {
      await firstCreate.promise;
      await Promise.resolve();
    });
    expect(window.localStorage.getItem("mafia-dashboard.game-session.v5")).toBeNull();
  });

  it("does not reset a newer resumed game after an older DELETE completes", async () => {
    const user = userEvent.setup();
    const oldId = "00000000-0000-4000-8000-000000000081";
    const newId = "00000000-0000-4000-8000-000000000082";
    const clear = deferred<void>();
    seedBrowserGame(testClub, oldId, "Old table");
    api.clearGameSession.mockReturnValue(clear.promise);
    api.getGameSession.mockResolvedValue(remoteSession(newId, "New table", "New host", 5, 2));
    api.listActiveGameSessions.mockResolvedValue([
      {
        gameId: oldId,
        name: "Old table",
        revision: 1,
        hostName: "Host",
        phase: "day",
        day: 1,
        updatedAt: "2026-08-18T09:00:00.000Z",
      },
      {
        gameId: newId,
        name: "New table",
        revision: 5,
        hostName: "New host",
        phase: "day",
        day: 2,
        updatedAt: "2026-08-18T09:00:00.000Z",
      },
    ]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(await screen.findByRole("button", { name: "Delete Old table" }));
    await waitFor(() => expect(api.clearGameSession).toHaveBeenCalledWith(oldId, testClub.id));
    await user.click(screen.getByRole("button", { name: "Resume New table" }));
    await screen.findByText("Host: New host");
    clear.resolve();
    await act(async () => {
      await clear.promise;
      await Promise.resolve();
    });
    expect(screen.getByText("Host: New host")).toBeInTheDocument();
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null"),
    ).toMatchObject({ gameId: newId, current: { state: { playlistId: "PL-New table" } } });
  });

  it("preserves local setup and outbox when explicit remote DELETE fails", async () => {
    const user = userEvent.setup();
    const id = "00000000-0000-4000-8000-000000000090";
    api.clearGameSession.mockRejectedValueOnce(new Error("offline"));
    api.listActiveGameSessions.mockResolvedValue([
      {
        gameId: id,
        name: "Test table",
        revision: 1,
        hostName: "Host",
        phase: "setup",
        day: 0,
        updatedAt: "2026-08-18T09:00:00.000Z",
      },
    ]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Enter role giveaway" }));
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null"),
      ).toMatchObject({ gameId: id }),
    );
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(await screen.findByRole("button", { name: "Delete Test table" }));

    await waitFor(() => expect(api.clearGameSession).toHaveBeenCalledWith(id, testClub.id));
    expect(screen.getByRole("heading", { name: "Role giveaway" })).toBeInTheDocument();
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null"),
    ).toMatchObject({
      gameId: id,
      current: { state: { setup: { step: "roles" } } },
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
  rulesetId: "club-mafia",
  rulesetVersion: 1,
  updatedAt: "2026-08-18T09:00:00.000Z",
  state: {
    setup: null,
    game: { ...assignedGame, day },
    hostPlayerId,
    hostName: restoredHostName,
    playlistId: `PL-${name}`,
    log: [],
    undoHistory: [],
    undoBudget: 0,
    initialGame: null,
    events: [],
    headEventId: null,
    resetReturnEventId: null,
    legacyLog: [],
  },
  results: null,
});

describe("undo checkpoints", () => {
  const acceptLiveEvent = (draft: CanonicalGameEventDraft) => {
    const accept = gameScreenHarness.liveOnAcceptedEvent;
    if (accept === null) throw new Error("Live accepted-event callback was not captured");
    act(() => accept(draft));
  };

  it("does not let cursor Undo cross the immutable game baseline", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("heading", { name: "Live test game" });
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

  it("reconstructs the third-foul penalty before and after it is consumed", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("heading", { name: "Live test game" });
    const targetSeat = 2;

    for (let foulNumber = 1; foulNumber <= 3; foulNumber += 1) {
      acceptLiveEvent({
        type: "foul.issued",
        payload: { seat: targetSeat, foulNumber, redCarded: false },
      });
      await waitFor(() =>
        expect(
          gameScreenHarness.liveGame?.players.find(({ seat }) => seat === targetSeat)?.fouls,
        ).toBe(foulNumber),
      );
    }
    expect(
      gameScreenHarness.liveGame?.players.find(({ seat }) => seat === targetSeat)?.mutePending,
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: /undo last action/i }));
    expect(
      gameScreenHarness.liveGame?.players.find(({ seat }) => seat === targetSeat),
    ).toMatchObject({ fouls: 2, mutePending: false, status: "active" });

    acceptLiveEvent({
      type: "foul.issued",
      payload: { seat: targetSeat, foulNumber: 3, redCarded: false },
    });
    api.saveGameSession.mockClear();
    await user.click(screen.getByRole("button", { name: "Record game action" }));
    await user.click(screen.getByRole("button", { name: "Record game action" }));
    expect(
      gameScreenHarness.liveGame?.players.find(({ seat }) => seat === targetSeat),
    ).toMatchObject({ fouls: 3, mutePending: false, status: "active" });
    await waitFor(() =>
      expect(api.saveGameSession.mock.calls.at(-1)?.[1]).toMatchObject({
        kind: "snapshot",
        state: expect.objectContaining({
          game: expect.objectContaining({ currentTurnIndex: 2 }),
          events: [
            expect.objectContaining({ type: "game.checkpointed" }),
            expect.objectContaining({ type: "foul.issued" }),
            expect.objectContaining({ type: "foul.issued" }),
            expect.objectContaining({ type: "foul.issued" }),
          ],
        }),
      }),
    );

    api.saveGameSession.mockClear();
    await user.click(screen.getByRole("button", { name: /undo last action/i }));
    expect(gameScreenHarness.liveGame).toMatchObject({ phase: "day", currentTurnIndex: 0 });
    expect(
      gameScreenHarness.liveGame?.players.find(({ seat }) => seat === targetSeat),
    ).toMatchObject({ fouls: 2, mutePending: false, status: "active" });
    expect(screen.getByRole("button", { name: /undo last action.*2 available/i })).toBeEnabled();
    await waitFor(() =>
      expect(api.saveGameSession.mock.calls.at(-1)?.[1]).toMatchObject({
        kind: "snapshot",
        state: expect.objectContaining({
          game: expect.objectContaining({ currentTurnIndex: 0 }),
          events: [
            expect.objectContaining({ type: "game.checkpointed" }),
            expect.objectContaining({ type: "foul.issued" }),
            expect.objectContaining({ type: "foul.issued" }),
          ],
        }),
      }),
    );
  });

  it("restores eligibility and victory when the winning red card is undone", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("heading", { name: "Live test game" });
    const blackSeats = gameScreenHarness.liveGame?.players
      .filter(({ team }) => team === "black")
      .map(({ seat }) => seat);
    if (blackSeats === undefined || blackSeats.length === 0) {
      throw new Error("Test game has no Mafia players");
    }

    for (const seat of blackSeats) {
      acceptLiveEvent({ type: "player.red-carded", payload: { seat } });
      await waitFor(() =>
        expect(
          gameScreenHarness.liveGame?.players.find((player) => player.seat === seat)?.status,
        ).toBe("red-carded"),
      );
    }
    expect(gameScreenHarness.liveGame).toMatchObject({ phase: "finished", winner: "red" });

    api.saveGameSession.mockClear();
    await user.click(screen.getByRole("button", { name: /undo last action/i }));

    const restoredSeat = blackSeats.at(-1)!;
    expect(gameScreenHarness.liveGame).toMatchObject({ phase: "day", winner: null });
    expect(
      gameScreenHarness.liveGame?.players.find(({ seat }) => seat === restoredSeat)?.status,
    ).toBe("active");
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalled());
    expect(api.saveGameSession.mock.calls.at(-1)?.[1]).toMatchObject({
      kind: "snapshot",
      state: expect.objectContaining({
        events: [
          expect.objectContaining({ type: "game.checkpointed" }),
          ...blackSeats
            .slice(0, -1)
            .map(() => expect.objectContaining({ type: "player.red-carded" })),
        ],
      }),
    });
  });

  it("preserves the remaining ordinary undo budget across reload", async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("heading", { name: "Live test game" });
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

  it("persists a destructive Reset across reload without a Reset Return action", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const firstRender = render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("heading", { name: "Live test game" });
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
    expect(screen.getByText("Game fouls 0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /undo last action.*0 available/i })).toBeDisabled();
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null"),
    ).toMatchObject({
      current: {
        state: {
          resetReturnEventId: null,
          undoBudget: 0,
          events: [expect.objectContaining({ type: "game.checkpointed" })],
        },
      },
    });
  });

  it("retains only three ordinary actions and undo removes matching log state", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("heading", { name: "Live test game" });
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
    await screen.findByRole("heading", { name: "Live test game" });
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

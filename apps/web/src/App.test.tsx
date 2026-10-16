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
import {
  forwardRef,
  StrictMode,
  useEffect,
  useImperativeHandle,
  useState,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceSetupPhase,
  applyGameEvent,
  assignRoleForSeat,
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createGameLogEntry,
  createInitialGameBaseline,
  createSeededRandom,
  createSetup,
  FEDERATION_RULES_EDITION,
  beginNight,
  completeMafiaShots,
  completeNight,
  skipDonCheck,
  skipSheriffCheck,
  startVoting,
  replayGameLog,
  selectVotingCandidate,
  toggleVote,
  resolveMafiaShots,
  toggleAllMafiaShotsForTarget,
  type CanonicalGameEventDraft,
  type GameState,
  type InitialGameBaseline,
  type GameLogEntry,
  type PlayerStatisticsRow,
  type StatisticsHistoryGame,
} from "@mafia/game-domain";
import { ApiError, type Club, type PlayerProfile, type RemoteGameSession } from "./api/client.js";
import { App as WelcomeApp, ClubWorkspace } from "./App.js";
import { DEFAULT_FANCY_STUFF_SETTINGS } from "./features/effects/fancy-stuff-preferences.js";

import { gameSessionStorageKey, GameSessionOutbox } from "./session-outbox.js";
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
import { playerLabel } from "./test-player-directory.js";

const api = vi.hoisted(() => {
  const saveGameSession = vi.fn();
  return {
    checkServerReady: vi.fn(),
    clearAllData: vi.fn(),
    clearGameSession: vi.fn(),
    createPlayer: vi.fn(),
    deletePlayer: vi.fn(),
    getGameSession: vi.fn(),
    getAppVersion: vi.fn(),
    listActiveGameSessions: vi.fn(),
    listCompletedGameSessions: vi.fn(),
    listTournaments: vi.fn(),
    createTournament: vi.fn(),
    assignGameTournament: vi.fn(),
    getClubStatistics: vi.fn(),
    getPlayerStatistics: vi.fn(),
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
  liveOnFinishGame: null as (() => void) | null,
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
    fancyStuff={DEFAULT_FANCY_STUFF_SETTINGS}
    onFancyStuffChange={() => undefined}
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
const assignedGame: GameState = (() => {
  const players = Array.from({ length: 10 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    seat: index + 1,
  }));
  let setup = beginRoleDraw(createSetup(players), createSeededRandom(13));
  for (const player of players) {
    const role =
      player.seat === 1
        ? "sheriff"
        : player.seat === 10
          ? "don"
          : player.seat >= 8
            ? "mafia"
            : "citizen";
    setup = assignRoleForSeat(setup, player.seat, role);
  }
  return advanceSetupPhase(advanceSetupPhase(createGame(completeRoleDraw(setup))));
})();

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

const federationGame = () => {
  let setup = beginRoleDraw(
    createSetup(
      assignedGame.players.map(({ id, seat }) => ({ id, seat })),
      {
        rulesEdition: FEDERATION_RULES_EDITION,
      },
    ),
    createSeededRandom(13),
  );
  for (const player of assignedGame.players)
    setup = assignRoleForSeat(setup, player.seat, player.role);
  return createGame(completeRoleDraw(setup));
};

const restoreFederationCheckpoint = (game: GameState) => {
  const gameId = "00000000-0000-4000-8000-000000000399";
  const root = createGameLogEntry({
    gameId,
    id: crypto.randomUUID(),
    sequence: 1,
    parentEventId: null,
    createdAt: "2026-10-14T12:00:00.000Z",
    before: game,
    draft: { type: "game.checkpointed", payload: {} },
  });
  new GameSessionOutbox({
    storage: window.localStorage,
    clubId: testClub.id,
    createId: () => crypto.randomUUID(),
    save: vi.fn(),
  }).activateRemote({
    ...remoteSession(gameId, "Federation progression", "Host", 1, 1),
    state: {
      ...browserSessionState(""),
      game: root.after,
      hostPlayerId,
      initialGame: createInitialGameBaseline(game),
      events: [root.entry],
      headEventId: root.entry.id,
    },
  });
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
    tournamentControl,
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
    tournamentControl?: ReactNode;
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
        players: assignedGame.players.map(({ id, seat }) => ({ id, seat })),
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
        {tournamentControl}
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
              players: [{ id: assignedGame.players[0]!.id, seat: 1 }],
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

vi.mock("./features/game/GameScreen.js", async () => {
  const { RulesBookHost } = await import("./features/rules/RulesBookHost.js");
  return {
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
      canResetPreview,
      privacyHidden,
      onFinishGame,
      finishGameState,
      rulesOpen,
      onRulesClose,
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
      canResetPreview?: boolean;
      privacyHidden: boolean;
      onFinishGame: () => void;
      finishGameState: "ready" | "saving" | "saved" | "queued" | "blocked";
      rulesOpen?: boolean;
      onRulesClose?: () => void;
    }) => {
      if (mode === "preview") {
        gameScreenHarness.previewGame = game;
        gameScreenHarness.previewOnGameChange = onGameChange;
      } else {
        gameScreenHarness.liveGame = game;
        gameScreenHarness.liveOnGameChange = onGameChange;
        gameScreenHarness.liveOnAcceptedEvent = onAcceptedEvent ?? null;
        gameScreenHarness.liveOnFinishGame = onFinishGame;
      }
      return mode === "preview" ? (
        <main>
          <h1>Preview game state</h1>
          <p>Preview log {previewSequence}</p>
          <button type="button" onClick={onExitPreview}>
            Exit preview
          </button>
          <button type="button" disabled={!canResetPreview} onClick={onResetPreview}>
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
          <RulesBookHost open={rulesOpen ?? false} onClose={onRulesClose ?? (() => undefined)} />

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
          {game.phase === "finished" || game.phase === "draw" || game.phase === "cancelled" ? (
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
  };
});

vi.mock("./features/music/YouTubePlaylistPlayer.js", () => ({
  YouTubePlaylistPlayer: forwardRef(
    (
      {
        playlistId,
        rememberedQueueOrder = [],
        playlistPicker,
        expanded,
        onQueueOrderChange,
        onStateChange,
        initialStageEntryKeys = [],
        onInitialStageEntryKeysChange,
        endgameEntryKeys = [],
        onEndgameEntryKeysChange,
      }: {
        playlistId: string;
        rememberedQueueOrder?: readonly string[];
        playlistPicker?: ReactNode;
        expanded?: boolean;
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
          {expanded ? (
            <section aria-label="Session playlist queue">
              <h2>Session queue</h2>
              {playlistPicker}
            </section>
          ) : null}
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
    view,
    playlistId,
    onPlaylistIdChange,
    onAccountDisconnected,
    onStatusChange,
    onRetry,
    status = { configured: true, connected: true, accountLabel: "Mafia Host" },
    statusError = false,
  }: {
    view: "account" | "playlist";
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
    if (view === "playlist" && (statusError || !status?.configured || !status.connected))
      return null;
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
        {view === "playlist" ? (
          <select
            aria-label="YouTube Music playlist"
            value={playlistId}
            onChange={(event) => onPlaylistIdChange(event.target.value)}
          >
            <option value="">No playlist</option>
            <option value="dev-playlist">Dev playlist</option>
          </select>
        ) : (
          <button
            type="button"
            onClick={() => {
              onAccountDisconnected();
              onStatusChange?.({ configured: true, connected: false, accountLabel: null });
            }}
          >
            Disconnect account
          </button>
        )}
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
  api.getAppVersion.mockReset().mockResolvedValue("1.0.0");
  api.listActiveGameSessions.mockReset().mockResolvedValue([]);
  api.listCompletedGameSessions.mockReset().mockResolvedValue([]);
  api.listTournaments.mockReset().mockResolvedValue([]);
  api.createTournament.mockReset();
  api.assignGameTournament.mockReset().mockImplementation(async (_gameId, value) => value);
  api.getClubStatistics.mockReset();
  api.getPlayerStatistics.mockReset();
  api.listPlayers
    .mockReset()
    .mockResolvedValue([
      ...assignedGame.players.map((seat) => player(playerLabel(seat), seat.id)),
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

describe("statistics navigation and separate tournament setup", () => {
  it("gates the real wizard after first tournament selection until creation and latest metadata are acknowledged", async () => {
    const { SetupWizard: RealSetupWizard } = await vi.importActual<typeof setupWizardModule>(
      "./features/setup/SetupWizard.js",
    );
    vi.spyOn(setupWizardModule, "SetupWizard").mockImplementation(RealSetupWizard);
    window.localStorage.setItem(
      `mafia-dashboard.available-player-ids.${testClub.id}`,
      JSON.stringify([...assignedGame.players.map(({ id }) => id), hostPlayerId]),
    );
    api.listTournaments.mockResolvedValue(tournaments);
    const creation = deferred<RemoteGameSession>();
    const assignment = deferred<string | null>();
    api.createGameSession.mockReturnValue(creation.promise);
    api.assignGameTournament.mockReturnValue(assignment.promise);
    render(<App />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Include in tournament" }));
    await screen.findByRole("option", { name: "Autumn cup" });
    expect(api.createGameSession).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "Tournament" }), {
      target: { value: first },
    });
    await waitFor(() => expect(api.createGameSession).toHaveBeenCalledTimes(1));
    const input = api.createGameSession.mock.calls[0]![0];
    expect(input.state.setup.rulesEdition).toBe(FEDERATION_RULES_EDITION);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Host player" }));
    await user.type(screen.getByRole("combobox", { name: "Host player" }), "Host");
    await user.click(screen.getByRole("option", { name: "Host Player" }));
    fireEvent.click(screen.getByRole("button", { name: "Assign players" }));
    expect(screen.getByRole("button", { name: "Start game" })).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Tournament" }), {
      target: { value: second },
    });
    await act(async () =>
      creation.resolve({
        ...remoteSession(serverId, input.name, "Host", 1, 1),
        state: input.state,
        tournamentId: first,
      }),
    );
    await waitFor(() =>
      expect(api.assignGameTournament).toHaveBeenCalledWith(serverId, second, testClub.id),
    );
    expect(screen.getByRole("button", { name: "Start game" })).toBeDisabled();
    await act(async () => assignment.resolve(second));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start game" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Start game" }));
    expect(await screen.findByRole("heading", { name: "Role giveaway" })).toBeInTheDocument();
    const envelope = JSON.parse(window.localStorage.getItem(gameSessionStorageKey)!);
    expect(envelope.tournamentAssociation.confirmedTournamentId).toBe(second);
    expect(envelope.current.state.setup.selectedPlayerIds.filter(Boolean)).toHaveLength(10);
    expect(JSON.stringify(envelope.current.state)).not.toContain("tournamentId");
  });
  const first = "00000000-0000-4000-8000-000000000701";
  const second = "00000000-0000-4000-8000-000000000702";
  const serverId = "00000000-0000-4000-8000-000000000090";
  const tournaments = [
    { id: first, name: "Autumn cup" },
    { id: second, name: "Winter cup" },
  ];
  it("recovers a lost creation acknowledgment through the real browser storage startup boundary", async () => {
    const creationId = "00000000-0000-4000-8000-000000000800";
    const outbox = new GameSessionOutbox({
      storage: window.localStorage,
      clubId: testClub.id,
      createId: () => creationId,
      save: vi.fn(),
      create: vi.fn().mockRejectedValue(new Error("lost POST response")),
    });
    outbox.beginCreation(
      "Lost acknowledgment",
      {
        ...browserSessionState(""),
        setup: {
          step: "players",
          hostPlayerId: "",
          selectedPlayerIds: Array.from({ length: 10 }, () => ""),
          setup: null,
          rulesEdition: FEDERATION_RULES_EDITION,
        },
      },
      null,
      first,
    );
    await expect(outbox.flush()).rejects.toThrow("lost POST response");
    api.getAuthSession.mockResolvedValue(authenticatedUser);
    api.listClubs.mockResolvedValue([testClub]);
    api.listTournaments.mockResolvedValue(tournaments);
    api.createGameSession.mockImplementation(async (input) => ({
      ...remoteSession(serverId, input.name, "Host", 1, 1),
      state: input.state,
      tournamentId: first,
    }));
    render(<WelcomeApp />);
    await waitFor(() =>
      expect(api.createGameSession).toHaveBeenCalledWith(
        expect.objectContaining({ creationId, tournamentId: first }),
        testClub.id,
      ),
    );
    expect(screen.queryByRole("heading", { name: "Browser game data needs attention" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Include in tournament" })).toBeChecked();
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem(gameSessionStorageKey)!).gameId).toBe(serverId),
    );
  });
  const totals = { games: 1, wins: 1, draws: 0, losses: 0, winRate: 100 };
  const statisticsPlayer: PlayerStatisticsRow = {
    playerId: assignedGame.players[0]!.id,
    nickname: "Player One",
    totals,
    teams: { red: totals, black: totals },
    roles: { citizen: totals, sheriff: totals, mafia: totals, don: totals },
    fouls: 0,
    foulsPerGame: 0,
    redCards: 0,
    eliminations: 0,
    bestMoveResults: 0,
    bestMoveHits: 0,
    bestMoveMean: null,
    hostedGames: 0,
    lastHostedAt: null,
    lastPlayedAt: "2026-10-14T12:00:00Z",
    recentForm: ["win"],
    rating: {
      algorithm: "club-team-elo-v1",
      value: null,
      ratedGames: 0,
      status: "unranked",
      rank: null,
      lastChange: null,
    },
    scopedRatingChange: null,
    scopedRatedGames: 0,
  };
  const historyGame = (gameId: string): StatisticsHistoryGame => ({
    gameId,
    name: "Inspected table",
    playedAt: "2026-10-14T12:00:00Z",
    rulesEdition: FEDERATION_RULES_EDITION,
    hasCasper: false,
    outcome: "red",
    reason: null,
    tournamentId: null,
    hostPlayerId,
    isHost: false,
    statisticsAvailable: true,
    participant: {
      playerId: statisticsPlayer.playerId,
      seat: 1,
      role: "sheriff",
      team: "red",
      status: "active",
      fouls: 0,
      bestMoveHits: null,
    },
    unratedReason: "incomplete-results",
    ratingChange: null,
  });

  it("returns from manager history with statistics scope, player, search and focus intact", async () => {
    api.listTournaments.mockResolvedValue(tournaments);
    const live = federationGame();
    restoreFederationCheckpoint(live);
    const historicalId = "00000000-0000-4000-8000-000000000808";
    const root = createGameLogEntry({
      gameId: historicalId,
      id: crypto.randomUUID(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-10-14T12:00:00Z",
      before: live,
      draft: { type: "game.checkpointed", payload: {} },
    });
    api.getGameSession.mockResolvedValue({
      ...remoteSession(historicalId, "Inspected table", "Host", 1, 1),
      status: "completed",
      state: {
        ...browserSessionState(""),
        game: root.after,
        initialGame: createInitialGameBaseline(live),
        events: [root.entry],
        headEventId: root.entry.id,
      },
    });
    api.getClubStatistics.mockResolvedValue({
      players: [statisticsPlayer],
      tournaments,
      coverage: { completedGames: 1, unavailableGames: 0, pendingGames: 1 },
      algorithm: "club-team-elo-v1",
    });
    api.getPlayerStatistics.mockResolvedValue({
      player: statisticsPlayer,
      history: [historyGame(historicalId)],
      total: 1,
      nextCursor: null,
    });
    render(<App />);
    await screen.findByRole("button", { name: "Saved to server · tap to check connection" });
    const original = JSON.parse(window.localStorage.getItem(gameSessionStorageKey)!).current;
    fireEvent.click(screen.getByRole("button", { name: "Open Manage menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Statistics" }));
    await screen.findByRole("option", { name: "Autumn cup" });
    fireEvent.change(screen.getByRole("combobox", { name: "Tournament scope" }), {
      target: { value: first },
    });
    fireEvent.change(await screen.findByRole("searchbox", { name: "Search nickname" }), {
      target: { value: "One" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Player One" }));
    const timelineOpener = await screen.findByRole("button", { name: "Open timeline" });
    timelineOpener.focus();
    fireEvent.click(timelineOpener);
    await waitFor(() => expect(api.getGameSession).toHaveBeenCalledWith(historicalId, testClub.id));
    await screen.findByRole("button", { name: "Back to statistics" });
    expect(screen.getByRole("combobox", { name: "Completed game" })).toHaveValue(historicalId);
    expect(JSON.parse(window.localStorage.getItem(gameSessionStorageKey)!).current).toEqual(
      original,
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to statistics" }));
    expect(await screen.findByRole("heading", { name: "Club statistics" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Tournament scope" })).toHaveValue(first);
    expect(screen.getByRole("searchbox", { name: "Search nickname" })).toHaveValue("One");
    expect(screen.getByRole("region", { name: "Player details: Player One" })).toBeVisible();
    expect(timelineOpener).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Back to game" }));
    expect(gameScreenHarness.liveGame).toEqual(live);
  });

  it("reconciles a statistics correction for the current record without changing gameplay or uploading a snapshot", async () => {
    const live = federationGame();
    restoreFederationCheckpoint(live);
    const original = JSON.parse(window.localStorage.getItem(gameSessionStorageKey)!);
    const gameId = original.gameId;
    api.listTournaments.mockResolvedValue(tournaments);
    api.getClubStatistics.mockResolvedValue({
      players: [statisticsPlayer],
      tournaments,
      coverage: { completedGames: 1, unavailableGames: 0, pendingGames: 0 },
      algorithm: "club-team-elo-v1",
    });
    api.getPlayerStatistics.mockResolvedValue({
      player: statisticsPlayer,
      history: [historyGame(gameId)],
      total: 1,
      nextCursor: null,
    });
    render(<App />);
    await screen.findByRole("button", { name: "Saved to server · tap to check connection" });
    const settledCurrent = JSON.parse(window.localStorage.getItem(gameSessionStorageKey)!).current;
    api.saveGameSession.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Open Manage menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Statistics" }));
    fireEvent.click(await screen.findByRole("button", { name: "Player One" }));
    fireEvent.click(await screen.findByRole("button", { name: "Change tournament" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Include in tournament" }));
    await screen.findByRole("option", { name: "Autumn cup" });
    fireEvent.change(screen.getByRole("combobox", { name: "Tournament" }), {
      target: { value: first },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save tournament" }));
    await waitFor(() =>
      expect(api.assignGameTournament).toHaveBeenCalledWith(gameId, first, testClub.id),
    );
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem(gameSessionStorageKey)!).tournamentAssociation
          ?.confirmedTournamentId,
      ).toBe(first),
    );
    expect(JSON.parse(window.localStorage.getItem(gameSessionStorageKey)!).current).toEqual(
      settledCurrent,
    );
    expect(api.saveGameSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back to game" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Manage menu" }));
    expect(screen.getByRole("combobox", { name: "Tournament" })).toHaveValue(first);
  });

  it.each(["cancel", "player", "filter", "refresh", "back"])(
    "durably recovers a historical-only lost response after editor %s and reload",
    async (navigation) => {
      const historicalId = "00000000-0000-4000-8000-000000000080";
      const other = {
        ...statisticsPlayer,
        playerId: "00000000-0000-4000-8000-000000000081",
        nickname: "Player Two",
      };
      api.listTournaments.mockResolvedValue(tournaments);
      api.getClubStatistics.mockResolvedValue({
        players: [statisticsPlayer, other],
        tournaments,
        coverage: { completedGames: 1, unavailableGames: 0, pendingGames: 0 },
        algorithm: "club-team-elo-v1",
      });
      api.getPlayerStatistics.mockImplementation(async (playerId) => ({
        player: playerId === other.playerId ? other : statisticsPlayer,
        history: [historyGame(historicalId)],
        total: 1,
        nextCursor: null,
      }));
      const held = deferred<string | null>();
      api.assignGameTournament.mockReturnValueOnce(held.promise);
      const view = render(<App />);
      fireEvent.click(screen.getByRole("button", { name: "Open Manage menu" }));
      fireEvent.click(screen.getByRole("button", { name: "Statistics" }));
      fireEvent.click(await screen.findByRole("button", { name: "Player One" }));
      fireEvent.click(await screen.findByRole("button", { name: "Change tournament" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Include in tournament" }));
      await screen.findByRole("option", { name: "Autumn cup" });
      fireEvent.change(screen.getByRole("combobox", { name: "Tournament" }), {
        target: { value: first },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save tournament" }));
      await waitFor(() =>
        expect(api.assignGameTournament).toHaveBeenCalledWith(historicalId, first, testClub.id),
      );
      const pending = () => JSON.parse(window.localStorage.getItem(gameSessionStorageKey)!);
      expect(pending().current).toBeNull();
      expect(pending().historicalTournaments).toEqual([
        expect.objectContaining({ gameId: historicalId, tournamentId: first }),
      ]);
      if (navigation === "cancel")
        fireEvent.click(screen.getByRole("button", { name: "Cancel tournament edit" }));
      if (navigation === "player")
        fireEvent.click(screen.getByRole("button", { name: "Player Two" }));
      if (navigation === "filter")
        fireEvent.change(screen.getByRole("combobox", { name: "Team" }), {
          target: { value: "black" },
        });
      if (navigation === "refresh")
        fireEvent.click(screen.getByRole("button", { name: "Refresh statistics" }));
      if (navigation === "back")
        fireEvent.click(screen.getByRole("button", { name: "Back to game" }));
      expect(screen.getByRole("button", { name: /Saving.*1 change pending/ })).toBeInTheDocument();
      view.unmount();
      await act(async () => held.reject(new Error("reply lost after server commit")));
      expect(pending().historicalTournaments).toHaveLength(1);
      render(<App />);
      await waitFor(() => expect(window.localStorage.getItem(gameSessionStorageKey)).toBeNull());
      expect(api.assignGameTournament.mock.calls).toEqual([
        [historicalId, first, testClub.id],
        [historicalId, first, testClub.id],
      ]);
      expect(api.createGameSession).not.toHaveBeenCalled();
      expect(api.saveGameSession).not.toHaveBeenCalled();
      expect(
        await screen.findByRole("button", { name: "Saved to server · tap to check connection" }),
      ).toBeInTheDocument();
    },
  );

  it("serializes a held current choice A with historical correction B even when the editor is cancelled", async () => {
    restoreFederationCheckpoint(federationGame());
    const gameId = JSON.parse(window.localStorage.getItem(gameSessionStorageKey)!).gameId;
    api.listTournaments.mockResolvedValue(tournaments);
    api.getClubStatistics.mockResolvedValue({
      players: [statisticsPlayer],
      tournaments,
      coverage: { completedGames: 1, unavailableGames: 0, pendingGames: 0 },
      algorithm: "club-team-elo-v1",
    });
    api.getPlayerStatistics.mockResolvedValue({
      player: statisticsPlayer,
      history: [historyGame(gameId)],
      total: 1,
      nextCursor: null,
    });
    const held = deferred<string | null>();
    api.assignGameTournament.mockReturnValueOnce(held.promise);
    render(<App />);
    await screen.findByRole("button", { name: "Saved to server · tap to check connection" });
    fireEvent.click(screen.getByRole("button", { name: "Open Manage menu" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Include in tournament" }));
    await screen.findByRole("option", { name: "Autumn cup" });
    fireEvent.change(screen.getByRole("combobox", { name: "Tournament" }), {
      target: { value: first },
    });
    await waitFor(() =>
      expect(api.assignGameTournament).toHaveBeenCalledWith(gameId, first, testClub.id),
    );
    fireEvent.click(screen.getByRole("button", { name: "Statistics" }));
    fireEvent.click(await screen.findByRole("button", { name: "Player One" }));
    fireEvent.click(await screen.findByRole("button", { name: "Change tournament" }));
    expect(screen.getByRole("combobox", { name: "Tournament" })).toHaveValue(first);
    await screen.findByRole("option", { name: "Winter cup" });
    fireEvent.change(screen.getByRole("combobox", { name: "Tournament" }), {
      target: { value: second },
    });
    expect(screen.getByRole("button", { name: "Save tournament" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save tournament" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel tournament edit" }));
    expect(
      JSON.parse(window.localStorage.getItem(gameSessionStorageKey)!).tournamentAssociation.pending
        .tournamentId,
    ).toBe(second);
    await act(async () => held.resolve(first));
    await screen.findByRole("button", { name: "Saved to server · tap to check connection" });
    expect(api.assignGameTournament.mock.calls).toEqual([
      [gameId, first, testClub.id],
      [gameId, second, testClub.id],
    ]);
    expect(
      JSON.parse(window.localStorage.getItem(gameSessionStorageKey)!).tournamentAssociation,
    ).toMatchObject({ confirmedTournamentId: second, pending: null });
    fireEvent.click(screen.getByRole("button", { name: "Back to game" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Manage menu" }));
    expect(screen.getByRole("combobox", { name: "Tournament" })).toHaveValue(second);
  });

  it.each(["new", "resume"])(
    "keeps missing-tournament work recoverable when attempting %s game switching and accepts a correction",
    async (switching) => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      vi.spyOn(window, "alert").mockImplementation(() => undefined);
      restoreFederationCheckpoint(federationGame());
      const gameId = JSON.parse(window.localStorage.getItem(gameSessionStorageKey)!).gameId;
      const replacementId = "00000000-0000-4000-8000-000000000088";
      api.listTournaments.mockResolvedValue(tournaments);
      api.listActiveGameSessions.mockResolvedValue([
        { gameId: replacementId, name: "Other table", hostPlayerId, phase: "day", day: 1 },
      ]);
      api.assignGameTournament.mockImplementation(async (_id, value) => {
        if (value === first) throw new ApiError("Tournament removed", 404, "tournament_not_found");
        return value;
      });
      render(<App />);
      await screen.findByRole("button", { name: "Saved to server · tap to check connection" });
      const original = JSON.parse(window.localStorage.getItem(gameSessionStorageKey)!).current;
      fireEvent.click(screen.getByRole("button", { name: "Open Manage menu" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Include in tournament" }));
      await screen.findByRole("option", { name: "Autumn cup" });
      fireEvent.change(screen.getByRole("combobox", { name: "Tournament" }), {
        target: { value: first },
      });
      await screen.findByRole("button", { name: /Save blocked.*1 change safe/ });
      if (switching === "new") {
        fireEvent.click(screen.getByRole("button", { name: "Start new game" }));
        await waitFor(() =>
          expect(window.alert).toHaveBeenCalledWith(
            expect.stringContaining("switching is blocked"),
          ),
        );
      } else {
        fireEvent.click(await screen.findByRole("button", { name: "Resume Other table" }));
        await waitFor(() =>
          expect(window.alert).toHaveBeenCalledWith(
            expect.stringContaining("switching is blocked"),
          ),
        );
      }
      fireEvent.click(screen.getByRole("button", { name: "Open Manage menu" }));
      await screen.findByRole("option", { name: "Winter cup" });
      const retained = JSON.parse(window.localStorage.getItem(gameSessionStorageKey)!);
      expect(retained.current).toEqual(original);
      expect(retained.gameId).toBe(gameId);
      expect(retained.removed).toBe(false);
      expect(retained.tournamentAssociation.pending.tournamentId).toBe(first);
      expect(window.localStorage.getItem(`${gameSessionStorageKey}.parked.${gameId}`)).toBeNull();
      expect(api.getGameSession).not.toHaveBeenCalledWith(replacementId, testClub.id);
      fireEvent.change(screen.getByRole("combobox", { name: "Tournament" }), {
        target: { value: second },
      });
      await screen.findByRole("button", { name: "Saved to server · tap to check connection" });
      expect(
        JSON.parse(window.localStorage.getItem(gameSessionStorageKey)!).tournamentAssociation,
      ).toMatchObject({ confirmedTournamentId: second, pending: null });
    },
  );

  it("does not park completed gameplay while its held metadata response is uncertain", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(window, "alert").mockImplementation(() => undefined);
    restoreFederationCheckpoint({ ...federationGame(), phase: "finished", winner: "red" });
    const gameId = JSON.parse(window.localStorage.getItem(gameSessionStorageKey)!).gameId;
    api.listTournaments.mockResolvedValue(tournaments);
    const held = deferred<string | null>();
    api.assignGameTournament
      .mockReturnValueOnce(held.promise)
      .mockRejectedValue(new ApiError("Tournament removed", 404, "tournament_not_found"));
    render(<App />);
    await screen.findByRole("button", { name: "Saved to server · tap to check connection" });
    fireEvent.click(screen.getByRole("button", { name: "Open Manage menu" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Include in tournament" }));
    await screen.findByRole("option", { name: "Autumn cup" });
    fireEvent.change(screen.getByRole("combobox", { name: "Tournament" }), {
      target: { value: first },
    });
    await waitFor(() =>
      expect(api.assignGameTournament).toHaveBeenCalledWith(gameId, first, testClub.id),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close Manage menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Finish the game" }));
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem(gameSessionStorageKey)!).current.results,
      ).not.toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Manage menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Start new game" }));
    expect(JSON.parse(window.localStorage.getItem(gameSessionStorageKey)!).gameId).toBe(gameId);
    expect(window.localStorage.getItem(`${gameSessionStorageKey}.parked.${gameId}`)).toBeNull();
    await act(async () =>
      held.reject(new ApiError("Tournament removed", 404, "tournament_not_found")),
    );
    await waitFor(() =>
      expect(window.alert).toHaveBeenCalledWith(expect.stringContaining("switching is blocked")),
    );
    expect(
      JSON.parse(window.localStorage.getItem(gameSessionStorageKey)!).current.results,
    ).not.toBeNull();
    expect(
      JSON.parse(window.localStorage.getItem(gameSessionStorageKey)!).tournamentAssociation.pending
        .tournamentId,
    ).toBe(first);
  });

  it.each(["exit", "edit", "delete"])(
    "retains the owner workspace during %s until held tournament A and correction B settle",
    async (navigation) => {
      vi.spyOn(window, "alert").mockImplementation(() => undefined);
      const historicalId = "00000000-0000-4000-8000-000000000080";
      new GameSessionOutbox({
        storage: window.localStorage,
        clubId: testClub.id,
        createId: () => crypto.randomUUID(),
        save: vi.fn(),
      }).setGameTournament(historicalId, first);
      api.getAuthSession.mockResolvedValue(authenticatedUser);
      api.listClubs.mockResolvedValue([testClub, otherClub]);
      api.listTournaments.mockResolvedValue(tournaments);
      api.getClubStatistics.mockResolvedValue({
        players: [statisticsPlayer],
        tournaments,
        coverage: { completedGames: 1, unavailableGames: 0, pendingGames: 0 },
        algorithm: "club-team-elo-v1",
      });
      let remoteTournament: string | null = null;
      api.getPlayerStatistics.mockImplementation(async () => ({
        player: statisticsPlayer,
        history: [{ ...historyGame(historicalId), tournamentId: remoteTournament }],
        total: 1,
        nextCursor: null,
      }));
      const held = deferred<string | null>();
      api.assignGameTournament
        .mockImplementation(async (_gameId: string, value: string | null) => {
          remoteTournament = value;
          return value;
        })
        .mockImplementationOnce(async () => {
          remoteTournament = await held.promise;
          return remoteTournament;
        });
      render(<WelcomeApp />);
      await waitFor(() => expect(api.assignGameTournament).toHaveBeenCalledTimes(1));
      if (navigation === "exit") {
        fireEvent.click(
          screen.getByRole("button", { name: "Choose another club · current club Mafia Malaga" }),
        );
      } else {
        fireEvent.click(screen.getByRole("button", { name: "Open Manage menu" }));
        fireEvent.click(
          screen.getByRole("button", { name: navigation === "edit" ? "Edit club" : "Delete club" }),
        );
      }
      expect(window.alert).toHaveBeenCalledWith(expect.stringContaining("leaving this club"));
      expect(
        screen.getByRole("button", { name: "Choose another club · current club Mafia Malaga" }),
      ).toBeInTheDocument();
      if (navigation === "exit")
        fireEvent.click(screen.getByRole("button", { name: "Open Manage menu" }));
      fireEvent.click(screen.getByRole("button", { name: "Statistics" }));
      fireEvent.click(await screen.findByRole("button", { name: "Player One" }));
      fireEvent.click(await screen.findByRole("button", { name: "Change tournament" }));
      await screen.findByRole("option", { name: "Autumn cup" });
      expect(screen.getByRole("combobox", { name: "Tournament" })).toHaveValue(first);
      fireEvent.change(screen.getByRole("combobox", { name: "Tournament" }), {
        target: { value: second },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save tournament" }));
      expect(api.assignGameTournament).toHaveBeenCalledTimes(1);
      await act(async () => held.resolve(first));
      await screen.findByRole("button", { name: "Saved to server · tap to check connection" });
      expect(remoteTournament).toBe(second);
      expect(api.assignGameTournament.mock.calls).toEqual([
        [historicalId, first, testClub.id],
        [historicalId, second, testClub.id],
      ]);
      fireEvent.click(screen.getByRole("button", { name: "Back to game" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Choose another club · current club Mafia Malaga" }),
      );
      fireEvent.click(await screen.findByRole("button", { name: "Open Mafia Malaga in Málaga" }));
      await screen.findByRole("button", { name: "Saved to server · tap to check connection" });
      expect(remoteTournament).toBe(second);
      expect(api.assignGameTournament).toHaveBeenCalledTimes(2);
      expect(window.localStorage.getItem(gameSessionStorageKey)).toBeNull();
    },
  );

  it("restores historical-only work to its owner club and blocks leaving until retry settles", async () => {
    vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const historicalId = "00000000-0000-4000-8000-000000000080";
    new GameSessionOutbox({
      storage: window.localStorage,
      clubId: testClub.id,
      createId: () => crypto.randomUUID(),
      save: vi.fn(),
    }).setGameTournament(historicalId, first);
    api.getAuthSession.mockResolvedValue(authenticatedUser);
    api.listClubs.mockResolvedValue([testClub, otherClub]);
    api.assignGameTournament.mockRejectedValueOnce(
      new ApiError("Tournament removed", 404, "tournament_not_found"),
    );
    render(<WelcomeApp />);
    await screen.findByRole("button", { name: /Save blocked.*1 change safe/ });
    fireEvent.click(
      screen.getByRole("button", { name: "Choose another club · current club Mafia Malaga" }),
    );
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining("leaving this club"));
    expect(JSON.parse(window.localStorage.getItem(gameSessionStorageKey)!).current).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Save blocked.*1 change safe/ }));
    await screen.findByRole("button", { name: "Saved to server · tap to check connection" });
    expect(window.localStorage.getItem(gameSessionStorageKey)).toBeNull();
    expect(api.assignGameTournament.mock.calls).toEqual([
      [historicalId, first, testClub.id],
      [historicalId, first, testClub.id],
    ]);
    expect(api.createGameSession).not.toHaveBeenCalled();
  });

  it("refuses cross-club release when historical work appears while the portal is open", async () => {
    const historicalId = "00000000-0000-4000-8000-000000000080";
    api.getAuthSession.mockResolvedValue(authenticatedUser);
    api.listClubs.mockResolvedValue([testClub, otherClub]);
    render(<WelcomeApp />);
    await screen.findByRole("button", { name: /Mafia Sevilla.*Sevilla/i });
    new GameSessionOutbox({
      storage: window.localStorage,
      clubId: testClub.id,
      createId: () => crypto.randomUUID(),
      save: vi.fn(),
    }).setGameTournament(historicalId, first);
    fireEvent.click(await screen.findByRole("button", { name: /Mafia Sevilla.*Sevilla/i }));
    const dialog = await screen.findByRole("dialog", { name: "Game attached to another club" });
    expect(dialog).toHaveTextContent("Pending tournament changes");
    expect(
      within(dialog).getByRole("button", { name: "Release and open Mafia Sevilla" }),
    ).toBeDisabled();
    expect(JSON.parse(window.localStorage.getItem(gameSessionStorageKey)!).current).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Open Mafia Malaga" }));
    await screen.findByRole("button", { name: "Saved to server · tap to check connection" });
    expect(window.localStorage.getItem(gameSessionStorageKey)).toBeNull();
    expect(api.assignGameTournament).toHaveBeenCalledExactlyOnceWith(
      historicalId,
      first,
      testClub.id,
    );
    expect(api.createGameSession).not.toHaveBeenCalled();
  });

  it("does not create on empty toggle; first selection creates and latest choice survives held creation/assignment", async () => {
    api.listTournaments.mockResolvedValue(tournaments);
    const creation = deferred<RemoteGameSession>();
    api.createGameSession.mockReturnValue(creation.promise);
    const assignment = deferred<string | null>();
    api.assignGameTournament.mockReturnValueOnce(assignment.promise).mockResolvedValueOnce(null);
    render(<App />);
    const toggle = screen.getByRole("checkbox", { name: "Include in tournament" });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await screen.findByRole("option", { name: "Autumn cup" });
    expect(api.createGameSession).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Start test game" })).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Tournament" }), {
      target: { value: first },
    });
    await waitFor(() => expect(api.createGameSession).toHaveBeenCalledTimes(1));
    const input = api.createGameSession.mock.calls[0]![0];
    expect(input.tournamentId).toBe(first);
    expect(input.state.setup.rulesEdition).toBe(FEDERATION_RULES_EDITION);
    expect(JSON.stringify(input.state)).not.toContain("tournament");
    fireEvent.change(screen.getByRole("combobox", { name: "Tournament" }), {
      target: { value: second },
    });
    await act(async () =>
      creation.resolve({
        ...remoteSession(serverId, input.name, "Host", 1, 1),
        state: input.state,
        tournamentId: first,
      }),
    );
    await waitFor(() =>
      expect(api.assignGameTournament).toHaveBeenCalledWith(serverId, second, testClub.id),
    );
    expect(screen.getByRole("combobox", { name: "Tournament" })).toHaveValue(second);
    expect(screen.getByRole("button", { name: "Start test game" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Include in tournament" }));
    await act(async () => assignment.resolve(second));
    await waitFor(() =>
      expect(api.assignGameTournament).toHaveBeenLastCalledWith(serverId, null, testClub.id),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start test game" })).toBeEnabled(),
    );
    expect(screen.getByRole("checkbox", { name: "Include in tournament" })).not.toBeChecked();
    expect(api.createGameSession).toHaveBeenCalledTimes(1);
  });

  it("reloads metadata-only pending work, retries it, and starts a fresh game outside tournaments", async () => {
    api.listTournaments.mockResolvedValue(tournaments);
    const stored = seedBrowserGame(testClub, serverId, "Pending event");
    stored.setTournament(first);
    const held = deferred<string | null>();
    api.assignGameTournament.mockReturnValueOnce(held.promise);
    const view = render(<App />);
    await waitFor(() =>
      expect(api.assignGameTournament).toHaveBeenCalledWith(serverId, first, testClub.id),
    );
    expect(screen.getByRole("checkbox", { name: "Include in tournament" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Start test game" })).toBeDisabled();
    await act(async () => held.resolve(first));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start test game" })).toBeEnabled(),
    );
    expect(api.createGameSession).not.toHaveBeenCalled();
    view.unmount();
    render(<App />);
    expect(screen.getByRole("checkbox", { name: "Include in tournament" })).toBeChecked();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Open Manage menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Start new game" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close available players" }));
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Include in tournament" })).not.toBeChecked(),
    );
  });

  it("keeps member statistics separate from manager profile administration", async () => {
    api.getClubStatistics.mockResolvedValue({
      players: [],
      tournaments: [],
      algorithm: "club-team-elo-v1",
      coverage: { completedGames: 0, unavailableGames: 0, pendingGames: 0 },
    });
    render(
      <ClubWorkspace
        club={{ ...testClub, role: "user" }}
        onExit={() => undefined}
        onEditClub={() => undefined}
        onDeleteClub={async () => undefined}
        onLanguageChange={async () => undefined}
        themeColor="#aa7733"
        onThemeColorChange={() => undefined}
        fancyStuff={DEFAULT_FANCY_STUFF_SETTINGS}
        onFancyStuffChange={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Manage menu" }));
    expect(screen.queryByRole("button", { name: "Players screen" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Statistics" }));
    expect(await screen.findByText("No recorded players in this scope.")).toBeInTheDocument();
    expect(api.getClubStatistics).toHaveBeenCalledWith(testClub.id, {});
    expect(screen.queryByRole("button", { name: /timeline/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to game" }));
    expect(screen.getByRole("button", { name: "Start test game" })).toBeInTheDocument();
  });
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
        "Приложение La Verdad уже открыто в другой вкладке. Используйте её или закройте и перезагрузите эту страницу.",
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
        "La Verdad is already open in another tab. Please use that tab, or close it and reload this page.",
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
        "La Verdad is already open in another tab. Please use that tab, or close it and reload this page.",
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
    expect(
      screen.getByRole("heading", { name: "The city sleeps. The game begins." }),
    ).toBeInTheDocument();
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

  it("preserves the saved glass color without a portal picker", () => {
    window.localStorage.setItem(THEME_COLOR_STORAGE_KEY, "#7170ff");
    render(<WelcomeApp />);

    expect(screen.queryByLabelText("Glass color")).not.toBeInTheDocument();

    expect(document.documentElement.style.getPropertyValue("--theme-base")).toBe("#7170ff");
    expect(document.documentElement).not.toHaveAttribute("data-theme");
    expect(window.localStorage.getItem(THEME_COLOR_STORAGE_KEY)).toBe("#7170ff");
  });

  it("creates a club, returns to its card list, and retains the real picker during entry", async () => {
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
    const portal = document.querySelector(".club-portal");
    await user.click(screen.getByRole("button", { name: /Mafia Sevilla.*Sevilla/i }));
    expect(document.querySelector(".club-curtain-opening")).toBeNull();
    expect(document.querySelector(".club-entry-source")).toContainElement(portal as HTMLElement);
    expect(document.querySelector(".club-entry-destination")).toHaveAttribute("inert");
    expect((await screen.findAllByRole("heading", { name: "Game setup" })).length).toBeGreaterThan(
      0,
    );
    await waitFor(() => expect(document.querySelector(".club-entry-source")).toBeNull());
  });

  it.each([false, true])(
    "switches Fancy stuff off for real entry without changing other settings (storage denied: %s)",
    async (storageDenied) => {
      const user = userEvent.setup();
      api.getAuthSession.mockResolvedValue(authenticatedUser);
      api.listClubs.mockResolvedValue([testClub]);
      render(<WelcomeApp />);
      await user.click(await screen.findByRole("button", { name: /Mafia Malaga.*Málaga/i }));
      const privacy = await screen.findByRole("button", { name: /private info/i });
      for (let tap = 0; tap < 6; tap += 1) await user.click(privacy);
      await user.click(await screen.findByRole("button", { name: "Open developer menu" }));
      const section = screen.getByText("Fancy stuff", { selector: "summary" });
      expect(section.closest("details")).not.toHaveAttribute("open");
      await user.click(section);
      const toggle = screen.getByRole("button", { name: "Disable club entry effects" });
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      const otherKeys = [
        THEME_COLOR_STORAGE_KEY,
        "mafia-dashboard.glass.v1",
        "mafia-dashboard.player-exit.v1",
      ];
      const otherSettings = otherKeys.map((key) => window.localStorage.getItem(key));
      const originalSet = Storage.prototype.setItem;
      if (storageDenied)
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
          this: Storage,
          key,
          value,
        ) {
          if (key === "mafia-dashboard.fancy-stuff.v1")
            throw new DOMException("Denied", "SecurityError");
          originalSet.call(this, key, value);
        });
      await user.click(toggle);
      expect(screen.getByRole("button", { name: "Enable club entry effects" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(otherKeys.map((key) => window.localStorage.getItem(key))).toEqual(otherSettings);
      if (!storageDenied)
        expect(JSON.parse(window.localStorage.getItem("mafia-dashboard.fancy-stuff.v1")!)).toEqual({
          version: 1,
          clubEntryEffects: false,
        });
      await user.click(screen.getByRole("button", { name: /^Choose another club/ }));
      const clubButton = await screen.findByRole("button", { name: /Mafia Malaga.*Málaga/i });
      expect(document.querySelector(".club-fire-canvas")).toBeNull();
      await user.click(clubButton);
      expect(document.querySelector(".club-entry-effect")).toBeNull();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /^Choose another club/ })).toHaveFocus(),
      );
      expect(api.createGameSession).not.toHaveBeenCalled();
    },
  );

  it("enters directly with readiness-based focus when club entry effects are saved off", async () => {
    api.getAuthSession.mockResolvedValue(authenticatedUser);
    api.listClubs.mockResolvedValue([testClub]);
    window.localStorage.setItem(
      "mafia-dashboard.fancy-stuff.v1",
      JSON.stringify({ version: 1, clubEntryEffects: false }),
    );
    render(<WelcomeApp />);
    const button = await screen.findByRole("button", { name: /Mafia Malaga.*Málaga/i });
    expect(document.querySelector(".club-fire-canvas")).toBeNull();
    await userEvent.setup().click(button);
    expect(document.querySelector(".club-entry-source")).toBeNull();
    expect(document.querySelector(".club-entry-effect")).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Choose another club/ })).toHaveFocus(),
    );
    expect(document.querySelector(".club-entry-destination")).not.toHaveAttribute("inert");
    expect(api.createGameSession).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "focuses the real workspace when ownership arrives after the entry timeout (effects: %s)",
    async (clubEntryEffects) => {
      window.localStorage.setItem(
        "mafia-dashboard.fancy-stuff.v1",
        JSON.stringify({ version: 1, clubEntryEffects }),
      );
      api.getAuthSession.mockResolvedValue(authenticatedUser);
      api.listClubs.mockResolvedValue([testClub]);
      const view = render(<WelcomeApp />);
      const button = await screen.findByRole("button", { name: /Mafia Malaga.*Málaga/i });
      const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
      const ready = deferred<void>();
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: {
          request: (_name: string, _options: unknown, run: (lock: object) => unknown) =>
            ready.promise.then(() => run({})),
        },
      });
      vi.useFakeTimers();
      try {
        fireEvent.click(button);
        if (!clubEntryEffects) expect(document.querySelector(".club-entry-effect")).toBeNull();
        await act(async () => vi.advanceTimersByTimeAsync(3200));
        expect(document.querySelector(".club-entry-source")).toBeNull();
        expect(api.listPlayers).not.toHaveBeenCalled();
        await act(async () => {
          ready.resolve();
          await vi.advanceTimersByTimeAsync(32);
        });
        expect(screen.getByRole("button", { name: /^Choose another club/ })).toHaveFocus();
        expect(document.querySelector(".club-entry-destination")).not.toHaveAttribute("inert");
      } finally {
        view.unmount();
        vi.useRealTimers();
        if (descriptor) Object.defineProperty(navigator, "locks", descriptor);
        else Reflect.deleteProperty(navigator, "locks");
      }
    },
  );

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
    expect(
      await screen.findByRole("heading", { name: "The city sleeps. The game begins." }),
    ).toBeInTheDocument();
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
    expect(
      await screen.findByRole("heading", { name: "The city sleeps. The game begins." }),
    ).toBeInTheDocument();
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
  it("lets regular users resume and delete club games without manager, music, timeline, or Dev controls", async () => {
    const user = userEvent.setup();
    const gameId = "00000000-0000-4000-8000-000000000081";
    api.listActiveGameSessions.mockResolvedValue([
      {
        gameId,
        name: "Member table",
        revision: 1,
        hostPlayerId,
        phase: "day",
        day: 1,
        updatedAt: "2026-08-18T09:00:00.000Z",
      },
    ]);
    api.getGameSession.mockResolvedValue(
      remoteSession(gameId, "Member table", "Host Player", 1, 1),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <ClubWorkspace
        club={{ ...testClub, role: "user" }}
        onExit={vi.fn()}
        fancyStuff={DEFAULT_FANCY_STUFF_SETTINGS}
        onFancyStuffChange={() => undefined}
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
    await user.click(await screen.findByRole("button", { name: "Resume Member table" }));
    expect(api.getGameSession).toHaveBeenCalledWith(gameId, testClub.id);
    expect(await screen.findByRole("heading", { name: "Live test game" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(await screen.findByRole("button", { name: "Delete Member table" }));
    await waitFor(() => expect(api.clearGameSession).toHaveBeenCalledWith(gameId, testClub.id));
    await waitFor(() =>
      expect(window.localStorage.getItem("mafia-dashboard.game-session.v5")).toBeNull(),
    );
    expect(screen.queryByRole("button", { name: "Players screen" })).toBeNull();
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
          fancyStuff={DEFAULT_FANCY_STUFF_SETTINGS}
          onFancyStuffChange={() => undefined}
          onExit={() => undefined}
          onEditClub={() => undefined}
          onDeleteClub={() => Promise.resolve()}
        />
      </I18nProvider>,
    );

    expect(await screen.findByRole("banner", { name: "Статус приложения" })).toHaveTextContent(
      "Требуется 10 игроков · зарегистрировано: 0",
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
  it("does not count a synthetic Casper as a registered or available human, even when a human shares the nickname", async () => {
    const user = userEvent.setup();
    const humans = assignedGame.players
      .slice(0, 9)
      .map((seat, index) => player(index === 0 ? "Casper" : playerLabel(seat), seat.id));
    api.listPlayers.mockResolvedValue([...humans, player("Casper", "casper")]);
    window.localStorage.setItem(
      `mafia-dashboard.available-player-ids.${testClub.id}`,
      JSON.stringify([...humans.map(({ id }) => id), "casper"]),
    );
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Players & statistics" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Need 10 players · 9 registered")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Start new game" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Add 1 more registered player");
    await user.click(screen.getByRole("button", { name: "Back to game" }));
    expect(screen.getByTestId("setup-player-pool").textContent?.split(",")).toHaveLength(9);
    expect(screen.getByTestId("setup-player-pool")).toHaveTextContent("Casper");
    await user.click(screen.getByRole("button", { name: "Select available players" }));
    expect(screen.getByRole("banner", { name: "Application status" })).toHaveTextContent(
      "9 available",
    );
  });

  it("allows ten human profiles even when a stale synthetic Casper profile is returned", async () => {
    const user = userEvent.setup();
    const humans = assignedGame.players.map((seat, index) =>
      player(index === 0 ? "Casper" : playerLabel(seat), seat.id),
    );
    api.listPlayers.mockResolvedValue([...humans, player("Casper", "casper")]);
    window.localStorage.setItem(
      `mafia-dashboard.available-player-ids.${testClub.id}`,
      JSON.stringify([...humans.map(({ id }) => id), "casper"]),
    );
    render(<App />);

    await waitFor(() => expect(api.listPlayers).toHaveBeenCalledWith(testClub.id));
    expect(screen.getByTestId("setup-player-pool").textContent?.split(",")).toHaveLength(10);
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Players screen" }));
    expect(screen.getByRole("banner", { name: "Application status" })).toHaveTextContent(
      "10 available · 10 registered",
    );
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Start new game" }));
    expect(screen.getByTestId("setup-player-pool")).toHaveTextContent("Casper");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opens Players, allows welcome exit, and blocks a new game below ten profiles", async () => {
    const user = userEvent.setup();
    const onExit = vi.fn();
    api.listPlayers.mockResolvedValue([]);
    const { rerender, unmount } = render(
      <ClubWorkspace
        club={testClub}
        onExit={onExit}
        fancyStuff={DEFAULT_FANCY_STUFF_SETTINGS}
        onFancyStuffChange={() => undefined}
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
    expect(document.title).toBe("Mafia Malaga · La Verdad");
    expect(screen.getByText("Need 10 players · 0 registered")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Choose another club · current club Mafia Malaga" }),
    );
    expect(onExit).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Start new game" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Add 10 more registered players");
    expect(screen.getByRole("heading", { name: "Players & statistics" })).toBeInTheDocument();
    rerender(
      <ClubWorkspace
        club={{ ...testClub, name: "La Verdad" }}
        fancyStuff={DEFAULT_FANCY_STUFF_SETTINGS}
        onFancyStuffChange={() => undefined}
        onExit={onExit}
        onEditClub={() => undefined}
        onDeleteClub={() => Promise.resolve()}
      />,
    );
    expect(document.title).toBe("La Verdad");
    unmount();
    expect(document.title).toBe("La Verdad");
  });

  it("returns from the under-eleven player directory to the existing setup without a navigation trap", async () => {
    const user = userEvent.setup();
    api.listPlayers.mockResolvedValue([]);
    render(
      <ClubWorkspace
        club={testClub}
        fancyStuff={DEFAULT_FANCY_STUFF_SETTINGS}
        onFancyStuffChange={() => undefined}
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

    expect(screen.getByRole("banner", { name: "Application status" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("heading", { name: "Live test game" });
    expect(document.querySelector(".app-shell")).toHaveClass("has-game-screen");
    expect(screen.queryByRole("banner", { name: "Application status" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open Manage menu" })).toBeInTheDocument();
    const liveGame = gameScreenHarness.liveGame;
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Players screen" }));
    expect(document.querySelector(".app-shell")).not.toHaveClass("has-game-screen");
    expect(screen.getByRole("banner", { name: "Application status" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to game" }));

    expect(screen.getByRole("heading", { name: "Live test game" })).toBeInTheDocument();
    expect(screen.queryByRole("banner", { name: "Application status" })).toBeNull();
    expect(gameScreenHarness.liveGame).toBe(liveGame);
    expect(api.clearGameSession).not.toHaveBeenCalled();
  });
});

describe("developer menu", () => {
  it("persists player exit defaults and tuning without preview changing the live game", async () => {
    const user = userEvent.setup();
    const first = render(<App />);
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByText("Player exit animation", { selector: "summary" }));
    expect(screen.getByLabelText("Lift duration")).toHaveValue("100");
    expect(screen.getByLabelText("Landing duration")).toHaveValue("480");
    expect(screen.getByLabelText("Lift / flip overlap")).toHaveValue("100");
    const gameBefore = gameScreenHarness.liveGame;
    await user.click(screen.getByRole("button", { name: "Preview exit" }));
    expect(gameScreenHarness.liveGame).toBe(gameBefore);
    fireEvent.change(screen.getByLabelText("Lift duration"), { target: { value: "200" } });
    await user.selectOptions(screen.getByLabelText("Flip easing"), "in");
    const key = "mafia-dashboard.player-exit.v1";
    expect(JSON.parse(window.localStorage.getItem(key) ?? "null")).toMatchObject({
      liftMs: 200,
      landingMs: 480,
      overlap: 100,
      flip: { easing: "in", strength: 100 },
    });
    first.unmount();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByText("Player exit animation", { selector: "summary" }));
    expect(screen.getByLabelText("Lift duration")).toHaveValue("200");
    expect(screen.getByLabelText("Flip easing")).toHaveValue("in");
    const glassBefore = window.localStorage.getItem("mafia-dashboard.glass.v1");
    await user.click(screen.getByRole("button", { name: "Reset exit animation settings" }));
    expect(screen.getByLabelText("Lift duration")).toHaveValue("100");
    for (const phase of ["Lift", "Flip", "Drop"]) {
      expect(screen.getByLabelText(`${phase} easing`)).toHaveValue("out");
      expect(screen.getByLabelText(`${phase} easing strength`)).toHaveValue("100");
    }
    expect(window.localStorage.getItem("mafia-dashboard.glass.v1")).toBe(glassBefore);
    expect(gameScreenHarness.liveGame).toBe(gameBefore);
  });

  it("reports the live opaque accessibility override even with enhanced glass saved off", async () => {
    const original = window.matchMedia;
    const transparency = Object.assign(new EventTarget(), { matches: true });
    window.matchMedia = ((query: string) =>
      query === "(prefers-reduced-transparency: reduce)"
        ? transparency
        : Object.assign(new EventTarget(), { matches: false })) as typeof window.matchMedia;
    window.localStorage.setItem(
      "mafia-dashboard.glass.v1",
      JSON.stringify({ version: 1, enabled: false }),
    );
    const user = userEvent.setup();
    const view = render(<App />);
    try {
      await user.click(screen.getByRole("button", { name: "Open developer menu" }));
      await user.click(screen.getByText("Glass", { selector: "summary" }));
      await user.click(screen.getByText("Fine tuning", { selector: "summary" }));
      expect(document.querySelector(".app-shell")).toHaveAttribute(
        "data-glass-status",
        "reduced-transparency",
      );
      expect(screen.getByLabelText("Frosting amount")).toBeDisabled();
      expect(screen.getByLabelText("Glass tint")).toBeDisabled();
      expect(screen.getByLabelText("Edge highlights")).toBeDisabled();
      expect(screen.getByLabelText("Caustic light")).toBeDisabled();
      act(() => {
        transparency.matches = false;
        transparency.dispatchEvent(new Event("change"));
      });
      expect(document.querySelector(".app-shell")).toHaveAttribute("data-glass-status", "off");
      expect(screen.getByLabelText("Frosting amount")).toBeEnabled();
      expect(screen.getByLabelText("Glass tint")).toBeEnabled();
      expect(
        JSON.parse(window.localStorage.getItem("mafia-dashboard.glass.v1") ?? "null").enabled,
      ).toBe(false);
    } finally {
      view.unmount();
      window.matchMedia = original;
    }
  });

  it("mounts fresh shared glass across setup, availability and player management without developer access", async () => {
    window.localStorage.removeItem(DEVELOPER_UNLOCKED_STORAGE_KEY);
    const user = userEvent.setup();
    renderView(<App />);
    await screen.findByRole("button", { name: "Select available players" });
    expect(document.querySelector(".glass-scene-canvas")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open developer menu" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Select available players" }));
    expect(document.querySelector(".glass-scene-canvas")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close available players" }));
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Players screen" }));
    expect(document.querySelector(".glass-scene-canvas")).toBeInTheDocument();
  });

  it("tunes device-local glass in a collapsed drawer section and resets only glass", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "mafia-dashboard.glass.v1",
      JSON.stringify({
        version: 1,
        enabled: false,
        refraction: 10,
        goldLight: 25,
        matte: true,
      }),
    );
    const first = render(<App />);
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    const section = screen.getByText("Glass", { selector: "summary" });
    expect(section.closest("details")).not.toHaveAttribute("open");
    await user.click(section);
    const toggle = screen.getByRole("button", { name: "Enable enhanced glass" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(document.querySelector(".app-shell")).toHaveStyle("--glass-matte-blur: 2px");
    await user.click(screen.getByRole("button", { name: "Disable matte glass" }));
    expect(document.querySelector(".app-shell")).toHaveStyle("--glass-matte-blur: 0px");
    expect(screen.getByLabelText("Refraction strength")).toHaveValue("10");
    expect(screen.getByLabelText("Refraction strength")).toBeDisabled();
    expect(screen.getByLabelText("Gold background light")).toHaveValue("25");
    fireEvent.change(screen.getByLabelText("Gold background light"), { target: { value: "63" } });
    expect(document.querySelector(".app-shell")).toHaveStyle("--glass-gold-light: 0.63");
    await user.click(toggle);
    expect(screen.getByRole("button", { name: "Disable enhanced glass" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const key = "mafia-dashboard.glass.v1";
    expect(JSON.parse(window.localStorage.getItem(key) ?? "null")).toEqual({
      version: 1,
      enabled: true,
      refraction: 10,
      goldLight: 63,
      matte: false,
      profile: "edge",
      frosting: 50,
      tint: 13,
      edgeHighlights: 100,
      caustics: 100,
      noirContrast: 100,
      nominationTint: 18,
      nominationColor: "#e6bc7e",
      nominationTreatment: "hybrid",
      nominationIcon: "vote",
      supportIcon: "hand",
      selectionStyle: "check-outline",
    });
    await user.click(screen.getByRole("button", { name: "Hide developer mode" }));
    expect(JSON.parse(window.localStorage.getItem(key) ?? "null").enabled).toBe(true);
    expect(document.querySelector(".app-shell")).toHaveStyle("--glass-matte-blur: 0px");
    first.unmount();
    window.localStorage.setItem(DEVELOPER_UNLOCKED_STORAGE_KEY, "unlocked");
    const lightingBefore = window.localStorage.getItem(LIGHTING_RENDERER_STORAGE_KEY);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByText("Glass", { selector: "summary" }));
    expect(screen.getByLabelText("Gold background light")).toHaveValue("63");
    expect(screen.getByRole("button", { name: "Enable matte glass" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(document.querySelector(".app-shell")).toHaveStyle("--glass-matte-blur: 0px");
    expect(screen.getByRole("button", { name: "Disable enhanced glass" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Reset glass settings" }));
    expect(screen.getByLabelText("Gold background light")).toHaveValue("25");
    expect(screen.getByRole("button", { name: "Disable enhanced glass" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(window.localStorage.getItem(LIGHTING_RENDERER_STORAGE_KEY)).toBe(lightingBefore);
    expect(screen.getByRole("button", { name: "Disable matte glass" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(document.querySelector(".app-shell")).toHaveStyle("--glass-matte-blur: 2px");
    await user.click(screen.getByText("Fine tuning", { selector: "summary" }));
    fireEvent.change(screen.getByLabelText("Frosting amount"), { target: { value: "100" } });
    expect(document.querySelector(".app-shell")).toHaveStyle("--glass-matte-blur: 4px");
    fireEvent.change(screen.getByLabelText("Glass tint"), { target: { value: "30" } });
    expect(document.querySelector(".app-shell")).toHaveStyle("--glass-tint: 0.3");
  });

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
        fancyStuff={DEFAULT_FANCY_STUFF_SETTINGS}
        onFancyStuffChange={() => undefined}
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

  it("shows the exact server Canary version with a bird icon at the top, retaining it on reopen", async () => {
    const user = userEvent.setup();
    api.getAppVersion.mockResolvedValue("2.7.123");
    render(<App />);

    expect(api.getAppVersion).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));

    const menu = screen.getByRole("dialog", { name: "Developer menu" });
    const version = await within(menu).findByLabelText("Canary version 2.7.123");
    expect(version).toHaveTextContent("Canary v2.7.123");
    expect(version.querySelector(".lucide-bird")).toBeInTheDocument();
    expect(menu.firstElementChild).toContainElement(version);
    await user.click(screen.getByRole("button", { name: "Close developer menu" }));
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    expect(screen.getByLabelText("Canary version 2.7.123")).toBeInTheDocument();
    expect(api.getAppVersion).toHaveBeenCalledOnce();
  });

  it("keeps the workspace usable while loading and retries failed version requests on reopening", async () => {
    const user = userEvent.setup();
    const first = deferred<string>();
    api.getAppVersion.mockReturnValueOnce(first.promise).mockResolvedValueOnce("3.4.5");
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    const menu = screen.getByRole("dialog", { name: "Developer menu" });
    const loading = within(menu).getByLabelText("Canary version loading");
    expect(loading).toHaveTextContent("Canary vLoading…");
    expect(loading).not.toHaveTextContent("1.0.0");
    expect(screen.getByRole("button", { name: "Enter role giveaway" })).toBeInTheDocument();
    first.reject(new TypeError("Network unavailable"));
    expect(await within(menu).findByLabelText("Canary version unavailable")).toHaveTextContent(
      "Canary vUnavailable",
    );
    await user.click(screen.getByRole("button", { name: "Close developer menu" }));
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    expect(await screen.findByLabelText("Canary version 3.4.5")).toHaveTextContent("Canary v3.4.5");
    expect(api.getAppVersion).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale version result after closing and reopening the menu", async () => {
    const user = userEvent.setup();
    const first = deferred<string>();
    const second = deferred<string>();
    api.getAppVersion.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByRole("button", { name: "Close developer menu" }));
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await waitFor(() => expect(api.getAppVersion).toHaveBeenCalledTimes(2));
    await act(async () => first.resolve("9.9.9"));
    expect(screen.getByLabelText("Canary version loading")).toBeInTheDocument();
    await act(async () => second.resolve("4.5.6"));
    expect(screen.getByLabelText("Canary version 4.5.6")).toBeInTheDocument();
  });

  it("localizes Canary loading and error states in Russian", async () => {
    const user = userEvent.setup();
    const pending = deferred<string>();
    api.getAppVersion.mockReturnValue(pending.promise);
    renderView(
      <I18nProvider locale="ru">
        <App />
      </I18nProvider>,
    );
    const privacy = screen.getByRole("button", { name: "Скрыть личную информацию" });
    for (let tap = 0; tap < 6; tap += 1) fireEvent.click(privacy);
    await user.click(screen.getByRole("button", { name: "Открыть меню разработчика" }));
    expect(screen.getByLabelText("Версия Canary загружается")).toHaveTextContent(
      "Canary vЗагрузка…",
    );
    pending.reject(new Error("Unavailable"));
    expect(await screen.findByLabelText("Версия Canary недоступна")).toHaveTextContent(
      "Canary vНедоступна",
    );
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
    expect(window.localStorage.getItem(THEME_COLOR_STORAGE_KEY)).toBe("#7170ff");
    await user.click(
      screen.getByRole("button", { name: "Choose another club · current club Mafia Malaga" }),
    );
    expect(
      await screen.findByRole("heading", { name: "The city sleeps. The game begins." }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Glass color")).not.toBeInTheDocument();
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

  it("resolves active host IDs from the current directory and distinguishes no selection", async () => {
    const user = userEvent.setup();
    const summaries = [
      {
        gameId: "00000000-0000-4000-8000-0000000000d4",
        name: "Hosted",
        hostPlayerId,
        phase: "day",
        day: 2,
        revision: 3,
        updatedAt: "2026-08-18T12:00:00.000Z",
      },
      {
        gameId: "00000000-0000-4000-8000-0000000000d5",
        name: "Retired",
        hostPlayerId: "00000000-0000-4000-8000-000000000888",
        phase: "day",
        day: 2,
        revision: 3,
        updatedAt: "2026-08-18T12:00:00.000Z",
      },
      {
        gameId: "00000000-0000-4000-8000-0000000000d6",
        name: "Unhosted",
        hostPlayerId: null,
        phase: "day",
        day: 2,
        revision: 3,
        updatedAt: "2026-08-18T12:00:00.000Z",
      },
    ];
    api.listActiveGameSessions.mockResolvedValue(summaries);
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Open Manage menu" }));
    expect(screen.getByText("Host Player · Day · day 2")).toBeInTheDocument();
    expect(screen.getByText("Anonymous player · Day · day 2")).toBeInTheDocument();
    expect(screen.getByText("Host not selected · Day · day 2")).toBeInTheDocument();
    expect(JSON.stringify(summaries)).not.toContain("Host Player");
  });

  it("keeps active game sessions in Manage without player-assignment controls", async () => {
    const user = userEvent.setup();
    api.listActiveGameSessions.mockResolvedValue([
      {
        gameId: "00000000-0000-4000-8000-0000000000d4",
        name: "Dev table",
        revision: 3,
        hostPlayerId,
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
        hostPlayerId,
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

  it.each([0, 4, 9])(
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
        [...assignedGame.players.map(playerLabel), "Host Player"].join(","),
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
      `${playerLabel(firstPlayer!)},Host Player`,
    );
    expect(screen.getByTestId("setup-player-pool")).not.toHaveTextContent(
      playerLabel(secondPlayer!),
    );
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
    const firstCard = screen.getByRole("button", {
      name: `Mark ${playerLabel(firstPlayer)} available`,
    });
    await user.click(firstCard);
    expect(firstCard).toHaveAttribute("aria-pressed", "true");
    expect(firstCard).toHaveClass("is-availability-selected");
    expect(firstCard.querySelector(".vgpu-player-lighting")).toBeNull();
    expect(firstCard.querySelector(".liquid-card-glass")).not.toBeNull();
    expect(firstCard).toHaveAttribute("data-player-glass", "availability");
    expect(document.querySelector(".app-shell")).not.toHaveAttribute("data-player-lighting");

    await user.type(
      screen.getByRole("searchbox", { name: "Search available players" }),
      playerLabel(secondPlayer),
    );
    expect(
      screen.getByRole("button", { name: `Mark ${playerLabel(secondPlayer)} available` }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: `Mark ${playerLabel(firstPlayer)} unavailable` }),
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
    expect(within(rail).queryByRole("region", { name: "Voting order" })).toBeNull();
    expect(rail.lastElementChild).toBe(player.closest(".youtube-dock"));
    expect(screen.getByTestId("youtube-player")).toBe(player);
  });

  it("keeps the complete right pane unchanged across setup, Available players, and Role giveaway", async () => {
    const user = userEvent.setup();
    render(<App />);
    const rail = screen.getByRole("complementary", { name: "Live game controls" });
    const player = await screen.findByTestId("youtube-player");
    const timer = within(rail).getByRole("region", { name: "Timer controls" });
    expect(within(rail).queryByRole("region", { name: "Voting order" })).toBeNull();

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
    expect(screen.queryByRole("region", { name: "Voting order" })).toBeNull();
    expect(musicPlayerHarness).toMatchObject({ mounts: 1, unmounts: 0 });

    await user.click(screen.getByRole("button", { name: "Exit preview" }));
    expect(screen.getByTestId("youtube-player")).toBe(player);
    expect(musicPlayerHarness).toMatchObject({ mounts: 1, unmounts: 0 });
  });

  it("selects playlists in the expanded queue while retaining account setup behind Manage", async () => {
    const user = userEvent.setup();
    render(<App />);
    const player = await screen.findByTestId("youtube-player");

    expect(screen.queryByRole("combobox", { name: "YouTube Music playlist" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Music player panel handle" }));
    const queue = screen.getByRole("region", { name: "Session playlist queue" });
    const playlist = within(queue).getByRole("combobox", { name: "YouTube Music playlist" });
    await user.selectOptions(playlist, "dev-playlist");
    expect(playlist).toHaveValue("dev-playlist");
    expect(player).toHaveAttribute("data-playlist-id", "dev-playlist");
    expect(screen.queryByRole("region", { name: "Music player setup" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    expect(screen.queryByRole("button", { name: "Reload music player" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Music player setup" }));

    expect(screen.getByRole("region", { name: "Music player setup" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload music player" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Low")).toBeNull();
    expect(screen.queryByLabelText("High")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Voting playlist" })).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "Music player setup" })).queryByRole("combobox"),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Disconnect account" })).toBeInTheDocument();
    expect(screen.getByTestId("youtube-player")).toBe(player);
    expect(musicPlayerHarness).toMatchObject({ mounts: 1, unmounts: 0 });
    await user.click(screen.getByRole("button", { name: "Close Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Music player panel handle" }));
    expect(screen.queryByRole("combobox", { name: "YouTube Music playlist" })).toBeNull();
    expect(musicPlayerHarness).toMatchObject({ mounts: 1, unmounts: 0 });
  });

  it("exposes only the approved bounded glass controls, not retired arbitrary glass settings", async () => {
    const user = userEvent.setup();
    render(
      <ClubWorkspace
        club={testClub}
        fancyStuff={DEFAULT_FANCY_STUFF_SETTINGS}
        onFancyStuffChange={() => undefined}
        onExit={() => undefined}
        onEditClub={() => undefined}
        onDeleteClub={() => Promise.resolve()}
        themeColor="#c39a58"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));

    expect(screen.queryByRole("group", { name: "Glass settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: /Glass/i })).not.toBeInTheDocument();
    expect(screen.getByText("Glass", { selector: "summary" })).toBeInTheDocument();
    expect(screen.getByLabelText("Refraction strength")).toHaveAttribute("max", "24");
    expect(screen.getByLabelText("Gold background light")).toHaveAttribute("max", "100");
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
    await user.click(await screen.findByRole("button", { name: "Music player panel handle" }));
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
    await user.click(await screen.findByRole("button", { name: "Music player panel handle" }));
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

  it("owns voting-order selection in the live draft and never edits a preview", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await user.click(await screen.findByRole("button", { name: "Enter voting phase" }));
    const order = screen.getByRole("region", { name: "Voting order" });
    await user.click(within(order).getByRole("button", { name: /#3/i }));
    expect(screen.getByText("Game turn 1")).toBeInTheDocument();
    expect(gameScreenHarness.liveGame?.voteAssignments).toMatchObject({ 1: 3, 10: 3 });
    const current = JSON.parse(
      window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null",
    );
    expect(current.current.state.game.voteAssignments).toMatchObject({ 1: 3, 10: 3 });
    await user.click(within(order).getByRole("button", { name: /#2/i }));
    expect(screen.getByText("Game turn 0")).toBeInTheDocument();
    expect(gameScreenHarness.liveGame?.voteAssignments).toMatchObject({ 1: 3, 10: 3 });
    await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));
    await user.click(screen.getByRole("button", { name: "Open game log" }));
    await user.click(screen.getByRole("button", { name: "Preview state after log #1" }));
    expect(screen.queryAllByRole("button", { name: /#2|#3/i })).toHaveLength(0);
    expect(gameScreenHarness.previewGame?.voteAssignments).toEqual({});
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

  it("hides unavailable fullscreen while keeping Undo and the private mask across views", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.queryByRole("button", { name: /fullscreen/i })).toBeNull();
    const undo = screen.getByRole("button", { name: /undo last action.*0 available/i });
    const privacy = screen.getByRole("button", { name: "Hide private info" });

    expect(undo).toBeVisible();
    expect(undo).toBeDisabled();
    expect(privacy).toBeVisible();
    expect(privacy.querySelector("svg")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Players screen" }));

    expect(screen.queryByRole("button", { name: /fullscreen/i })).toBeNull();
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

  it("opens the read-only illustrated book from the single top icon and restores focus", async () => {
    const { GameScreen: RealGameScreen } = await vi.importActual<typeof gameScreenModule>(
      "./features/game/GameScreen.js",
    );
    const mock = vi.spyOn(gameScreenModule, "GameScreen").mockImplementation(RealGameScreen);
    const state = federationGame();
    const outbox = new GameSessionOutbox({
      storage: window.localStorage,
      clubId: testClub.id,
      createId: () => crypto.randomUUID(),
      save: vi.fn(),
    });
    outbox.activateRemote({
      ...remoteSession("00000000-0000-4000-8000-000000000399", "Rules toolbar", "Host", 1, 1),
      state: {
        ...browserSessionState(""),
        game: state,
        hostPlayerId,
        initialGame: createInitialGameBaseline(state),
      },
    });
    try {
      const user = userEvent.setup();
      render(<App />);
      const rules = await screen.findByRole("button", { name: "Rules" });
      expect(rules.closest(".app-fixed-toolbar")).not.toBeNull();
      expect(rules.textContent).toBe("");
      expect(rules.querySelector("svg")).not.toBeNull();
      expect(screen.getAllByRole("button", { name: "Rules" })).toHaveLength(1);
      await user.click(rules);
      expect(
        await screen.findByRole("dialog", { name: "Illustrated Mafia rulebook" }),
      ).toBeVisible();
      expect(screen.queryByLabelText("Discipline action")).not.toBeVisible();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog", { name: "Illustrated Mafia rulebook" })).toBeNull();
      expect(rules).toHaveFocus();
      await user.click(rules);
      expect(
        await screen.findByRole("dialog", { name: "Illustrated Mafia rulebook" }),
      ).toBeVisible();
    } finally {
      mock.mockRestore();
    }
  });

  it.each(["denied", "ios-standalone", "standalone-display"])(
    "hides fullscreen even when the request method exists: %s",
    async (environment) => {
      Object.defineProperty(document.documentElement, "requestFullscreen", {
        configurable: true,
        value: vi.fn(),
      });
      Object.defineProperty(document, "fullscreenEnabled", {
        configurable: true,
        value: environment !== "denied",
      });
      Object.defineProperty(navigator, "standalone", {
        configurable: true,
        value: environment === "ios-standalone",
      });
      const matchMedia = window.matchMedia;
      window.matchMedia = vi.fn((query: string) => ({
        ...matchMedia?.(query),
        matches: query === "(display-mode: standalone)" && environment === "standalone-display",
      })) as typeof window.matchMedia;
      try {
        render(<App />);
        await screen.findByRole("button", { name: "Open Manage menu" });
        expect(screen.queryByRole("button", { name: /fullscreen/i })).toBeNull();
      } finally {
        Reflect.deleteProperty(document.documentElement, "requestFullscreen");
        Reflect.deleteProperty(document, "fullscreenEnabled");
        Reflect.deleteProperty(navigator, "standalone");
        window.matchMedia = matchMedia;
      }
    },
  );

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
        await waitFor(() =>
          expect(
            JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5")!).current
              .state.setup.rulesEdition,
          ).toBe(FEDERATION_RULES_EDITION),
        );
        for (const seat of assignedGame.players) {
          await user.click(screen.getByRole("combobox", { name: `Seat ${seat.seat} player` }));
          await user.click(screen.getByRole("option", { name: playerLabel(seat) }));
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
        for (const seat of assignedGame.players.slice(1)) {
          await user.click(
            screen.getByRole("button", { name: `Draw role for ${playerLabel(seat)}` }),
          );
        }
        expect(table.querySelectorAll(".role-badge")).toHaveLength(10);
        expect(within(table).getByText("All roles assigned")).toBeVisible();
        expect(screen.queryByText("Draw roles · 0 remaining")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Begin Mafia planning stage" }));
        expect(screen.queryByRole("heading", { name: "Role giveaway" })).not.toBeInTheDocument();
        const gameTable = screen.getByRole("region", { name: "Mafia table" });
        expect(gameTable.querySelectorAll(".role-badge")).toHaveLength(10);
        expect(screen.getByRole("button", { name: "Show private info" })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        await user.click(screen.getByRole("button", { name: "Show private info" }));
        expect(gameTable.querySelectorAll(".role-badge")).toHaveLength(10);
        await waitFor(() =>
          expect(api.saveGameSession.mock.lastCall?.[1].state.initialGame?.replayVersion).toBe(2),
        );
        const saved = api.saveGameSession.mock.lastCall![1].state;
        expect(saved.game).toMatchObject({
          rulesEdition: FEDERATION_RULES_EDITION,
          bestMoveEnabled: true,
        });
        expect(replayGameLog(saved.initialGame, saved.events).game).toEqual(saved.game);
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
      "Clear all data stored by La Verdad in this browser? Server players, sessions, results, and music will not be deleted.",
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
    await user.click(screen.getByRole("button", { name: "Music player panel handle" }));
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
    for (const seat of assignedGame.players) {
      await user.click(screen.getByRole("button", { name: `Mark ${playerLabel(seat)} available` }));
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
          hostPlayerId,
          phase: "day",
          day: 1,
          updatedAt: "2026-08-18T09:00:00.000Z",
        },
        {
          gameId: newId,
          name: "Table B",
          revision: 2,
          hostPlayerId,
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
      if (outcome === "success") await screen.findByText("Host: Host Player");
      else await waitFor(() => expect(api.getGameSession).toHaveBeenCalledWith(newId, testClub.id));
      deletion.resolve();
      await act(async () => {
        await deletion.promise;
        await Promise.resolve();
      });

      if (outcome === "success") {
        expect(screen.getByText("Host: Host Player")).toBeInTheDocument();
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

  it("saves incomplete setup as an unfinished game and restores it after reload", async () => {
    const user = userEvent.setup();
    const first = render(<App />);
    await waitFor(() => expect(api.listPlayers).toHaveBeenCalledOnce());

    expect(api.createGameSession).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("mafia-dashboard.game-session.v5")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Save setup progress" }));

    await waitFor(() => expect(api.createGameSession).toHaveBeenCalledOnce());
    const saved = JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5")!);
    expect(saved.current.state).toMatchObject({
      setup: {
        hostPlayerId,
        selectedPlayerIds: [assignedGame.players[0]!.id, ...Array(9).fill("")],
      },
      game: null,
    });
    expect(saved.current.results).toBeNull();
    first.unmount();
    render(<App />);
    expect(JSON.parse(screen.getByTestId("setup-session").textContent!)).toEqual(
      saved.current.state.setup,
    );
    expect(api.createGameSession).toHaveBeenCalledOnce();
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
            bestMoveEnabled: true,
            selectedPlayerIds: assignedGame.players.map(({ id }) => id),
            setup: {
              step: "role-draw",
              players: assignedGame.players.map(({ id, seat }) => ({ id, seat })),
              roleDeck,
              remainingRoles: roleDeck,
              assignments: {},
            },
          },
          hostPlayerId,
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

  it("restores real partial seats without browser availability and honors deliberate removals", async () => {
    const { SetupWizard: RealSetupWizard } = await vi.importActual<typeof setupWizardModule>(
      "./features/setup/SetupWizard.js",
    );
    vi.spyOn(setupWizardModule, "SetupWizard").mockImplementation(RealSetupWizard);
    const user = userEvent.setup();
    const creation = deferred<RemoteGameSession>();
    api.createGameSession.mockReturnValue(creation.promise);
    const first = renderView(<App />);
    await user.click(screen.getByRole("button", { name: "Select available players" }));
    await user.click(screen.getByRole("button", { name: "Mark Player 1 available" }));
    await user.click(screen.getByRole("button", { name: "Mark Host Player available" }));
    await user.click(screen.getByRole("button", { name: "Close available players" }));
    await user.click(screen.getByRole("combobox", { name: "Seat 4 player" }));
    await user.click(screen.getByRole("option", { name: "Player 1" }));
    await waitFor(() => expect(api.createGameSession).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("combobox", { name: "Host player" }));
    await user.click(screen.getByRole("option", { name: "Host Player" }));
    const saved = JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5")!);
    expect(saved.current.state.setup.hostPlayerId).toBe(hostPlayerId);
    expect(saved.current.state.hostPlayerId).toBe(hostPlayerId);
    expect(saved.current.state.setup.selectedPlayerIds).toEqual([
      "",
      "",
      "",
      assignedGame.players[0]!.id,
      ...Array(6).fill(""),
    ]);
    first.unmount();
    window.localStorage.removeItem(`mafia-dashboard.available-player-ids.${testClub.id}`);
    const profiles = deferred<readonly PlayerProfile[]>();
    api.listPlayers.mockReturnValue(profiles.promise);
    const restored = renderView(<App />);
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5")!).current.state
        .setup,
    ).toEqual(saved.current.state.setup);
    await act(async () =>
      profiles.resolve([
        ...assignedGame.players.map((seat) => player(playerLabel(seat), seat.id)),
        player("Host Player", hostPlayerId),
      ]),
    );
    expect(screen.getByRole("combobox", { name: "Seat 4 player" })).toHaveValue("Player 1");
    expect(screen.getByRole("combobox", { name: "Host player" })).toHaveValue("Host Player");
    expect(screen.getByRole("combobox", { name: "Seat 1 player" })).toHaveValue("");
    await waitFor(() => expect(api.createGameSession).toHaveBeenCalledTimes(2));
    const gameId = "00000000-0000-4000-8000-000000000090";
    await act(async () =>
      creation.resolve({
        ...remoteSession(gameId, "Partial setup", "", 1, 0),
        state: api.createGameSession.mock.calls[0]![0].state,
      }),
    );
    await waitFor(() =>
      expect(api.saveGameSession.mock.lastCall?.[1].state.hostPlayerId).toBe(hostPlayerId),
    );
    expect(api.createGameSession.mock.calls.map(([input]) => input.creationId)).toEqual([
      saved.creationId,
      saved.creationId,
    ]);
    await user.click(screen.getByRole("button", { name: "Select available players" }));
    await user.click(screen.getByRole("button", { name: "Mark Player 1 unavailable" }));
    await user.click(screen.getByRole("button", { name: "Mark Host Player unavailable" }));
    restored.unmount();
    renderView(<App />);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Host player" })).not.toBeDisabled(),
    );
    expect(screen.getByRole("combobox", { name: "Seat 4 player" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Host player" })).toHaveValue("");
    await waitFor(() =>
      expect(api.saveGameSession.mock.lastCall?.[1].state.setup).toMatchObject({
        hostPlayerId: "",
        selectedPlayerIds: Array(10).fill(""),
        bestMoveEnabled: true,
        setup: null,
      }),
    );
    expect(api.createGameSession).toHaveBeenCalledTimes(2);
    expect(JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5")!).gameId).toBe(
      gameId,
    );
  });

  it.each(["resume", "new"])(
    "settles pending creation before %s can leave the setup",
    async (action) => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const { SetupWizard: RealSetupWizard } = await vi.importActual<typeof setupWizardModule>(
        "./features/setup/SetupWizard.js",
      );
      vi.spyOn(setupWizardModule, "SetupWizard").mockImplementation(RealSetupWizard);
      window.localStorage.setItem(
        `mafia-dashboard.available-player-ids.${testClub.id}`,
        JSON.stringify([assignedGame.players[0]!.id, hostPlayerId]),
      );
      const creation = deferred<RemoteGameSession>();
      api.createGameSession.mockReturnValue(creation.promise);
      const otherGameId = "00000000-0000-4000-8000-000000000020";
      api.listActiveGameSessions.mockResolvedValue([
        {
          gameId: otherGameId,
          name: "Other table",
          revision: 1,
          hostPlayerId,
          phase: "day-speech",
          day: 1,
          updatedAt: "2026-09-30T10:00:00.000Z",
        },
      ]);
      api.getGameSession.mockResolvedValue(
        remoteSession(otherGameId, "Other table", "Host Player", 1, 1),
      );
      const user = userEvent.setup();
      renderView(<App />);
      await user.click(await screen.findByRole("combobox", { name: "Seat 4 player" }));
      await user.click(await screen.findByRole("option", { name: "Player 1" }));
      await waitFor(() => expect(api.createGameSession).toHaveBeenCalledOnce());
      await user.click(screen.getByRole("combobox", { name: "Host player" }));
      await user.click(screen.getByRole("option", { name: "Host Player" }));
      await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
      await user.click(
        await screen.findByRole("button", {
          name: action === "resume" ? "Resume Other table" : "Start new game",
        }),
      );
      const readEnvelope = () =>
        JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null");
      expect(readEnvelope()).toMatchObject({ gameId: null, current: { state: { hostPlayerId } } });
      const input = api.createGameSession.mock.calls[0]![0];
      const gameId = "00000000-0000-4000-8000-000000000090";
      await act(async () =>
        creation.resolve({
          ...remoteSession(gameId, input.name, "", 1, 0),
          state: input.state,
        }),
      );
      await waitFor(() =>
        expect(api.saveGameSession.mock.lastCall?.[1].state.hostPlayerId).toBe(hostPlayerId),
      );
      expect(api.saveGameSession.mock.lastCall?.[0]).toBe(gameId);
      await waitFor(() =>
        expect(readEnvelope()?.gameId ?? null).toBe(action === "resume" ? otherGameId : null),
      );
      expect(
        window.localStorage.getItem(`mafia-dashboard.game-session.v5.parked.${input.creationId}`),
      ).toBeNull();
      const parked = JSON.parse(
        window.localStorage.getItem(`mafia-dashboard.game-session.v5.parked.${gameId}`)!,
      );
      expect(parked.current.state.setup).toMatchObject({
        hostPlayerId,
        selectedPlayerIds: ["", "", "", assignedGame.players[0]!.id, ...Array(6).fill("")],
      });
    },
  );

  it.each([false, undefined])(
    "resumes a real Casper draw with saved Best Move %s before creating its canonical game",
    async (savedBestMove) => {
      const { SetupWizard: RealSetupWizard } = await vi.importActual<typeof setupWizardModule>(
        "./features/setup/SetupWizard.js",
      );
      const setupMock = vi
        .spyOn(setupWizardModule, "SetupWizard")
        .mockImplementation(RealSetupWizard);
      const humans = assignedGame.players.slice(0, 9);
      api.listPlayers.mockResolvedValue([
        ...humans.map((seat) => player(playerLabel(seat), seat.id)),
        player("Host Player", hostPlayerId),
      ]);
      window.localStorage.setItem(
        `mafia-dashboard.available-player-ids.${testClub.id}`,
        JSON.stringify([...humans.map(({ id }) => id), hostPlayerId]),
      );
      const user = userEvent.setup();
      const gameId = "00000000-0000-4000-8000-000000000090";
      try {
        const first = renderView(
          <ClubWorkspace
            club={{ ...testClub, bestMoveEnabled: false }}
            fancyStuff={DEFAULT_FANCY_STUFF_SETTINGS}
            onFancyStuffChange={() => undefined}
            onExit={() => undefined}
            onEditClub={() => undefined}
            onDeleteClub={() => Promise.resolve()}
          />,
        );
        await waitFor(() => expect(api.listPlayers).toHaveBeenCalledWith(testClub.id));
        await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
        await user.click(screen.getByRole("button", { name: "Players screen" }));
        await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
        await user.click(screen.getByRole("button", { name: "Start new game" }));
        await user.click(await screen.findByRole("combobox", { name: "Host player" }));
        await user.click(await screen.findByRole("option", { name: "Host Player" }));
        await waitFor(() => expect(api.createGameSession).toHaveBeenCalledOnce());
        expect(api.createGameSession.mock.calls[0]?.[0].state.setup).toMatchObject({
          step: "players",
          hostPlayerId,
          bestMoveEnabled: false,
          setup: null,
        });
        await user.click(screen.getByRole("switch", { name: "Include Casper" }));
        await user.click(screen.getByRole("button", { name: "Assign players" }));
        expect(screen.getByRole("button", { name: "Start game" })).toBeEnabled();
        expect(screen.queryByText("Nonstandard club deviations")).toBeNull();
        await user.click(screen.getByRole("button", { name: "Start game" }));
        await waitFor(() => expect(api.createGameSession).toHaveBeenCalledOnce());
        expect(api.saveGameSession.mock.lastCall?.[1].state.setup.setup).toMatchObject({
          assignments: { 10: "citizen" },
          players: expect.arrayContaining([{ id: "casper", seat: 10 }]),
        });
        await user.click(screen.getByRole("button", { name: "Draw role for Player 1" }));
        await waitFor(() =>
          expect(
            api.saveGameSession.mock.lastCall?.[1].state.setup.setup.remainingRoles,
          ).toHaveLength(8),
        );
        const savedState = api.saveGameSession.mock.lastCall?.[1].state;
        if (savedBestMove === undefined) {
          // Model an unfinished legacy deal, before any canonical baseline/hash exists.
          delete savedState.setup.bestMoveEnabled;
          delete savedState.setup.rulesEdition;
          delete savedState.setup.setup.rulesEdition;
          delete savedState.setup.clubDeviationsAcknowledged;
        }
        first.unmount();
        window.localStorage.clear();
        api.listActiveGameSessions.mockResolvedValue([
          {
            gameId,
            name: "Saved setup",
            revision: 2,
            hostPlayerId,
            phase: "setup-roles",
            day: 0,
            updatedAt: "2026-09-30T10:00:00.000Z",
          },
        ]);
        api.getGameSession.mockResolvedValue({
          ...remoteSession(gameId, "Saved setup", "Host Player", 2, 0),
          state: savedState,
        });
        renderView(<App />);
        await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
        await user.click(await screen.findByRole("button", { name: "Resume Saved setup" }));
        expect(await screen.findByRole("button", { name: "Casper: citizen" })).toBeDisabled();
        expect(screen.getByText("Draw roles · 8 remaining")).toBeInTheDocument();
        for (const seat of humans.slice(1)) {
          await user.click(
            screen.getByRole("button", { name: `Draw role for ${playerLabel(seat)}` }),
          );
        }
        await user.click(screen.getByRole("button", { name: "Begin Mafia planning stage" }));
        await waitFor(() =>
          expect(gameScreenHarness.liveGame?.players[9]).toMatchObject({
            id: "casper",
            seat: 10,
            role: "citizen",
            team: "red",
          }),
        );
        expect(gameScreenHarness.liveGame?.players[9]).not.toHaveProperty("name");
        expect(gameScreenHarness.liveGame?.bestMoveEnabled).toBe(savedBestMove ?? true);
        await waitFor(() =>
          expect(
            api.saveGameSession.mock.lastCall?.[1].state.initialGame.game.players[9],
          ).toMatchObject({ id: "casper", role: "citizen" }),
        );
        expect(api.createGameSession).toHaveBeenCalledOnce();
        expect(new Set(api.saveGameSession.mock.calls.map(([id]) => id))).toEqual(
          new Set([gameId]),
        );
        const state = api.saveGameSession.mock.lastCall?.[1].state;
        expect(state.initialGame.replayVersion).toBe(savedBestMove === undefined ? 1 : 2);
        expect(replayGameLog(state.initialGame, state.events).game.players[9]).toMatchObject({
          id: "casper",
          role: "citizen",
        });
      } finally {
        cleanup();
        setupMock.mockRestore();
      }
    },
  );

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

  it("persists a real inline-back seat swap and cleared draw across a delayed save and reload on the same game ID", async () => {
    const { SetupWizard: RealSetupWizard } = await vi.importActual<typeof setupWizardModule>(
      "./features/setup/SetupWizard.js",
    );
    const setupMock = vi
      .spyOn(setupWizardModule, "SetupWizard")
      .mockImplementation(RealSetupWizard);
    const selectedIds = assignedGame.players.map(({ id }) => id);
    window.localStorage.setItem(
      `mafia-dashboard.available-player-ids.${testClub.id}`,
      JSON.stringify([...selectedIds, hostPlayerId]),
    );
    const readSaved = () =>
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null");
    const user = userEvent.setup();
    const delayedSave = deferred<{ revision: number; duplicate: boolean }>();
    const previousElementFromPoint = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
    try {
      const first = renderView(<App />);
      await user.click(await screen.findByRole("combobox", { name: "Host player" }));
      await user.click(screen.getByRole("option", { name: "Host Player" }));
      for (const seat of assignedGame.players) {
        await user.click(screen.getByRole("combobox", { name: `Seat ${seat.seat} player` }));
        await user.click(screen.getByRole("option", { name: playerLabel(seat) }));
      }
      await user.click(screen.getByRole("button", { name: "Start game" }));
      await waitFor(() => expect(readSaved()?.gameId).toBe("00000000-0000-4000-8000-000000000090"));
      const gameId = readSaved().gameId as string;
      api.saveGameSession.mockImplementationOnce(() => delayedSave.promise);
      await user.click(screen.getByRole("button", { name: "Draw role for Player 1" }));
      await waitFor(() =>
        expect(readSaved()?.current.state.setup.setup.assignments[1]).toBeDefined(),
      );
      await waitFor(() =>
        expect(
          api.saveGameSession.mock.lastCall?.[1].state.setup.setup.assignments[1],
        ).toBeDefined(),
      );
      const writesWhilePending = api.saveGameSession.mock.calls.length;
      const drawn = readSaved().current.state.setup.setup;
      expect(drawn.remainingRoles).toHaveLength(9);
      await user.click(screen.getByRole("button", { name: "Player setup" }));
      expect(screen.getByRole("combobox", { name: "Seat 1 player" })).toHaveValue("Player 1");
      expect(readSaved().current.state.setup).toMatchObject({
        step: "players",
        setup: { assignments: { 1: drawn.assignments[1] } },
      });

      const source = document.querySelector<HTMLElement>(
        ".setup-seat-card[data-setup-seat='1'] .setup-seat-drag-handle",
      );
      const target = document.querySelector<HTMLElement>(".setup-seat-card[data-setup-seat='2']");
      expect(source).toHaveAccessibleName("Move player in seat 1");
      expect(target).not.toBeNull();
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: vi.fn(() => target),
      });
      const pointer = (type: string, x: number) => {
        const event = new MouseEvent(type, {
          bubbles: true,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: x,
          clientY: 20,
        });
        Object.defineProperties(event, {
          pointerId: { value: 1 },
          pointerType: { value: "mouse" },
          isPrimary: { value: true },
        });
        fireEvent(source!, event);
      };
      pointer("pointerdown", 10);
      pointer("pointermove", 40);
      pointer("pointerup", 40);
      const swappedIds = [selectedIds[1], selectedIds[0], ...selectedIds.slice(2)];
      expect(screen.getByRole("combobox", { name: "Seat 1 player" })).toHaveValue("Player 2");
      expect(screen.getByRole("combobox", { name: "Seat 2 player" })).toHaveValue("Player 1");
      expect(readSaved()).toMatchObject({
        gameId,
        current: {
          state: { setup: { step: "players", selectedPlayerIds: swappedIds, setup: null } },
        },
      });
      expect(api.saveGameSession).toHaveBeenCalledTimes(writesWhilePending);

      await act(async () => delayedSave.resolve({ revision: 2, duplicate: false }));
      await waitFor(() =>
        expect(api.saveGameSession.mock.lastCall?.[1].state.setup).toMatchObject({
          selectedPlayerIds: swappedIds,
          setup: null,
        }),
      );
      expect(new Set(api.saveGameSession.mock.calls.map(([id]) => id))).toEqual(new Set([gameId]));
      first.unmount();
      renderView(<App />);
      await waitFor(() => {
        expect(screen.getByRole("combobox", { name: "Seat 1 player" })).toHaveValue("Player 2");
        expect(screen.getByRole("combobox", { name: "Seat 2 player" })).toHaveValue("Player 1");
      });
      expect(readSaved()).toMatchObject({
        gameId,
        current: {
          state: { setup: { step: "players", selectedPlayerIds: swappedIds, setup: null } },
        },
      });
      await user.click(screen.getByRole("button", { name: "Start game" }));
      expect(screen.getByRole("heading", { name: "Role giveaway" })).toBeInTheDocument();
      expect(readSaved()).toMatchObject({
        gameId,
        current: {
          state: {
            setup: {
              step: "roles",
              selectedPlayerIds: swappedIds,
              setup: {
                players: expect.arrayContaining([{ id: selectedIds[1], seat: 1 }]),
                assignments: {},
              },
            },
          },
        },
      });
      expect(api.createGameSession).toHaveBeenCalledOnce();
      expect(new Set(api.saveGameSession.mock.calls.map(([id]) => id))).toEqual(new Set([gameId]));
    } finally {
      delayedSave.resolve({ revision: 2, duplicate: false });
      if (previousElementFromPoint === undefined)
        Reflect.deleteProperty(document, "elementFromPoint");
      else Object.defineProperty(document, "elementFromPoint", previousElementFromPoint);
      cleanup();
      setupMock.mockRestore();
    }
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

  it("replays a corrected ballot after reload, four fouls and red-card cancellation", async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("heading", { name: "Live test game" });
    const accept = (draft: CanonicalGameEventDraft) => {
      const callback = gameScreenHarness.liveOnAcceptedEvent;
      if (callback === null) throw new Error("Live game callback not captured");
      act(() => callback(draft));
    };
    const live = () => {
      const game = gameScreenHarness.liveGame;
      if (game === null) throw new Error("Live game not captured");
      return game;
    };

    accept({ type: "player.nominated", payload: { nominatorSeat: 1, candidateSeat: 1 } });
    for (let seat = 1; seat <= assignedGame.turnOrder.length; seat += 1) {
      accept({ type: "turn.completed", payload: { seat } });
      if (seat === 1) {
        accept({ type: "player.nominated", payload: { nominatorSeat: 2, candidateSeat: 2 } });
      }
    }
    expect(live().phase).toBe("voting");
    const change = gameScreenHarness.liveOnGameChange;
    if (change === null) throw new Error("Live game mutation callback not captured");
    act(() => change(selectVotingCandidate(live(), 2)));
    act(() => change(toggleVote(live(), 1, 2)));
    act(() => change(selectVotingCandidate(live(), 1)));
    act(() => change(toggleVote(live(), 1, 1)));
    act(() => change(selectVotingCandidate(live(), 2)));
    expect(live().voteAssignments[1]).toBe(1);
    const ballot = live().voteAssignments;
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null")
          ?.current?.state?.game?.voteAssignments,
      ).toEqual(ballot),
    );
    firstRender.unmount();
    render(<App />);
    await screen.findByRole("heading", { name: "Live test game" });
    expect(live().phase).toBe("voting");
    expect(live().voteAssignments).toEqual(ballot);

    for (let foulNumber = 1; foulNumber <= 4; foulNumber += 1) {
      if (foulNumber === 2) {
        const update = gameScreenHarness.liveOnGameChange;
        if (update === null) throw new Error("Live game mutation callback not captured");
        act(() => update(selectVotingCandidate(live(), 1)));
        expect(live().currentTurnIndex).toBe(0);
      }
      if (foulNumber === 3) {
        const update = gameScreenHarness.liveOnGameChange;
        if (update === null) throw new Error("Live game mutation callback not captured");
        act(() => update(selectVotingCandidate(live(), 2)));
      }
      accept({
        type: "foul.issued",
        payload: {
          seat: 4,
          foulNumber,
          redCarded: foulNumber === 4,
          phase: "voting",
          currentTurnIndex: live().currentTurnIndex,
        },
      });
    }
    expect(live().phase).toBe("voting-cancelled");
    expect(live().voteAssignments).toEqual({});
    accept({ type: "phase.changed", payload: { to: "night-mafia" } });
    expect(live().phase).toBe("night-mafia");

    const state = JSON.parse(
      window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null",
    ).current.state as {
      initialGame: InitialGameBaseline;
      events: GameLogEntry[];
      game: GameState;
    };
    const replay = replayGameLog(state.initialGame, state.events);
    expect(replay.game).toEqual(state.game);
    expect(state.events.filter(({ type }) => type === "voting.resolved")).toHaveLength(0);
    expect(
      state.events
        .filter(({ type }) => type === "foul.issued")
        .map(({ phaseBefore }) => phaseBefore),
    ).toEqual(["day", "voting", "voting", "voting"]);
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

  it("replays a deciding night kill, Undoes its win, reapplies it, then locks on explicit Finish", async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("heading", { name: "Live test game" });
    const red = assignedGame.players.filter(({ team }) => team === "red");
    for (const victim of red.slice(0, 3)) {
      act(() =>
        gameScreenHarness.liveOnAcceptedEvent?.({
          type: "player.red-carded",
          payload: { seat: victim.seat },
        }),
      );
    }
    expect(gameScreenHarness.liveGame).toMatchObject({ phase: "day", winner: null });
    for (let turn = 0; gameScreenHarness.liveGame?.phase === "day" && turn < 10; turn += 1) {
      await user.click(screen.getByRole("button", { name: "Record game action" }));
    }
    const endedDay = gameScreenHarness.liveGame;
    expect(endedDay?.phase).toBe("voting-cancelled");
    act(() =>
      gameScreenHarness.liveOnAcceptedEvent?.({
        type: "phase.changed",
        payload: { to: "night-mafia" },
      }),
    );
    const night = gameScreenHarness.liveGame;
    expect(night?.phase).toBe("night-mafia");
    const victim = red[3]!;
    const resolution = resolveMafiaShots(toggleAllMafiaShotsForTarget(night!, victim.seat));
    act(() =>
      gameScreenHarness.liveOnAcceptedEvent?.({
        type: "mafia.shots-resolved",
        payload: { shots: resolution.secretShots, result: resolution.result },
      }),
    );
    expect(gameScreenHarness.liveGame).toMatchObject({ phase: "night-mafia-result", winner: null });
    expect(
      gameScreenHarness.liveGame?.players.find(({ seat }) => seat === victim.seat)?.status,
    ).toBe("active");
    const decide = () =>
      act(() =>
        gameScreenHarness.liveOnAcceptedEvent?.({
          type: "phase.changed",
          payload: { to: "finished" },
        }),
      );
    decide();
    expect(gameScreenHarness.liveGame).toMatchObject({
      phase: "finished",
      winner: "black",
      nightResult: { kind: "kill", targetSeat: victim.seat },
    });
    expect(gameScreenHarness.liveGame?.bestMove).toBeUndefined();
    expect(gameScreenHarness.liveGame?.goodbyeSeats).toBeUndefined();
    expect(screen.getByRole("button", { name: /undo last action.*3 available/i })).toBeEnabled();
    await waitFor(() =>
      expect(api.saveGameSession.mock.calls.at(-1)?.[1]).toMatchObject({
        kind: "snapshot",
        results: null,
        state: expect.objectContaining({ game: expect.objectContaining({ phase: "finished" }) }),
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Saved to server · tap to check connection",
        }),
      ).toBeInTheDocument(),
    );
    firstRender.unmount();
    render(<App />);
    expect(gameScreenHarness.liveGame).toMatchObject({ phase: "finished", winner: "black" });
    expect(screen.getByRole("button", { name: /undo last action.*3 available/i })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /undo last action/i }));
    expect(gameScreenHarness.liveGame).toMatchObject({ phase: "night-mafia-result", winner: null });
    expect(
      gameScreenHarness.liveGame?.players.find(({ seat }) => seat === victim.seat)?.status,
    ).toBe("active");
    decide();
    expect(gameScreenHarness.liveGame).toMatchObject({ phase: "finished", winner: "black" });
    const beforeFinish = JSON.parse(
      window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null",
    );
    expect(beforeFinish.current.results).toBeNull();
    expect(
      replayGameLog(beforeFinish.current.state.initialGame, beforeFinish.current.state.events).game,
    ).toEqual(gameScreenHarness.liveGame);
    expect(
      beforeFinish.current.state.events.filter(
        (event: GameLogEntry) => event.type === "phase.changed" && event.payload.to === "finished",
      ),
    ).toHaveLength(1);
    const heldCompletion = deferred<{ revision: number; duplicate: boolean }>();
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Saved to server · tap to check connection",
        }),
      ).toBeInTheDocument(),
    );
    api.saveGameSession.mockImplementationOnce(() => heldCompletion.promise);
    await user.click(screen.getByRole("button", { name: "Finish the game" }));
    expect(screen.getByRole("button", { name: /undo last action/i })).toBeDisabled();
    const afterFinish = JSON.parse(
      window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null",
    );
    expect(afterFinish.current.results).toMatchObject({ hostPlayerId, winner: "black" });
    expect(
      afterFinish.current.state.events.filter(
        (event: GameLogEntry) => event.type === "game.completed",
      ),
    ).toHaveLength(1);
    expect(afterFinish.outbox).toHaveLength(1);
    const operation = api.saveGameSession.mock.calls.at(-1)?.[1];
    if (operation === undefined) throw new Error("Completion upload was not started");
    heldCompletion.resolve({ revision: operation.baseRevision + 1, duplicate: false });
    expect(await screen.findByRole("button", { name: "Start test game" })).toBeInTheDocument();
  });

  it("retains acknowledged federation setup deviations after the real role draw completes and reloads", async () => {
    const gameScreenSpy = vi.spyOn(gameScreenModule, "GameScreen");
    const { SetupWizard: RealSetupWizard } = await vi.importActual<typeof setupWizardModule>(
      "./features/setup/SetupWizard.js",
    );
    const setupMock = vi
      .spyOn(setupWizardModule, "SetupWizard")
      .mockImplementation(RealSetupWizard);
    let setup = beginRoleDraw(
      createSetup(
        assignedGame.players.map(({ id, seat }) => ({ id, seat })),
        { rulesEdition: FEDERATION_RULES_EDITION },
      ),
      createSeededRandom(13),
    );
    for (const player of assignedGame.players)
      setup = assignRoleForSeat(setup, player.seat, player.role);
    const savedSetup: SetupWizardSessionState = {
      step: "roles",
      hostPlayerId,
      selectedPlayerIds: assignedGame.players.map(({ id }) => id),
      setup,
      rulesEdition: FEDERATION_RULES_EDITION,
      bestMoveEnabled: true,
      clubDeviationsAcknowledged: ["role-reroll"],
    };
    const outbox = new GameSessionOutbox({
      storage: window.localStorage,
      clubId: testClub.id,
      createId: () => crypto.randomUUID(),
      save: vi.fn(),
    });
    outbox.activateRemote({
      ...remoteSession("00000000-0000-4000-8000-000000000399", "Federation setup", "Host", 1, 1),
      state: { ...browserSessionState(""), setup: savedSetup, hostPlayerId },
    });
    try {
      const user = userEvent.setup();
      const first = render(<App />);
      await user.click(await screen.findByRole("button", { name: "Begin Mafia planning stage" }));
      await waitFor(() =>
        expect(api.saveGameSession.mock.lastCall?.[1].state.game?.rulesEdition).toBe(
          FEDERATION_RULES_EDITION,
        ),
      );
      const state = api.saveGameSession.mock.lastCall![1].state;
      expect(state.setup).toEqual(savedSetup);
      expect(state.initialGame.replayVersion).toBe(2);
      expect(replayGameLog(state.initialGame, state.events).game).toEqual(state.game);
      first.unmount();
      render(<App />);
      expect(
        JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5")!).current.state
          .setup,
      ).toEqual(savedSetup);
      expect(gameScreenHarness.liveGame?.rulesEdition).toBe(FEDERATION_RULES_EDITION);
      expect(gameScreenSpy.mock.lastCall?.[0]).not.toHaveProperty("clubDeviationsAcknowledged");
    } finally {
      cleanup();
      setupMock.mockRestore();
    }
  });

  it("persists real card selections and applies Developer appearance live without changing history", async () => {
    const { GameScreen } = await vi.importActual<typeof gameScreenModule>(
      "./features/game/GameScreen.js",
    );
    vi.spyOn(gameScreenModule, "GameScreen").mockImplementation(GameScreen);
    let state = federationGame();
    while (state.phase !== "day") state = advanceSetupPhase(state);
    restoreFederationCheckpoint(state);
    const user = userEvent.setup();
    const first = render(<App />);
    const card = (seat: number) =>
      document.querySelector<HTMLButtonElement>(
        `.seat-anchor[data-seat="${seat}"] > .player-seat`,
      )!;
    const saved = () =>
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5")!).current.state;
    await user.click(await screen.findByRole("button", { name: "Nominate Player 7" }));
    await user.click(screen.getByRole("button", { name: "Next player" }));
    await user.click(card(7));
    await user.click(card(8));
    const countBeforeIgnoredTap = saved().events.length;
    await user.click(card(9));
    expect(saved().events).toHaveLength(countBeforeIgnoredTap);
    fireEvent.keyDown(card(7), { key: "f" });
    await user.click(card(7));
    await user.click(card(7));
    await waitFor(() =>
      expect(saved().game.nominations).toEqual([
        { nominatorSeat: 1, candidateSeat: 7, order: 1, supporterSeats: [2] },
        { nominatorSeat: 2, candidateSeat: 8, order: 2 },
      ]),
    );
    const beforeAppearance = saved();
    expect(beforeAppearance.game.players.find((p: { seat: number }) => p.seat === 7).fouls).toBe(1);
    expect(replayGameLog(beforeAppearance.initialGame, beforeAppearance.events).game).toEqual(
      beforeAppearance.game,
    );
    expect(
      beforeAppearance.events.filter(
        (e: { type: string }) => e.type === "nomination.selection-set",
      ),
    ).toHaveLength(5);
    await user.click(screen.getByRole("button", { name: "Open developer menu" }));
    await user.click(screen.getByText("Glass", { selector: "summary" }));
    fireEvent.change(screen.getByLabelText("Nomination tint"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Nomination color"), { target: { value: "#88c7e3" } });
    await user.selectOptions(screen.getByLabelText("Nomination icon"), "flag");
    await user.selectOptions(screen.getByLabelText("Support icon"), "thumbs-up");
    await user.selectOptions(screen.getByLabelText("Nomination treatment"), "tint");
    expect(card(7).querySelector(".lucide-flag")).not.toBeNull();
    expect(card(7).querySelector(".lucide-thumbs-up")).not.toBeNull();
    expect(document.querySelector(".app-shell")).toHaveStyle(
      "--card-nomination-color: #88c7e3; --card-nomination-tint: 0",
    );
    expect(saved().events).toEqual(beforeAppearance.events);
    expect(saved().game).toEqual(beforeAppearance.game);
    first.unmount();
    render(<App />);
    await waitFor(() => expect(card(7)).toHaveAttribute("aria-pressed", "true"));
    expect(card(7).querySelector(".lucide-flag")).not.toBeNull();
    expect(card(7).querySelector(".card-support")).toHaveTextContent("+1");
    expect(saved().events).toEqual(beforeAppearance.events);
    await user.click(screen.getByRole("button", { name: "Open game log" }));
    const logDrawer = screen.getByRole("dialog", { name: "Game log" });
    expect(
      within(logDrawer).getAllByText("Nomination selections: 2 candidates", { selector: "strong" }),
    ).toHaveLength(1);
    expect(logDrawer).toHaveTextContent("Additional supporters (+1): #2 Player 2");
    expect(logDrawer).not.toHaveTextContent("nomination.selection-set");
    expect(within(logDrawer).getByText("Foul issued", { selector: "strong" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide private info" }));
    expect(logDrawer).not.toHaveTextContent("Additional supporters");
    await user.click(screen.getByRole("button", { name: "Show private info" }));
    const summary = within(logDrawer)
      .getByText("Nomination selections: 2 candidates", { selector: "strong" })
      .closest("article")!;
    await user.click(within(summary).getByRole("button", { name: /Preview state after log/ }));
    expect(screen.getByRole("heading", { name: "Zero round · Preview" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Seat 7: Player 7" })).toBeInTheDocument();
    expect(document.querySelector('.seat-anchor[data-seat="7"] .card-support')).toHaveTextContent(
      "+1",
    );
    expect(saved().events).toEqual(beforeAppearance.events);
  });

  it("persists real federation speaker progression before fouls and ordered voting", async () => {
    const { GameScreen } = await vi.importActual<typeof gameScreenModule>(
      "./features/game/GameScreen.js",
    );
    vi.spyOn(gameScreenModule, "GameScreen").mockImplementation(GameScreen);
    let state = federationGame();
    for (let step = 0; step < 5; step += 1) state = advanceSetupPhase(state);
    restoreFederationCheckpoint(state);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Nominate Player 4" }));
    await user.click(screen.getByRole("button", { name: "Next player" }));
    await waitFor(() =>
      expect(api.saveGameSession.mock.lastCall?.[1].state.game.currentTurnIndex).toBe(1),
    );
    fireEvent.keyDown(document.querySelector('.seat-anchor[data-seat="2"] > .player-seat')!, {
      key: "f",
    });
    await user.click(screen.getByRole("button", { name: "Nominate Player 5" }));
    for (let step = 0; step < 8; step += 1)
      await user.click(screen.getByRole("button", { name: "Next player" }));
    await user.click(screen.getByRole("button", { name: "Begin voting" }));
    await user.click(screen.getByRole("button", { name: "Vote as Player 1 for Player 4" }));
    await waitFor(() =>
      expect(api.saveGameSession.mock.lastCall?.[1].state.events.at(-1).type).toBe("vote.recorded"),
    );
    const saved = api.saveGameSession.mock.lastCall![1].state;
    expect(saved.game.phase).toBe("voting");
    expect(saved.game.players[1].fouls).toBe(1);
    expect(
      saved.events.filter((event: GameLogEntry) => event.type === "turn.completed"),
    ).toHaveLength(10);
    expect(replayGameLog(saved.initialGame, saved.events).game).toEqual(saved.game);
    cleanup();
    render(<App />);
    expect(await screen.findByRole("button", { name: "Player 1 voted for seat 4" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /undo last action/i }));
    expect(screen.getByRole("button", { name: "Vote as Player 1 for Player 4" })).toBeEnabled();
    await waitFor(() =>
      expect(api.saveGameSession.mock.lastCall?.[1].state.headEventId).not.toBe(saved.headEventId),
    );
    const undone = api.saveGameSession.mock.lastCall![1].state;
    expect(replayGameLog(undone.initialGame, undone.events).game).toEqual(undone.game);
  });

  it.each([0, 2])(
    "persists real federation Best Move entry before accepting %s numbers and finalizing",
    async (count) => {
      const { GameScreen } = await vi.importActual<typeof gameScreenModule>(
        "./features/game/GameScreen.js",
      );
      vi.spyOn(gameScreenModule, "GameScreen").mockImplementation(GameScreen);
      let state = federationGame();
      for (let step = 0; step < 5; step += 1) state = advanceSetupPhase(state);
      state = skipSheriffCheck(
        skipDonCheck(
          completeMafiaShots(
            resolveMafiaShots(toggleAllMafiaShotsForTarget(beginNight(state), 2)).game,
          ),
        ),
      );
      expect(state.phase).toBe("night-resolution");
      restoreFederationCheckpoint(state);
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole("button", { name: "Record Best Move" }));
      await waitFor(() =>
        expect(api.saveGameSession.mock.lastCall?.[1].state.game.phase).toBe("best-move"),
      );
      for (let seat = 1; seat <= count; seat += 1)
        await user.click(screen.getByRole("button", { name: `Accept number ${seat}` }));
      await user.click(
        screen.getByRole("checkbox", { name: "Numbers read back and accepted; player sleeps" }),
      );
      await user.click(
        screen.getByRole("button", { name: count === 0 ? "Skip Best Move" : "Finish early" }),
      );
      await waitFor(() =>
        expect(api.saveGameSession.mock.lastCall?.[1].state.game.bestMove.completionReason).toBe(
          count === 0 ? "declined" : "finished-early",
        ),
      );
      const saved = api.saveGameSession.mock.lastCall![1].state;
      expect(saved.game.phase).toBe("night-resolution");
      expect(saved.game.bestMove.selectedSeats).toEqual(count === 0 ? [] : [1, 2]);
      expect(saved.game.bestMoveEnabled).toBe(true);
      expect(replayGameLog(saved.initialGame, saved.events).game).toEqual(saved.game);
      cleanup();
      render(<App />);
      expect(await screen.findByRole("button", { name: "Announce morning" })).toBeEnabled();
      await user.click(screen.getByRole("button", { name: /undo last action/i }));
      expect(
        screen.getByRole("button", { name: count === 0 ? "Skip Best Move" : "Finish early" }),
      ).toBeDisabled();
      await waitFor(() =>
        expect(api.saveGameSession.mock.lastCall?.[1].state.game.phase).toBe("best-move"),
      );
      const undone = api.saveGameSession.mock.lastCall![1].state;
      expect(undone.game.bestMove.selectedSeats).toEqual(count === 0 ? [] : [1, 2]);
      expect(replayGameLog(undone.initialGame, undone.events).game).toEqual(undone.game);
      await user.click(
        screen.getByRole("checkbox", { name: "Numbers read back and accepted; player sleeps" }),
      );
      await user.click(
        screen.getByRole("button", { name: count === 0 ? "Skip Best Move" : "Finish early" }),
      );
      await user.click(screen.getByRole("button", { name: "Announce morning" }));
      await waitFor(() =>
        expect(api.saveGameSession.mock.lastCall?.[1].state.game.phase).toBe("goodbye-speech"),
      );
      const morning = api.saveGameSession.mock.lastCall![1].state;
      expect(replayGameLog(morning.initialGame, morning.events).game).toEqual(morning.game);
    },
  );

  it("records side-panel federation selection without inventing ceremonial observations", async () => {
    let state = federationGame();
    for (let step = 0; step < 5; step += 1) state = advanceSetupPhase(state);
    state = startVoting({
      ...state,
      nominations: [
        { nominatorSeat: 1, candidateSeat: 1, order: 1 },
        { nominatorSeat: 2, candidateSeat: 2, order: 2 },
      ],
    });
    const outbox = new GameSessionOutbox({
      storage: window.localStorage,
      clubId: testClub.id,
      createId: () => crypto.randomUUID(),
      save: vi.fn(),
    });
    outbox.activateRemote({
      ...remoteSession("00000000-0000-4000-8000-000000000399", "Federation ballot", "Host", 1, 1),
      state: {
        ...browserSessionState(""),
        game: state,
        hostPlayerId,
        initialGame: createInitialGameBaseline(state),
      },
    });
    const user = userEvent.setup();
    render(<App />);
    act(() => gameScreenHarness.liveOnAcceptedEvent?.({ type: "game.checkpointed", payload: {} }));
    await user.click(
      within(screen.getByRole("region", { name: "Voting order" })).getByRole("button", {
        name: /^#2 /,
      }),
    );
    expect(gameScreenHarness.liveGame).toMatchObject({
      ballot: { selectedCandidateSeat: 2 },
      currentTurnIndex: 0,
    });
    await waitFor(() =>
      expect(
        api.saveGameSession.mock.calls.some(([, operation]) =>
          operation.state.events?.some(
            (event: GameLogEntry) => event.type === "voting.candidate-selected",
          ),
        ),
      ).toBe(true),
    );
    const saved = api.saveGameSession.mock.calls.find(([, operation]) =>
      operation.state.events?.some(
        (event: GameLogEntry) => event.type === "voting.candidate-selected",
      ),
    )![1];
    expect(replayGameLog(saved.state.initialGame, saved.state.events).game).toEqual(
      saved.state.game,
    );
  });

  it("finishes an automatic federation draw without inventing a manual draw event", async () => {
    let state = federationGame();
    for (let step = 0; step < 5; step += 1) state = advanceSetupPhase(state);
    const quietNight = (game: GameState) =>
      skipSheriffCheck(skipDonCheck(completeMafiaShots(resolveMafiaShots(beginNight(game)).game)));
    state = quietNight(completeNight(quietNight(state)));
    expect(state).toMatchObject({ phase: "night-resolution", completedGameNights: 2 });
    const outbox = new GameSessionOutbox({
      storage: window.localStorage,
      clubId: testClub.id,
      createId: () => crypto.randomUUID(),
      save: vi.fn(),
    });
    outbox.activateRemote({
      ...remoteSession("00000000-0000-4000-8000-000000000399", "Federation draw", "Host", 1, 1),
      state: {
        ...browserSessionState(""),
        game: state,
        hostPlayerId,
        initialGame: createInitialGameBaseline(state),
      },
    });
    const user = userEvent.setup();
    render(<App />);
    act(() => gameScreenHarness.liveOnAcceptedEvent?.({ type: "game.checkpointed", payload: {} }));
    act(() =>
      gameScreenHarness.liveOnAcceptedEvent?.({ type: "phase.changed", payload: { to: "draw" } }),
    );
    expect(gameScreenHarness.liveGame).toMatchObject({
      phase: "draw",
      rulesDrawReason: { rule: "6.5.6" },
    });
    await user.click(screen.getByRole("button", { name: "Finish the game" }));
    await waitFor(() =>
      expect(
        api.saveGameSession.mock.calls.some(
          ([, operation]) => operation.results?.outcome === "draw",
        ),
      ).toBe(true),
    );
    const saved = api.saveGameSession.mock.calls.find(
      ([, operation]) => operation.results?.outcome === "draw",
    )![1];
    expect(saved.results.reason).toBe(
      "MAFGAME 6.5.6: three consecutive game nights without a departure",
    );
    expect(saved.state.events.some((event: GameLogEntry) => event.type === "game.drawn")).toBe(
      false,
    );
    expect(replayGameLog(saved.state.initialGame, saved.state.events).game).toEqual(
      saved.state.game,
    );
  });

  it("keeps the gesture-opened ballot review open through its acknowledged commands", async () => {
    const { GameScreen } = await vi.importActual<typeof gameScreenModule>(
      "./features/game/GameScreen.js",
    );
    vi.spyOn(gameScreenModule, "GameScreen").mockImplementation(GameScreen);
    let game = federationGame();
    while (game.phase !== "day") game = advanceSetupPhase(game);
    game = startVoting({
      ...game,
      nominations: [2, 3].map((seat, index) => ({
        nominatorSeat: index + 1,
        candidateSeat: seat,
        order: index + 1,
      })),
    });
    game = applyGameEvent(game, {
      type: "voting.candidate-selected",
      payload: { candidateSeat: 2 },
    });
    restoreFederationCheckpoint(game);
    const user = userEvent.setup();
    render(<App />);
    const card = await screen.findByRole("button", { name: "Vote as Player 1 for Player 2" });
    card.focus();
    fireEvent.touchStart(card, { touches: [{ clientX: 100, clientY: 180 }] });
    fireEvent.touchEnd(card, { changedTouches: [{ clientX: 100, clientY: 100 }] });
    const judge = screen.getByRole("dialog");
    await user.click(screen.getByText("Dispute count", { exact: true }));
    await user.type(screen.getByLabelText("Dispute reason"), "Review this count");
    await user.click(screen.getByRole("button", { name: "Pause voting for review" }));
    expect(judge).toBeVisible();
    expect(screen.getByRole("button", { name: "Accept final reviewed count" })).toBeDisabled();
    await user.type(screen.getByLabelText("Final ruling reason"), "Count confirmed");
    await user.click(screen.getByLabelText("I reviewed the external recording"));
    await user.click(screen.getByRole("button", { name: "Accept final reviewed count" }));
    expect(judge).toBeVisible();
    await waitFor(() =>
      expect(api.saveGameSession.mock.lastCall?.[1].state.events.at(-1).type).toBe(
        "voting.count-ruled",
      ),
    );
    const saved = api.saveGameSession.mock.lastCall![1].state;
    expect(replayGameLog(saved.initialGame, saved.events).game).toEqual(saved.game);
    await user.click(within(judge).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["red", "black"] as const)(
    "preserves a %s losing-team ruling through Finish and canonical replay",
    async (losingTeam) => {
      const { GameScreen } = await vi.importActual<typeof gameScreenModule>(
        "./features/game/GameScreen.js",
      );
      vi.spyOn(gameScreenModule, "GameScreen").mockImplementation(GameScreen);
      const state = federationGame();
      const offender = state.players.find((player) => player.team === losingTeam)!;
      restoreFederationCheckpoint(state);
      const user = userEvent.setup();
      render(<App />);
      await screen.findByRole("button", { name: "Rules" });
      const card = document.querySelector<HTMLElement>(
        `[data-seat="${offender.seat}"] .player-seat`,
      )!;
      card.focus();
      fireEvent.touchStart(card, { touches: [{ clientX: 100, clientY: 180 }] });
      fireEvent.touchEnd(card, { changedTouches: [{ clientX: 100, clientY: 100 }] });
      await user.selectOptions(screen.getByLabelText("Discipline action"), "opponent-victory");
      await user.type(screen.getByLabelText("Judge's reason"), "Verified violation");
      await user.click(screen.getByRole("button", { name: "Award victory to opposing team" }));
      await waitFor(() =>
        expect(api.saveGameSession.mock.lastCall?.[1].state.game.phase).toBe("finished"),
      );
      const ruled = api.saveGameSession.mock.lastCall![1].state.game;
      expect(ruled).toMatchObject({
        phase: "finished",
        winner: losingTeam === "red" ? "black" : "red",
        adjudication: { losingTeam, rule: "6.3.1", reason: "Verified violation" },
      });
      expect(ruled.players).toEqual(state.players);
      await user.click(screen.getByRole("button", { name: "Finish the game" }));
      await waitFor(() =>
        expect(
          api.saveGameSession.mock.calls.some(
            ([, operation]) => operation.results?.adjudication?.losingTeam === losingTeam,
          ),
        ).toBe(true),
      );
      const saved = api.saveGameSession.mock.calls.find(
        ([, operation]) => operation.results?.adjudication?.losingTeam === losingTeam,
      )![1];
      expect(saved.results).toMatchObject({
        outcome: losingTeam === "red" ? "black" : "red",
        reason: null,
        adjudication: { losingTeam, reason: "Verified violation" },
      });
      expect(replayGameLog(saved.state.initialGame, saved.state.events).game).toEqual(
        saved.state.game,
      );
    },
  );

  it("stores final results and returns to the initial setup after Finish the game", async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await screen.findByRole("heading", { name: "Live test game" });
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalled());
    api.saveGameSession.mockClear();

    await user.click(screen.getByRole("button", { name: "Finish test game" }));
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalled());
    expect(api.saveGameSession.mock.calls.at(-1)?.[1]).toMatchObject({
      kind: "snapshot",
      results: null,
      state: expect.objectContaining({
        game: expect.objectContaining({ phase: "finished" }),
        events: expect.arrayContaining([
          expect.objectContaining({ phaseAfter: "finished", type: "player.red-carded" }),
        ]),
      }),
    });
    expect(screen.getByRole("button", { name: /undo last action.*3 available/i })).toBeEnabled();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Saved to server · tap to check connection" }),
      ).toBeInTheDocument(),
    );
    firstRender.unmount();
    render(<App />);
    expect(gameScreenHarness.liveGame).toMatchObject({ phase: "finished", winner: "red" });
    expect(screen.getByRole("button", { name: /undo last action.*3 available/i })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /undo last action/i }));
    expect(gameScreenHarness.liveGame).toMatchObject({ phase: "day", winner: null });
    const remainingMafia = gameScreenHarness.liveGame?.players.find(
      ({ team, status }) => team === "black" && status === "active",
    );
    if (remainingMafia === undefined) throw new Error("Undo did not restore a Mafia player");
    act(() =>
      gameScreenHarness.liveOnAcceptedEvent?.({
        type: "player.red-carded",
        payload: { seat: remainingMafia.seat },
      }),
    );
    expect(gameScreenHarness.liveGame).toMatchObject({ phase: "finished", winner: "red" });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Saved to server · tap to check connection" }),
      ).toBeInTheDocument(),
    );

    const heldCompletion = deferred<{ revision: number; duplicate: boolean }>();
    api.saveGameSession.mockImplementationOnce(() => heldCompletion.promise);
    const finish = gameScreenHarness.liveOnFinishGame;
    if (finish === null) throw new Error("Finish callback was not captured");
    await user.click(screen.getByRole("button", { name: "Finish the game" }));
    act(() => finish());
    expect(screen.getByRole("button", { name: /undo last action/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Saving game…" })).toBeDisabled();
    const pendingCompletion = JSON.parse(
      window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null",
    );
    expect(
      pendingCompletion.current.state.events.filter(
        (entry: GameLogEntry) => entry.type === "game.completed",
      ),
    ).toHaveLength(1);
    expect(pendingCompletion.outbox).toHaveLength(1);
    await waitFor(() =>
      expect(api.saveGameSession.mock.calls.at(-1)?.[1]).toMatchObject({
        kind: "snapshot",
        results: expect.objectContaining({ hostPlayerId, winner: "red" }),
        state: expect.objectContaining({
          events: expect.arrayContaining([expect.objectContaining({ type: "game.completed" })]),
        }),
      }),
    );
    const heldOperation = api.saveGameSession.mock.calls.at(-1)?.[1];
    if (heldOperation === undefined) throw new Error("Completion upload was not started");
    heldCompletion.resolve({ revision: heldOperation.baseRevision + 1, duplicate: false });
    expect(await screen.findByRole("button", { name: "Start test game" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Game safely saved" })).not.toBeInTheDocument();
  });

  it.each([
    ["game.drawn", "draw", "Three quiet cycles"],
    ["game.cancelled", "cancelled", "Venue closed"],
  ] as const)(
    "keeps %s pending through reload and Undo, then locks on Finish through a rejected save and retry",
    async (type, outcome, reason) => {
      const user = userEvent.setup();
      const firstRender = render(<App />);
      await user.click(screen.getByRole("button", { name: "Start test game" }));
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Saved to server · tap to check connection" }),
        ).toBeInTheDocument(),
      );
      api.saveGameSession.mockClear();

      act(() => gameScreenHarness.liveOnAcceptedEvent?.({ type, payload: { reason } }));
      await waitFor(() =>
        expect(api.saveGameSession.mock.calls.at(-1)?.[1]).toMatchObject({
          kind: "snapshot",
          results: null,
          state: expect.objectContaining({
            game: expect.objectContaining({ phase: outcome }),
            events: [
              expect.objectContaining({ type: "game.checkpointed" }),
              expect.objectContaining({ type, payload: { reason } }),
            ],
          }),
        }),
      );
      expect(screen.getByRole("button", { name: /undo last action.*1 available/i })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Finish the game" })).toBeEnabled();
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Saved to server · tap to check connection" }),
        ).toBeInTheDocument(),
      );
      firstRender.unmount();
      const secondRender = render(<App />);
      expect(gameScreenHarness.liveGame).toMatchObject({ phase: outcome, winner: null });
      expect(screen.getByRole("button", { name: /undo last action.*1 available/i })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Finish the game" })).toBeEnabled();

      await user.click(screen.getByRole("button", { name: /undo last action/i }));
      expect(gameScreenHarness.liveGame).toMatchObject({ phase: "day", winner: null });
      const undone = JSON.parse(
        window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null",
      );
      expect(undone.current.results).toBeNull();
      expect(undone.current.state.events).toEqual([
        expect.objectContaining({ type: "game.checkpointed" }),
      ]);
      expect(undone.current.state.resetReturnEventId).toBeNull();
      expect(screen.getByRole("button", { name: /undo last action.*0 available/i })).toBeDisabled();

      act(() => gameScreenHarness.liveOnAcceptedEvent?.({ type, payload: { reason } }));
      expect(screen.getByRole("button", { name: /undo last action.*1 available/i })).toBeEnabled();
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Saved to server · tap to check connection" }),
        ).toBeInTheDocument(),
      );
      api.saveGameSession.mockRejectedValue(new ApiError("save rejected", 400, "invalid"));
      const finish = gameScreenHarness.liveOnFinishGame;
      if (finish === null) throw new Error("Finish callback was not captured");
      await user.click(screen.getByRole("button", { name: "Finish the game" }));
      act(() => finish());
      expect(screen.getByRole("button", { name: /undo last action/i })).toBeDisabled();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /^Save blocked ·/ })).toBeInTheDocument(),
      );
      expect(screen.getByRole("button", { name: "Game upload blocked" })).toBeDisabled();
      await user.click(screen.getByRole("button", { name: "Open game log" }));
      await user.click(screen.getByRole("button", { name: "Preview state after log #1" }));
      expect(screen.getByRole("button", { name: "Reset game to this state" })).toBeDisabled();
      await user.click(screen.getByRole("button", { name: "Exit preview" }));
      const persisted = JSON.parse(
        window.localStorage.getItem("mafia-dashboard.game-session.v5") ?? "null",
      );
      expect(persisted.current.results).toMatchObject({ outcome, winner: null, reason });
      expect(persisted.current.state.events.map((entry: GameLogEntry) => entry.type)).toEqual([
        "game.checkpointed",
        type,
      ]);
      expect(persisted.outbox).toEqual([
        expect.objectContaining({
          results: expect.objectContaining({ outcome, winner: null, reason }),
        }),
      ]);

      secondRender.unmount();
      render(<App />);
      expect(gameScreenHarness.liveGame).toMatchObject({ phase: outcome, winner: null });
      expect(screen.getByRole("button", { name: /undo last action/i })).toBeDisabled();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Game upload blocked" })).toBeDisabled(),
      );
      api.saveGameSession.mockImplementation(
        (_gameId: string, operation: { baseRevision: number }) =>
          Promise.resolve({ revision: operation.baseRevision + 1, duplicate: false }),
      );
      await user.click(screen.getByRole("button", { name: /^Save blocked ·/ }));
      expect(await screen.findByRole("button", { name: "Start test game" })).toBeInTheDocument();
      const completionAttempts = api.saveGameSession.mock.calls.filter(
        ([, operation]) => operation.results !== null,
      );
      expect(new Set(completionAttempts.map(([, operation]) => operation.mutationId)).size).toBe(1);
      expect(window.localStorage.getItem("mafia-dashboard.game-session.v5")).toBeNull();
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
        hostPlayerId,
        phase: "day",
        day: 2,
        updatedAt: "2026-08-18T08:00:00.000Z",
      },
      {
        gameId: sessionBId,
        name: "Table B",
        revision: 7,
        hostPlayerId,
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
    await screen.findByText("Host: Host Player");
    sessionA.resolve(remoteSession(sessionAId, "Table A", "Host A", 4, 2));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("Host: Host Player")).toBeInTheDocument();
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
        hostPlayerId,
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
    expect(await screen.findByText("Host: Host Player")).toBeInTheDocument();
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
    await user.click(await screen.findByRole("button", { name: "Music player panel handle" }));
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

  it("keeps failed creation recoverable instead of parking it when New game is requested", async () => {
    const user = userEvent.setup();
    const firstCreate = deferred<{ revision: number; duplicate: boolean }>();
    api.saveGameSession.mockImplementationOnce(() => firstCreate.promise);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Enter role giveaway" }));
    await waitFor(() => expect(api.createGameSession).toHaveBeenCalledOnce());
    const pending = JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5")!);
    expect(pending).toMatchObject({ gameId: null, creationId: expect.any(String) });

    await user.click(screen.getByRole("button", { name: "Open Manage menu" }));
    await user.click(screen.getByRole("button", { name: "Start new game" }));
    expect(confirm).toHaveBeenCalledWith(
      "Start a new game? The current game will stay saved and can be resumed later.",
    );
    expect(api.clearGameSession).not.toHaveBeenCalled();
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5")!),
    ).toMatchObject({
      gameId: null,
      creationId: pending.creationId,
      current: pending.current,
    });
    expect(
      [...Array(window.localStorage.length).keys()]
        .map((index) => window.localStorage.key(index))
        .some((key) => key?.includes(".parked.")),
    ).toBe(false);
    await act(async () => {
      firstCreate.reject(new TypeError("Failed to fetch"));
    });
    expect(
      JSON.parse(window.localStorage.getItem("mafia-dashboard.game-session.v5")!),
    ).toMatchObject({
      gameId: null,
      creationId: pending.creationId,
      current: pending.current,
      failed: true,
    });
    expect(screen.getByRole("heading", { name: "Role giveaway" })).toBeInTheDocument();
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
    await screen.findByText("Host: Host Player");
    clear.resolve();
    await act(async () => {
      await clear.promise;
      await Promise.resolve();
    });
    expect(screen.getByText("Host: Host Player")).toBeInTheDocument();
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
  _restoredHostName: string,
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
      ...assignedGame.players.map((seat) => player(playerLabel(seat), seat.id)),
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

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import webPackage from "../package.json";
import {
  applyGameEvent,
  createGameLogEntry,
  hashGameState,
  isMeaningfulGameEventDraft,
  isTerminalGamePhase,
  replayGameLog,
  type CanonicalGameEventDraft,
  type GameLogEntry,
  type GameState,
  type InitialGameBaseline,
} from "@mafia/game-domain";
import {
  Bird,
  DoorOpen,
  Eye,
  EyeOff,
  ListTree,
  Maximize2,
  Minimize2,
  Save,
  SlidersHorizontal,
  Undo2,
  Wrench,
} from "lucide-react";
import {
  ApiError,
  checkServerReady,
  claimGameSession,
  clearGameSession,
  createPlayer,
  deletePlayer,
  getAuthSession,
  getGameSession,
  listActiveGameSessions,
  listPlayers,
  saveGameSession,
  saveGameSessionOperation,
  updatePlayer,
  createClub,
  deleteClub,
  listClubs,
  signOut,
  takeoverGameSession,
  releaseGameSession,
  updateClub,
} from "./api/client.js";
import type {
  ActiveGameSessionSummary,
  FinalGameResults,
  GameSessionState,
  GameSessionClaimCredential,
  PlayerProfile,
  PlayerProfileInput,
  RemoteGameSession,
  Club,
  ClubInput,
  ClubUpdateInput,
  AppUser,
} from "./api/client.js";
import { ClubPortal } from "./features/clubs/ClubPortal.js";
import { ErrorConsoleScreen } from "./features/console/ErrorConsoleScreen.js";
import { clearErrorConsole, reportError } from "./features/console/error-console.js";
import { CanaryFirework } from "./features/effects/CanaryFirework.js";
import {
  createLightingRendererState,
  LightingRendererContext,
  lightingRendererReducer,
} from "./features/effects/LightingRendererContext.js";
import {
  writeLightingRenderer,
  writePlayerLightingEnabled,
  type LightingRenderer,
} from "./features/effects/lighting-preferences.js";
import { VgpuLightingProvider } from "./features/effects/vgpu/VgpuLightingProvider.js";
import { GameScreen } from "./features/game/GameScreen.js";
import { isCriticalState } from "./features/game/critical-state.js";
import { LiveSidePanel } from "./features/game/LiveSidePanel.js";
import {
  getActiveBranch,
  getRemainingUndoBudget,
  getUndoableEvents,
  replayToEvent,
} from "./features/game/game-history.js";
import { AccountPlaylistPicker } from "./features/music/AccountPlaylistPicker.js";
import { MusicDock } from "./features/music/MusicDock.js";
import {
  readMusicPreferences,
  selectRememberedPlaylist,
  writeMusicPreferences,
  type MusicPreferencesV1,
} from "./features/music/music-preferences.js";
import {
  YouTubePlaylistPlayer,
  type YouTubePlaybackState,
  type YouTubePlayerHandle,
} from "./features/music/YouTubePlaylistPlayer.js";
import { PlayersScreen } from "./features/players/PlayersScreen.js";
import { buildFinalGameResults } from "./features/players/game-results.js";
import { SetupWizard, type SetupWizardSessionState } from "./features/setup/SetupWizard.js";
import { AvailablePlayersScreen } from "./features/setup/AvailablePlayersScreen.js";
import { GameTimelineScreen } from "./features/timeline/GameTimelineScreen.js";
import { useMessages, type FeatureI18n, type Locale } from "./i18n/I18nProvider.js";
import { LanguageSelector } from "./i18n/LanguageSelector.js";
import { shellMessages, type ShellMessageKey } from "./i18n/messages/shell.js";

import { GameSessionClaimController } from "./session-claim.js";
import { GameSessionOutbox } from "./session-outbox.js";
import { SessionRetryController } from "./session-retry.js";
import { createRandomId } from "./utils/random-id.js";
import { applyThemeColor, DEFAULT_THEME_COLOR, readThemeColor } from "./theme.js";
import "./styles/app.css";
import "./styles/clubs.css";
import "./styles/timeline.css";

interface LocalLogEntry {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly phase: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

type BackgroundShade = "black" | "grey-33" | "grey-66" | "white";
type WorkspaceView = "game" | "players" | "timeline" | "console";
type PlayerGateError = Readonly<{
  readonly key: "addRegisteredPlayers" | "markAvailablePlayers";
  readonly count: number;
}>;

const backgroundShadeOrder: readonly BackgroundShade[] = ["black", "grey-33", "grey-66", "white"];
const backgroundShadeClass: Record<BackgroundShade, string> = {
  black: "",
  "grey-33": " is-background-grey-33",
  "grey-66": " is-background-grey-66",
  white: " is-light-background",
};
const backgroundShadeMessageKey: Record<
  BackgroundShade,
  "backgroundBlack" | "backgroundGrey33" | "backgroundGrey66" | "backgroundWhite"
> = {
  black: "backgroundBlack",
  "grey-33": "backgroundGrey33",
  "grey-66": "backgroundGrey66",
  white: "backgroundWhite",
};
type ShellTranslator = FeatureI18n<ShellMessageKey>["t"];
const phaseMessageKeys: Readonly<Record<string, ShellMessageKey>> = {
  "setup-players": "phaseSetupPlayers",
  "mafia-planning": "phaseMafiaPlanning",
  "sheriff-wake": "phaseSheriffWake",
  day: "phaseDay",
  voting: "phaseVoting",
  "voting-cancelled": "phaseVotingCancelled",
  "car-crash": "phaseCarCrash",
  "car-crash-decision": "phaseCarCrashDecision",
  "car-crash-result": "phaseCarCrashResult",
  "car-crash-skipped": "phaseCarCrashSkipped",
  "goodbye-speech": "phaseGoodbyeSpeech",
  "best-move": "phaseBestMove",
  "night-mafia": "phaseNightMafia",
  "night-mafia-result": "phaseNightMafiaResult",
  "night-don": "phaseNightDon",
  "night-don-result": "phaseNightDonResult",
  "night-sheriff": "phaseNightSheriff",
  "night-sheriff-result": "phaseNightSheriffResult",
  "night-resolution": "phaseNightResolution",
  finished: "phaseFinished",
};
const eventMessageKeys: Readonly<Record<string, ShellMessageKey>> = {
  "game.created": "eventGameCreated",
  "players.selected": "eventPlayersSelected",
  "setup.players-selected": "eventPlayersSelected",
  "game.started": "eventGameStarted",
  "game.checkpointed": "eventGameCheckpointed",
  "phase.changed": "eventPhaseChanged",
  "turn.completed": "eventTurnCompleted",
  "player.nominated": "eventPlayerNominated",
  "foul.issued": "eventFoulIssued",
  "player.red-carded": "eventPlayerRedCarded",
  "voting.skipped": "eventVotingSkipped",
  "voting.resolved": "eventVotingResolved",
  "car-crash.resolved": "eventCarCrashResolved",
  "car-crash.ballot-resolved": "eventCarCrashBallotResolved",
  "mafia.shots-resolved": "eventMafiaShotsResolved",
  "don.checked": "eventDonChecked",
  "don.check-skipped": "eventDonCheckSkipped",
  "sheriff.checked": "eventSheriffChecked",
  "sheriff.check-skipped": "eventSheriffCheckSkipped",
  "best-move.completed": "eventBestMoveCompleted",
  "game.completed": "eventGameCompleted",
};
const phaseLabel = (phase: string, t: ShellTranslator): string =>
  t(phaseMessageKeys[phase] ?? "unknownPhase", { value: phase });
const eventLabel = (eventType: string, t: ShellTranslator): string =>
  t(eventMessageKeys[eventType] ?? "unknownEvent", { value: eventType });
const defaultClubId = "00000000-0000-4000-8000-000000000101";
const gameSessionStoragePrefix = "mafia-dashboard.game-session.v4";
const legacyGameSessionStoragePrefix = "mafia-dashboard.game-session.v3";
interface SessionClaimConflict {
  readonly gameId: string;
  readonly action: "resume" | "retry" | "delete" | "replace-local";
  readonly expectedRevision: number | null;
  readonly gameName: string | null;
  readonly holderName: string | null;
  readonly claimedAt: string | null;
  readonly lastSeenAt: string | null;
  readonly expiresAt: string | null;
}
const nullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const claimConflictDetails = (
  error: unknown,
  gameId: string,
  action: SessionClaimConflict["action"],
  expectedRevision: number | null = null,
): SessionClaimConflict | null => {
  if (!(error instanceof ApiError)) return null;
  if (typeof error.details !== "object" || error.details === null) return null;
  if (error.code === "club_active_game_exists" && "activeGame" in error.details) {
    const activeGame = error.details.activeGame;
    if (typeof activeGame !== "object" || activeGame === null) return null;
    const values = activeGame as Record<string, unknown>;
    if (typeof values.gameId !== "string" || typeof values.name !== "string") {
      return null;
    }
    return {
      gameId: values.gameId,
      action: "replace-local",
      expectedRevision: null,
      gameName: values.name,
      holderName: null,
      claimedAt: null,
      lastSeenAt: null,
      expiresAt: null,
    };
  }
  if (error.code !== "game_session_claim_conflict" || !("claim" in error.details)) return null;
  const claim = error.details.claim;
  if (typeof claim !== "object" || claim === null) return null;
  const values = claim as Record<string, unknown>;
  return {
    gameId,
    action,
    expectedRevision,
    gameName: null,
    holderName: nullableString(values.holderName),
    claimedAt: nullableString(values.claimedAt),
    lastSeenAt: nullableString(values.lastSeenAt),
    expiresAt: nullableString(values.expiresAt),
  };
};
const availablePlayerStorageKey = (clubId: string) =>
  `mafia-dashboard.available-player-ids.${clubId}`;
const readAvailablePlayerIds = (storage: Storage, clubId: string): ReadonlySet<string> => {
  try {
    const value = JSON.parse(storage.getItem(availablePlayerStorageKey(clubId)) ?? "[]");
    return new Set(
      Array.isArray(value)
        ? value.filter((playerId): playerId is string => typeof playerId === "string")
        : [],
    );
  } catch (error) {
    reportError(error, { source: "persistence", context: "available-players.read" });
    return new Set();
  }
};
const gameSessionStorageKey = (clubId: string) =>
  clubId === defaultClubId ? gameSessionStoragePrefix : `${gameSessionStoragePrefix}.${clubId}`;
const legacyGameSessionStorageKey = (clubId: string) =>
  clubId === defaultClubId
    ? legacyGameSessionStoragePrefix
    : `${legacyGameSessionStoragePrefix}.${clubId}`;
const clearGameSessionStorage = (storage: Storage) => {
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (
      key === gameSessionStoragePrefix ||
      key?.startsWith(`${gameSessionStoragePrefix}.`) ||
      key === legacyGameSessionStoragePrefix ||
      key?.startsWith(`${legacyGameSessionStoragePrefix}.`)
    ) {
      storage.removeItem(key);
    }
  }
};
const migrateGameSessionStorage = (source: Storage, destination: Storage, key: string) => {
  if (destination.getItem(key) !== null) {
    source.removeItem(key);
    return;
  }
  const value = source.getItem(key);
  if (value === null) return;
  destination.setItem(key, value);
  if (destination.getItem(key) === value) source.removeItem(key);
};
const nextGameName = (storage: Storage, now: Date): string => {
  const date = [now.getDate(), now.getMonth() + 1, now.getFullYear() % 100]
    .map((value) => String(value).padStart(2, "0"))
    .join(".");
  const key = `mafia-dashboard.game-sequence.${date}`;
  const next = Math.max(0, Number(storage.getItem(key)) || 0) + 1;
  storage.setItem(key, String(next));
  return `${date} #${next}`;
};

interface PersistedState extends GameSessionState {
  readonly setup: SetupWizardSessionState | null;
  readonly game: GameState | null;
  readonly log: readonly LocalLogEntry[];
  readonly undoHistory: readonly unknown[];
  readonly initialGame: InitialGameBaseline | null;
  readonly events: readonly GameLogEntry[];
  readonly headEventId: string | null;
  readonly resetReturnEventId: string | null;
  readonly legacyLog: readonly LocalLogEntry[];
}

interface WebkitFullscreenDocument extends Document {
  readonly webkitFullscreenElement?: Element | null;
  readonly webkitExitFullscreen?: () => Promise<void> | void;
}

interface WebkitFullscreenElement extends HTMLElement {
  readonly webkitRequestFullscreen?: () => Promise<void> | void;
}

const currentFullscreenElement = (): Element | null =>
  document.fullscreenElement ??
  (document as WebkitFullscreenDocument).webkitFullscreenElement ??
  null;

const defaultPlaylistId = import.meta.env.VITE_YOUTUBE_PLAYLIST_ID ?? "";

const hasSetupProgress = ({
  step,
  hostPlayerId,
  selectedPlayerIds,
  setup,
}: SetupWizardSessionState) =>
  step !== "players" ||
  setup !== null ||
  (hostPlayerId !== undefined && hostPlayerId !== "") ||
  selectedPlayerIds.some((playerId) => playerId !== "");

const setupPhase = (step: SetupWizardSessionState["step"] | undefined) =>
  step === "roles" ? "setup-roles" : step === "music" ? "setup-music" : "setup-players";

const isAuxiliaryEvent = (type: string) =>
  type.startsWith("timer.") || type.startsWith("music.") || type.startsWith("setup.");

type NightExitFade = "quick" | "slow";

const nightExitFade = (
  previous: GameState | null,
  next: GameState | null,
): NightExitFade | null => {
  if (previous?.phase !== "night-resolution" || next === null) return null;
  if (next.phase === "best-move") return "quick";
  if (next.phase === "day") return "slow";
  if (next.phase === "goodbye-speech" && next.goodbyeNext === "day") return "slow";
  return null;
};

const toLocalLogEntry = (entry: GameLogEntry): LocalLogEntry => ({
  id: entry.id,
  sequence: entry.sequence,
  type: entry.type,
  phase: entry.phaseBefore,
  payload: entry.payload as Record<string, unknown>,
  createdAt: entry.createdAt,
});

const migratePlanningNames = (state: GameSessionState | undefined) => {
  const setup = (state?.setup as SetupWizardSessionState | null | undefined) ?? null;
  const setupState = setup?.setup as unknown as { step?: string } | null;
  const game =
    (state?.game as unknown as ({ phase?: string } & Record<string, unknown>) | null) ?? null;
  return {
    setup:
      setup === null
        ? null
        : {
            ...setup,
            setup:
              setupState?.step === "mafia-negotiation"
                ? ({ ...setup.setup, step: "mafia-planning" } as SetupWizardSessionState["setup"])
                : setup.setup,
          },
    game:
      game?.phase === "mafia-negotiation"
        ? ({ ...game, phase: "mafia-planning" } as GameState)
        : (game as unknown as GameState | null),
  };
};

const asPersistedState = (state: GameSessionState | undefined): PersistedState => {
  const migrated = migratePlanningNames(state);
  const incremental = state as
    | (GameSessionState & {
        readonly initialGame?: InitialGameBaseline | null;
        readonly events?: readonly GameLogEntry[];
        readonly headEventId?: string | null;
        readonly resetReturnEventId?: string | null;
        readonly legacyLog?: readonly LocalLogEntry[];
        readonly undoBudget?: number;
      })
    | undefined;
  const storedLog = (state?.log as readonly LocalLogEntry[] | undefined) ?? [];
  const events = incremental?.events ?? [];
  return {
    ...migrated,
    hostPlayerId: state?.hostPlayerId ?? null,
    hostName: state?.hostName ?? null,
    playlistId: state?.playlistId ?? defaultPlaylistId,
    log: storedLog,
    undoHistory: [],
    undoBudget: incremental?.undoBudget,
    initialGame:
      incremental?.initialGame ??
      (migrated.game === null ? null : { replayVersion: 1, game: migrated.game }),
    events,
    headEventId: incremental?.headEventId ?? events.at(-1)?.id ?? null,
    resetReturnEventId: incremental?.resetReturnEventId ?? null,
    legacyLog: incremental?.legacyLog ?? (events.length === 0 ? storedLog : []),
  };
};

export const ClubWorkspace = ({
  club,
  onExit,
  onEditClub,
  onDeleteClub,
  onLanguageChange = () => Promise.resolve(),
  themeColor = DEFAULT_THEME_COLOR,
  onThemeColorChange = () => undefined,
}: {
  readonly club: Club;
  readonly onExit: () => void;
  readonly onEditClub: () => void;
  readonly onDeleteClub: () => Promise<void>;
  readonly onLanguageChange?: (language: Locale) => Promise<void>;
  readonly themeColor?: string;
  readonly onThemeColorChange?: (color: string) => void;
}) => {
  const { t, formatTime } = useMessages(shellMessages);
  const isManager = club.role === "manager";
  const storageKey = gameSessionStorageKey(club.id);
  const legacyStorageKey = legacyGameSessionStorageKey(club.id);
  const claimControllerRef = useRef<GameSessionClaimController | null>(null);
  if (claimControllerRef.current === null) {
    claimControllerRef.current = new GameSessionClaimController({
      storage: window.sessionStorage,
      coordinationStorage: window.localStorage,
      clubId: club.id,
      createId: createRandomId,
      lockRequest:
        typeof navigator.locks?.request === "function"
          ? (name, options, callback) => navigator.locks.request(name, options, callback)
          : undefined,
    });
  }
  const claimController = claimControllerRef.current;
  const claimControllerEffectGenerationRef = useRef(0);
  const workspaceActiveRef = useRef(true);
  const claimCredential = useCallback(
    (gameId: string, claimGeneration: number): GameSessionClaimCredential =>
      claimController.credential(gameId, claimGeneration),
    [claimController],
  );
  const rotateClaimId = useCallback(
    (gameId: string) => claimController.clear(gameId),
    [claimController],
  );

  migrateGameSessionStorage(window.sessionStorage, window.localStorage, storageKey);
  migrateGameSessionStorage(window.sessionStorage, window.localStorage, legacyStorageKey);
  const sessionSyncRef = useRef<GameSessionOutbox | null>(null);
  if (sessionSyncRef.current === null) {
    sessionSyncRef.current = new GameSessionOutbox({
      storage: window.localStorage,
      storageKey,
      legacyStorageKey,
      createId: createRandomId,
      save: (gameId, operation, claimGeneration) =>
        saveGameSessionOperation(
          gameId,
          operation,
          claimCredential(gameId, claimGeneration),
          club.id,
        ),
      read: (gameId) => getGameSession(gameId, club.id),
      clearRemote: (gameId, expectedRevision, claimGeneration) =>
        clearGameSession(
          gameId,
          expectedRevision,
          claimCredential(gameId, claimGeneration),
          club.id,
        ),
      saveLegacy: (gameId, mutation, claimGeneration) =>
        saveGameSession(gameId, mutation, claimCredential(gameId, claimGeneration), club.id),
    });
  }
  const sessionSync = sessionSyncRef.current;
  const releaseAndDisposeClaim = useCallback(
    (clearIdentity = true) => {
      if (claimController.isDisposed) return;
      const owned = [...claimController.ownedClaims()];
      const currentGameId = sessionSync.gameId;
      const currentGeneration = sessionSync.claimGeneration;
      if (
        owned.length === 0 &&
        currentGameId !== null &&
        currentGeneration > 0 &&
        sessionSync.current?.results === null
      ) {
        owned.push({
          gameId: currentGameId,
          ...claimCredential(currentGameId, currentGeneration),
        });
      }
      for (const { gameId, claimId, claimGeneration } of owned) {
        void releaseGameSession(gameId, { claimId, claimGeneration }, club.id).catch((error) =>
          reportError(error, { source: "api", context: "game-session.release-unmount" }),
        );
      }
      if (clearIdentity) claimController.clearAll();
      claimController.dispose();
    },
    [claimController, claimCredential, club.id, sessionSync],
  );
  const claimConflictReporterRef = useRef<
    (
      error: unknown,
      gameId: string,
      action: SessionClaimConflict["action"],
      expectedRevision?: number | null,
    ) => boolean
  >(() => false);
  const sessionRetryRef = useRef<SessionRetryController | null>(null);
  if (sessionRetryRef.current === null) {
    sessionRetryRef.current = new SessionRetryController({
      flush: () => {
        const gameId = sessionSync.gameId;
        return gameId === null ||
          claimController.canWrite(gameId, sessionSync.revision, sessionSync.claimGeneration)
          ? sessionSync.flush()
          : Promise.resolve();
      },
      probe: checkServerReady,
      pendingCount: () => sessionSync.pendingCount,
      reportTerminal: (error) => {
        if (sessionSync.gameId !== null) {
          claimConflictReporterRef.current(error, sessionSync.gameId, "retry");
        }
        reportError(error, { source: "persistence", context: "game-session.offline" });
      },
    });
  }
  const sessionRetry = sessionRetryRef.current;
  const [claimControllerReady, setClaimControllerReady] = useState(claimController.isReady);
  const [claimConflict, setClaimConflict] = useState<SessionClaimConflict | null>(null);
  const [claimDialogOpen, setClaimDialogOpen] = useState(false);
  const [takeoverPending, setTakeoverPending] = useState(false);
  const [takeoverError, setTakeoverError] = useState(false);
  const claimConflictRef = useRef<SessionClaimConflict | null>(null);
  claimConflictRef.current = claimConflict;
  claimConflictReporterRef.current = (error, gameId, action, expectedRevision) => {
    const conflict = claimConflictDetails(error, gameId, action, expectedRevision);
    if (conflict === null) return false;
    claimController.markBlocked(gameId);
    if (conflict.gameId !== gameId) claimController.markBlocked(conflict.gameId);
    setTakeoverError(false);
    setClaimConflict(conflict);
    setClaimDialogOpen(true);
    return true;
  };
  const initialCurrent = useRef(sessionSync.current).current;
  const initialState = useRef(asPersistedState(initialCurrent?.state)).current;
  const initialMusicPreferences = useRef(
    readMusicPreferences(window.localStorage, club.id),
  ).current;
  const initialPlaylistId =
    initialCurrent !== null &&
    initialCurrent !== undefined &&
    initialState.playlistId.trim().length > 0
      ? initialState.playlistId
      : initialMusicPreferences.lastPlaylistId || initialState.playlistId;

  const [view, setView] = useState<WorkspaceView>("game");
  const [availabilityScreenOpen, setAvailabilityScreenOpen] = useState(false);
  const [sessionName, setSessionName] = useState(
    () => initialCurrent?.name ?? nextGameName(window.localStorage, new Date()),
  );
  const initialDerivedGame = (() => {
    if (initialState.game !== null) return initialState.game;
    if (initialState.initialGame === null) return initialState.game;
    if (initialState.headEventId === null) return initialState.initialGame.game;
    try {
      return replayGameLog(
        initialState.initialGame,
        getActiveBranch(initialState.events, initialState.headEventId),
      ).game;
    } catch (error) {
      reportError(error, { source: "persistence", context: "game-session.replay-initial" });
      return initialState.game;
    }
  })();
  const [game, setGame] = useState<GameState | null>(initialDerivedGame);
  const [initialGame, setInitialGame] = useState<InitialGameBaseline | null>(
    initialState.initialGame,
  );
  const [events, setEvents] = useState<readonly GameLogEntry[]>(initialState.events);
  const [headEventId, setHeadEventId] = useState<string | null>(initialState.headEventId);
  const [legacyLog, setLegacyLog] = useState<readonly LocalLogEntry[]>(initialState.legacyLog);
  const [resetReturnEventId, setResetReturnEventId] = useState<string | null>(
    initialState.resetReturnEventId,
  );
  const [previewTargetEventId, setPreviewTargetEventId] = useState<string | null>(null);
  const [previewGame, setPreviewGame] = useState<GameState | null>(null);
  const [undoBudget, setUndoBudget] = useState(
    () =>
      initialState.undoBudget ??
      getRemainingUndoBudget(initialState.events, initialState.headEventId),
  );

  const [setupSession, setSetupSession] = useState<SetupWizardSessionState | null>(
    initialState.setup,
  );
  const [setupInstanceKey, setSetupInstanceKey] = useState(0);
  const [hostPlayerId, setHostPlayerId] = useState<string | null>(initialState.hostPlayerId);
  const [hostName, setHostName] = useState<string | null>(initialState.hostName);
  const [finalResults, setFinalResults] = useState<FinalGameResults | null>(
    initialCurrent?.results ?? null,
  );
  const [finishGameState, setFinishGameState] = useState<"ready" | "saving" | "saved" | "queued">(
    initialCurrent?.results === null || initialCurrent?.results === undefined
      ? "ready"
      : sessionSync.pendingCount > 0
        ? "queued"
        : "saved",
  );
  const [players, setPlayers] = useState<readonly PlayerProfile[]>([]);
  const [availablePlayerIds, setAvailablePlayerIds] = useState<ReadonlySet<string>>(() =>
    readAvailablePlayerIds(window.localStorage, club.id),
  );
  const [playersError, setPlayersError] = useState(false);
  const [languageSaving, setLanguageSaving] = useState(false);
  const [languageError, setLanguageError] = useState(false);
  const [playerGateError, setPlayerGateError] = useState<PlayerGateError | null>(null);
  const [playlistId, setPlaylistId] = useState(initialPlaylistId);
  const [musicPreferences, setMusicPreferences] =
    useState<MusicPreferencesV1>(initialMusicPreferences);
  const [musicPlayerExpanded, setMusicPlayerExpanded] = useState(false);
  const [musicReloadRequest, setMusicReloadRequest] = useState(0);
  const [musicState, setMusicState] = useState<YouTubePlaybackState>("idle");

  const changePlaylistId = useCallback(
    (nextPlaylistId: string) => {
      if (claimConflictRef.current !== null) return;
      setPlaylistId(nextPlaylistId);
      setMusicPreferences((current) => {
        const next = selectRememberedPlaylist(current, nextPlaylistId);
        writeMusicPreferences(window.localStorage, club.id, next);
        return next;
      });
    },
    [club.id],
  );
  const clearMusicAccountState = useCallback(() => {
    setPlaylistId("");
    setMusicPreferences((current) => {
      const next = selectRememberedPlaylist(current, "");
      writeMusicPreferences(window.localStorage, club.id, next);
      return next;
    });
  }, [club.id]);
  const changeQueueOrder = useCallback(
    (changedPlaylistId: string, order: readonly string[]) => {
      if (changedPlaylistId !== playlistId) return;
      setMusicPreferences((current) => {
        const selected = selectRememberedPlaylist(current, changedPlaylistId);
        const next = { ...selected, queueOrder: order };
        writeMusicPreferences(window.localStorage, club.id, next);
        return next;
      });
    },
    [club.id, playlistId],
  );
  const changeQueueTags = useCallback(
    (
      field: "initialStageEntryKeys" | "endgameEntryKeys",
      changedPlaylistId: string,
      entryKeys: readonly string[],
    ) => {
      if (changedPlaylistId !== playlistId) return;
      setMusicPreferences((current) => {
        const selected = selectRememberedPlaylist(current, changedPlaylistId);
        const classifiedEntries = new Set(entryKeys);
        const next =
          field === "initialStageEntryKeys"
            ? {
                ...selected,
                initialStageEntryKeys: entryKeys,
                endgameEntryKeys: selected.endgameEntryKeys.filter(
                  (entryKey) => !classifiedEntries.has(entryKey),
                ),
              }
            : {
                ...selected,
                initialStageEntryKeys: selected.initialStageEntryKeys.filter(
                  (entryKey) => !classifiedEntries.has(entryKey),
                ),
                endgameEntryKeys: entryKeys,
              };
        writeMusicPreferences(window.localStorage, club.id, next);
        return next;
      });
    },
    [club.id, playlistId],
  );

  const [activeSessions, setActiveSessions] = useState<readonly ActiveGameSessionSummary[]>([]);
  const [activeSessionsError, setActiveSessionsError] = useState(false);
  const [resumeGameId, setResumeGameId] = useState<string | null>(null);
  const [swipedSessionId, setSwipedSessionId] = useState<string | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [activeDrawer, setActiveDrawer] = useState<"log" | "manage" | "dev" | null>(null);
  const [musicSetupOpen, setMusicSetupOpen] = useState(false);
  const [backgroundShade, setBackgroundShade] = useState<BackgroundShade>("black");
  const [lighting, dispatchLighting] = useReducer(
    lightingRendererReducer,
    window.localStorage,
    createLightingRendererState,
  );

  const [devModeEnabled, setDevModeEnabled] = useState(false);
  const [devUnlocked, setDevUnlocked] = useState(false);
  const [canaryBurstKey, setCanaryBurstKey] = useState(0);
  const [privacyTapStage, setPrivacyTapStage] = useState(0);
  const [privacyHidden, setPrivacyHidden] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(() => currentFullscreenElement() !== null);
  const [clearingAllData, setClearingAllData] = useState(false);
  const [clearAllDataError, setClearAllDataError] = useState(false);
  const [syncRender, setSyncRender] = useState(0);

  const appShellRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const previousDrawerRef = useRef<typeof activeDrawer>(null);
  const musicRef = useRef<YouTubePlayerHandle>(null);
  const privacyTapsRef = useRef<{ count: number; resetTimer: number | null }>({
    count: 0,
    resetTimer: null,
  });
  const previousMusicGameRef = useRef<GameState | null>(initialDerivedGame);
  const sessionSwipeStartRef = useRef<{ readonly gameId: string; readonly x: number } | null>(null);
  const initialGameRef = useRef<InitialGameBaseline | null>(initialState.initialGame);
  const eventsRef = useRef<readonly GameLogEntry[]>(initialState.events);
  const headEventIdRef = useRef<string | null>(initialState.headEventId);
  const canonicalGameRef = useRef<GameState | null>(initialDerivedGame);
  const legacyLogRef = useRef<readonly LocalLogEntry[]>(initialState.legacyLog);
  const previewTargetEventIdRef = useRef<string | null>(null);
  const gameScreenMutationGenerationRef = useRef(0);
  const liveGameBeforePreviewRef = useRef<GameState | null>(null);
  const hasIntermediateDraftRef = useRef(false);
  const viewBeforeTimelineRef = useRef<Exclude<WorkspaceView, "timeline">>("game");
  const viewBeforeConsoleRef = useRef<"game" | "players">("game");
  const phaseRef = useRef(initialState.game?.phase ?? setupPhase(initialState.setup?.step));
  const playerRequestRef = useRef(0);
  const activeSessionsRequestRef = useRef(0);
  const resumeRequestRef = useRef(0);
  const persistedResultsRef = useRef<FinalGameResults | null>(initialCurrent?.results ?? null);
  const finalizingCompletionRef = useRef(false);
  const fullscreenTarget = document.documentElement as WebkitFullscreenElement;
  const fullscreenDocument = document as WebkitFullscreenDocument;
  const fullscreenAvailable =
    typeof fullscreenTarget.requestFullscreen === "function" ||
    typeof fullscreenTarget.webkitRequestFullscreen === "function";

  useEffect(() => {
    const previousDrawer = previousDrawerRef.current;
    if (activeDrawer === null) {
      if (previousDrawer !== null && drawerTriggerRef.current?.isConnected)
        drawerTriggerRef.current.focus();
    } else {
      drawerRef.current?.querySelector<HTMLElement>("h2")?.focus();
    }
    previousDrawerRef.current = activeDrawer;
  }, [activeDrawer]);

  const closeDrawerOnEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    setActiveDrawer(null);
  };

  const activeBranch = (() => {
    try {
      return getActiveBranch(events, headEventId);
    } catch (error) {
      reportError(error, { source: "persistence", context: "game-history.active-branch" });
      return [];
    }
  })();
  const currentTimelineHistory = (() => {
    if (initialGame === null || headEventId === null) return undefined;
    try {
      return {
        label: sessionName,
        frames: replayGameLog(initialGame, activeBranch).frames,
        headEventId,
      };
    } catch (error) {
      reportError(error, { source: "persistence", context: "timeline.current-history" });
      return undefined;
    }
  })();
  const log: readonly LocalLogEntry[] = [...legacyLog, ...activeBranch.map(toLocalLogEntry)];
  const undoHistory = undoBudget === 0 ? [] : getUndoableEvents(activeBranch).slice(-undoBudget);
  const undoCount = finalResults === null ? undoHistory.length : 0;
  const previewEntry = events.find(({ id }) => id === previewTargetEventId);
  const renderedGameScreenMutationGeneration = gameScreenMutationGenerationRef.current;
  const canApplyGameScreenMutation = () =>
    claimConflictRef.current === null &&
    previewTargetEventIdRef.current === null &&
    gameScreenMutationGenerationRef.current === renderedGameScreenMutationGeneration;

  const refreshPlayers = useCallback(async () => {
    const request = playerRequestRef.current + 1;
    playerRequestRef.current = request;
    try {
      const nextPlayers = await listPlayers(club.id);
      if (playerRequestRef.current === request) {
        setPlayers(nextPlayers);
        setPlayersError(false);
        if (isManager && nextPlayers.length < 11) setView("players");
      }
    } catch (error) {
      reportError(error, { source: "api", context: "players.list" });
      if (playerRequestRef.current === request) setPlayersError(true);
    }
  }, [club.id, isManager]);

  const refreshActiveSessions = useCallback(async () => {
    const request = activeSessionsRequestRef.current + 1;
    activeSessionsRequestRef.current = request;
    try {
      const sessions = await listActiveGameSessions(club.id);
      if (activeSessionsRequestRef.current === request) {
        setActiveSessions(sessions);
        setActiveSessionsError(false);
      }
    } catch (error) {
      reportError(error, { source: "api", context: "game-sessions.list-active" });
      if (activeSessionsRequestRef.current === request) setActiveSessionsError(true);
    }
  }, [club.id]);

  useEffect(() => {
    void refreshPlayers();
    void refreshActiveSessions();
  }, [refreshActiveSessions, refreshPlayers]);

  useEffect(() => {
    document.title = `${club.name} · Mafia Dashboard`;
    return () => {
      document.title = "Mafia Dashboard";
    };
  }, [club.name]);

  useEffect(() => {
    const syncFullscreenState = () => setIsFullscreen(currentFullscreenElement() !== null);
    document.addEventListener("fullscreenchange", syncFullscreenState);
    document.addEventListener("webkitfullscreenchange", syncFullscreenState);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreenState);
      document.removeEventListener("webkitfullscreenchange", syncFullscreenState);
    };
  }, []);

  useEffect(
    () => () => {
      if (privacyTapsRef.current.resetTimer !== null) {
        window.clearTimeout(privacyTapsRef.current.resetTimer);
      }
    },
    [],
  );

  useEffect(
    () =>
      sessionSync.subscribe(() => {
        setSyncRender((revision) => revision + 1);
        const current = sessionSync.current;
        const normalized = sessionSync.takeNormalizedCurrent();
        const canonicalName = current?.name;
        if (canonicalName !== undefined) setSessionName(canonicalName);
        if (
          normalized !== null &&
          normalized.state.initialGame != null &&
          (normalized.state.events?.length ?? 0) > 0
        ) {
          const baseline = normalized.state.initialGame;
          const canonicalEvents = [...(normalized.state.events ?? [])];
          const canonicalHead = normalized.state.headEventId ?? canonicalEvents.at(-1)?.id ?? null;
          const canonicalGame =
            canonicalHead === null
              ? baseline.game
              : replayToEvent(baseline, canonicalEvents, canonicalHead);
          initialGameRef.current = baseline;
          eventsRef.current = canonicalEvents;
          headEventIdRef.current = canonicalHead;
          canonicalGameRef.current = canonicalGame;
          phaseRef.current = canonicalGame.phase;
          setInitialGame(baseline);
          setEvents(canonicalEvents);
          setHeadEventId(canonicalHead);
          setResetReturnEventId(normalized.state.resetReturnEventId ?? null);
          setGame(canonicalGame);
          setFinalResults(normalized.results);
          setFinishGameState(normalized.results === null ? "ready" : "saved");
        }
      }),
    [sessionSync],
  );

  useEffect(() => {
    sessionRetry.activate();
    const unsubscribe = sessionRetry.subscribe(() => setSyncRender((revision) => revision + 1));
    return () => {
      unsubscribe();
      sessionRetry.dispose();
    };
  }, [sessionRetry]);

  useEffect(() => {
    let active = true;
    void claimController.ready().then(() => {
      if (!active) return;
      setClaimControllerReady(true);
      const gameId = sessionSync.gameId;
      if (
        gameId === null ||
        claimController.canWrite(gameId, sessionSync.revision, sessionSync.claimGeneration)
      ) {
        sessionRetry.requestAutoSync();
      }
    });
    return () => {
      active = false;
    };
  }, [claimController, sessionRetry]);

  useEffect(() => {
    workspaceActiveRef.current = true;
    const generation = claimControllerEffectGenerationRef.current + 1;
    claimControllerEffectGenerationRef.current = generation;
    const dispose = (event: PageTransitionEvent) => {
      if (!event.persisted) {
        workspaceActiveRef.current = false;
        releaseAndDisposeClaim(false);
      }
    };
    window.addEventListener("pagehide", dispose);
    return () => {
      workspaceActiveRef.current = false;
      window.removeEventListener("pagehide", dispose);
      window.queueMicrotask(() => {
        if (claimControllerEffectGenerationRef.current === generation) releaseAndDisposeClaim();
      });
    };
  }, [releaseAndDisposeClaim]);

  const heartbeatGameId = sessionSync.gameId;
  const heartbeatRevision = sessionSync.revision;
  const heartbeatGeneration = sessionSync.claimGeneration;
  const heartbeatCompleted =
    sessionSync.current?.results !== null && sessionSync.pendingCount === 0;
  useEffect(() => {
    if (!claimControllerReady) return;
    if (heartbeatGameId === null) {
      return;
    }
    if (heartbeatCompleted || claimConflict !== null) {
      if (heartbeatCompleted) claimController.clear(heartbeatGameId);
      else claimController.markBlocked(heartbeatGameId);
      return;
    }
    if (heartbeatRevision === 0 && heartbeatGeneration === 0) {
      sessionRetry.requestAutoSync();
      return;
    }

    let active = true;
    let renewing = false;
    const renew = async () => {
      if (renewing) return;
      renewing = true;
      try {
        const claim = await claimGameSession(
          heartbeatGameId,
          claimCredential(heartbeatGameId, heartbeatGeneration),
          club.id,
        );
        if (active) {
          const needsRecovery = !claimController.isOwned(heartbeatGameId, heartbeatGeneration);
          sessionSync.setClaimGeneration(claim.generation);
          claimController.markOwned(heartbeatGameId, claim.generation);
          if (needsRecovery) sessionRetry.retryNow();
        }
      } catch (error) {
        if (active) {
          if (!claimConflictReporterRef.current(error, heartbeatGameId, "retry")) {
            claimController.markOffline(heartbeatGameId);
            reportError(error, { source: "api", context: "game-session.heartbeat" });
          }
        }
      } finally {
        renewing = false;
      }
    };
    const recover = () => {
      if (document.visibilityState !== "visible") return;
      claimController.markOffline(heartbeatGameId);
      void renew();
    };

    claimController.startRenewal(heartbeatGameId, () => void renew());
    window.addEventListener("online", recover);
    document.addEventListener("visibilitychange", recover);
    return () => {
      active = false;
      claimController.stopRenewal();
      window.removeEventListener("online", recover);
      document.removeEventListener("visibilitychange", recover);
    };
  }, [
    claimConflict,
    claimController,
    claimControllerReady,
    club.id,
    heartbeatCompleted,
    heartbeatGameId,
    heartbeatGeneration,
    heartbeatRevision,
    claimCredential,
    sessionRetry,
    sessionSync,
  ]);

  useEffect(() => {
    if (sessionSync.gameId === null && initialGame === null) return;
    sessionSync.enqueue(
      sessionName,
      {
        setup: setupSession,
        game,
        hostPlayerId,
        hostName,
        playlistId,
        log,
        undoHistory: [],
        undoBudget,
        initialGame,
        events,
        headEventId,
        resetReturnEventId,
        legacyLog,
      } as GameSessionState,
      finalResults,
    );
    const gameId = sessionSync.gameId;
    if (
      gameId !== null &&
      claimController.canWrite(gameId, sessionSync.revision, sessionSync.claimGeneration)
    ) {
      sessionRetry.requestAutoSync();
    }
  }, [
    claimController,
    finalResults,
    events,
    game,
    headEventId,
    hostName,
    hostPlayerId,
    initialGame,
    legacyLog,
    log,
    playlistId,
    resetReturnEventId,
    sessionRetry,
    sessionName,
    sessionSync,
    setupSession,
    undoBudget,
  ]);

  useEffect(() => {
    if (finalResults === null) return;
    const phase = sessionRetry.getSnapshot().phase;
    setFinishGameState(phase === "offline" ? "queued" : phase === "saved" ? "saved" : "saving");
  }, [finalResults, sessionRetry, syncRender]);

  const logEvent = useCallback(
    (type: string, payload: Record<string, unknown>) => {
      if (
        sessionSync.normalizing ||
        previewTargetEventIdRef.current !== null ||
        isAuxiliaryEvent(type)
      )
        return;
      const sequence =
        Math.max(
          0,
          ...legacyLogRef.current.map((entry) => entry.sequence),
          ...eventsRef.current.map((entry) => entry.sequence),
        ) + 1;
      const entry: LocalLogEntry = {
        id: createRandomId(),
        sequence,
        type,
        phase: phaseRef.current,
        payload,
        createdAt: new Date().toISOString(),
      };
      const nextLog = [...legacyLogRef.current, entry];
      legacyLogRef.current = nextLog;
      setLegacyLog(nextLog);
    },
    [sessionSync],
  );

  const changeGame = (next: GameState) => {
    if (sessionSync.normalizing || previewTargetEventIdRef.current !== null) return;
    const canonical = canonicalGameRef.current;
    hasIntermediateDraftRef.current =
      canonical !== null && hashGameState(next) !== hashGameState(canonical);
    setGame(next);
  };

  const acceptGameEvent = useCallback(
    (draft: CanonicalGameEventDraft) => {
      if (sessionSync.normalizing || previewTargetEventIdRef.current !== null) return;
      const baseline = initialGameRef.current;
      const before = canonicalGameRef.current;
      const gameId = sessionSync.gameId;
      if (baseline === null || before === null || gameId === null) return;
      if (!isMeaningfulGameEventDraft(draft)) {
        const nextDraft = applyGameEvent(game ?? before, draft);
        hasIntermediateDraftRef.current = true;
        phaseRef.current = nextDraft.phase;
        setGame(nextDraft);
        return;
      }
      const sequence = Math.max(0, ...eventsRef.current.map((entry) => entry.sequence)) + 1;
      const created = createGameLogEntry({
        gameId,
        id: createRandomId(),
        sequence,
        parentEventId: headEventIdRef.current,
        createdAt: new Date().toISOString(),
        before,
        draft,
      });
      let displayedAfter = created.after;
      if (hasIntermediateDraftRef.current && game !== null) {
        try {
          displayedAfter = applyGameEvent(game, draft);
        } catch (error) {
          reportError(error, { source: "application", context: "game-event.apply-draft" });
          displayedAfter = created.after;
        }
      }
      hasIntermediateDraftRef.current =
        hashGameState(displayedAfter) !== hashGameState(created.after);
      const nextEvents = [...eventsRef.current, created.entry];
      eventsRef.current = nextEvents;
      headEventIdRef.current = created.entry.id;
      canonicalGameRef.current = created.after;
      phaseRef.current = created.after.phase;
      setEvents(nextEvents);
      setHeadEventId(created.entry.id);
      setResetReturnEventId(null);
      if (draft.type !== "game.started" && draft.type !== "game.completed") {
        setUndoBudget((current) => (created.after.day > before.day ? 0 : Math.min(3, current + 1)));
      }
      setGame(displayedAfter);
      if (
        (created.entry.type === "game.drawn" || created.entry.type === "game.cancelled") &&
        hostPlayerId !== null
      ) {
        setFinalResults(
          buildFinalGameResults(
            created.after,
            new Date(created.entry.createdAt),
            hostPlayerId,
            created.entry.payload.reason,
          ),
        );
        setFinishGameState("saving");
      } else if (created.after.phase !== "finished") {
        setFinalResults(null);
        setFinishGameState("ready");
      }
    },
    [game, hostPlayerId, sessionSync],
  );

  const moveHeadLocally = useCallback(
    (targetEventId: string | null) => {
      const baseline = initialGameRef.current;
      if (baseline === null) return;
      gameScreenMutationGenerationRef.current += 1;
      hasIntermediateDraftRef.current = false;
      const nextGame =
        targetEventId === null
          ? baseline.game
          : replayToEvent(baseline, eventsRef.current, targetEventId);
      headEventIdRef.current = targetEventId;
      canonicalGameRef.current = nextGame;
      phaseRef.current = nextGame.phase;
      setHeadEventId(targetEventId);
      setGame(nextGame);
      const target = eventsRef.current.find(({ id }) => id === targetEventId);
      if (target !== undefined && hostPlayerId !== null && isTerminalGamePhase(nextGame.phase)) {
        const reason =
          target.type === "game.drawn" || target.type === "game.cancelled"
            ? target.payload.reason
            : null;
        setFinalResults(
          buildFinalGameResults(nextGame, new Date(target.createdAt), hostPlayerId, reason),
        );
        setFinishGameState("saved");
      } else {
        setFinalResults(null);
        setFinishGameState("ready");
      }
    },
    [hostPlayerId],
  );

  const previewEventState = useCallback(
    (eventId: string) => {
      const baseline = initialGameRef.current;
      if (baseline === null) return;
      liveGameBeforePreviewRef.current = game;
      gameScreenMutationGenerationRef.current += 1;
      previewTargetEventIdRef.current = eventId;
      setPreviewTargetEventId(eventId);
      setPreviewGame(replayToEvent(baseline, eventsRef.current, eventId));
      setActiveDrawer(null);
    },
    [game],
  );

  const exitPreview = useCallback(() => {
    gameScreenMutationGenerationRef.current += 1;
    previewTargetEventIdRef.current = null;
    setPreviewTargetEventId(null);
    setPreviewGame(null);
    liveGameBeforePreviewRef.current = null;
  }, []);

  const resetToEventState = useCallback(
    async (eventId: string) => {
      if (finalResults !== null) return false;
      const branch = getActiveBranch(eventsRef.current, headEventIdRef.current);
      const targetIndex = branch.findIndex(({ id }) => id === eventId);
      if (targetIndex < 0) return false;
      const futureCount = branch.length - targetIndex - 1;
      const target = branch[targetIndex]!;
      if (
        !window.confirm(t("resetActiveGame", { sequence: target.sequence, count: futureCount }))
      ) {
        return false;
      }
      const retained = branch.slice(0, targetIndex + 1);
      eventsRef.current = retained;
      setEvents(retained);
      gameScreenMutationGenerationRef.current += 1;
      moveHeadLocally(eventId);
      setResetReturnEventId(null);
      setUndoBudget(0);
      previewTargetEventIdRef.current = null;
      setPreviewTargetEventId(null);
      setPreviewGame(null);
      liveGameBeforePreviewRef.current = null;
      setActiveDrawer(null);
      return true;
    },
    [finalResults, moveHeadLocally],
  );

  const finishGame = () => {
    if (claimConflictRef.current !== null) return;
    if (game?.phase !== "finished" || hostPlayerId === null || finalResults !== null) return;
    acceptGameEvent({
      type: "game.completed",
      payload: { winner: game.winner ?? "red" },
    });
    const completionEvent = eventsRef.current.at(-1);
    const results = buildFinalGameResults(
      game,
      new Date(completionEvent?.createdAt ?? Date.now()),
      hostPlayerId,
    );
    setFinishGameState("saving");
    setFinalResults(results);
    sessionSync.enqueue(
      sessionName,
      {
        setup: setupSession,
        game,
        hostPlayerId,
        hostName,
        playlistId,
        log: [
          ...legacyLogRef.current,
          ...getActiveBranch(eventsRef.current, headEventIdRef.current).map(toLocalLogEntry),
        ],
        undoHistory: [],
        undoBudget,
        initialGame: initialGameRef.current,
        events: eventsRef.current,
        headEventId: headEventIdRef.current,
        resetReturnEventId,
        legacyLog: legacyLogRef.current,
      } as GameSessionState,
      results,
    );
    sessionRetry.requestAutoSync();
  };

  const undoLastGameAction = () => {
    if (finalResults !== null) return;
    const entry = undoHistory.at(-1);
    if (entry?.parentEventId == null) return;
    const retained = getActiveBranch(eventsRef.current, entry.parentEventId);
    eventsRef.current = retained;
    setEvents(retained);
    moveHeadLocally(entry.parentEventId);
    setUndoBudget((current) => Math.max(0, current - 1));
  };

  const handleMusicState = useCallback((state: YouTubePlaybackState) => {
    setMusicState(state);
  }, []);

  useEffect(() => {
    const previous = previousMusicGameRef.current;
    previousMusicGameRef.current = game;
    const fade = nightExitFade(previous, game);
    if (fade === null || game === null) return;
    const preferEndgame = isCriticalState(game);
    void (async () => {
      try {
        if (musicState === "playing") {
          if (fade === "quick") await musicRef.current?.quickFadeOut();
          else await musicRef.current?.slowFadeOut();
        }
      } catch {
        // The controller reports fade failures; the Night shuffle is still mandatory.
      } finally {
        musicRef.current?.shuffleQueue({ preferEndgame });
      }
    })();
  }, [game, musicState]);

  const musicLabel: Record<YouTubePlaybackState, string> = {
    idle: t("playlistRequired"),
    loading: t("loadingPlayer"),
    playing: t("playing"),
    paused: t("readyPaused"),
    error: t("playbackUnavailable"),
  };

  const createProfile = async (input: PlayerProfileInput) => {
    await createPlayer(input, club.id);
    await refreshPlayers();
  };

  const updateProfile = async (playerId: string, input: PlayerProfileInput) => {
    await updatePlayer(playerId, input, club.id);
    await refreshPlayers();
  };

  const updatePlayerAvailability = (playerId: string, available: boolean) => {
    setAvailablePlayerIds((current) => {
      const next = new Set(current);
      if (available) next.add(playerId);
      else next.delete(playerId);
      window.localStorage.setItem(
        availablePlayerStorageKey(club.id),
        JSON.stringify([...next].sort()),
      );
      return next;
    });
  };

  const deleteProfile = async (playerId: string) => {
    await deletePlayer(playerId, club.id);
    updatePlayerAvailability(playerId, false);
    setPlayers((current) => current.filter(({ id }) => id !== playerId));
    await refreshPlayers();
  };

  const populateDevelopmentPlayers = async (): Promise<readonly PlayerProfile[]> => {
    const batchId = createRandomId().slice(0, 8);
    const developmentAdjectives = [
      t("devAdjectiveCrimson"),
      t("devAdjectiveMidnight"),
      t("devAdjectiveVelvet"),
      t("devAdjectiveGolden"),
      t("devAdjectiveSilent"),
    ];
    const developmentAliases = [
      t("devAliasFox"),
      t("devAliasRaven"),
      t("devAliasWolf"),
      t("devAliasOwl"),
      t("devAliasViper"),
    ];
    const created: PlayerProfile[] = [];
    try {
      for (let index = 0; index < 11; index += 1) {
        const adjective =
          developmentAdjectives[Math.floor(Math.random() * developmentAdjectives.length)]!;
        const alias = developmentAliases[Math.floor(Math.random() * developmentAliases.length)]!;
        created.push(
          await createPlayer(
            {
              nickname: t("devPlayerName", {
                adjective,
                alias,
                batchId,
                number: index + 1,
              }),
              consent: false,
              clubAccess: "none",
              firstName: null,
              lastName: null,
              email: null,
            },
            club.id,
          ),
        );
      }
      return created;
    } catch (error) {
      reportError(error, { source: "api", context: "development-players.populate" });
      await Promise.allSettled(created.map(({ id }) => deletePlayer(id, club.id)));
      throw error;
    } finally {
      await refreshPlayers();
    }
  };

  const handleSetupSessionChange = useCallback(
    (next: SetupWizardSessionState) => {
      if (claimConflictRef.current !== null) return;
      if (next.step === "roles") {
        sessionSync.ensureGameId(sessionSync.gameId ?? createRandomId());
      }
      phaseRef.current = setupPhase(next.step);
      setSetupSession(hasSetupProgress(next) ? next : null);
      const nextHostId = next.hostPlayerId;
      if (nextHostId === undefined || nextHostId === "") {
        setHostPlayerId(null);
        setHostName(null);
        return;
      }
      const selectedHost = players.find(({ id }) => id === nextHostId);
      setHostPlayerId(nextHostId);
      if (selectedHost !== undefined) setHostName(selectedHost.nickname);
    },
    [players, sessionSync],
  );

  const applyRemoteSession = useCallback(
    (session: RemoteGameSession, claimGeneration: number, replaceLocal = false) => {
      if (replaceLocal) {
        sessionSync.replaceAfterTakeover(
          session.gameId,
          session.revision,
          session.name,
          session.state,
          session.results,
          claimGeneration,
        );
      } else {
        sessionSync.restore(
          session.gameId,
          session.revision,
          session.name,
          session.state,
          session.results,
          claimGeneration,
        );
      }
      const restored = asPersistedState(sessionSync.current?.state);
      gameScreenMutationGenerationRef.current += 1;
      setSessionName(session.name);
      const restoredGame =
        restored.game ??
        (restored.initialGame === null
          ? null
          : restored.headEventId === null
            ? restored.initialGame.game
            : replayGameLog(
                restored.initialGame,
                getActiveBranch(restored.events, restored.headEventId),
              ).game);
      setGame(restoredGame);
      setInitialGame(restored.initialGame);
      initialGameRef.current = restored.initialGame;
      setEvents(restored.events);
      eventsRef.current = restored.events;
      setHeadEventId(restored.headEventId);
      headEventIdRef.current = restored.headEventId;
      canonicalGameRef.current = restoredGame;
      setLegacyLog(restored.legacyLog);
      legacyLogRef.current = restored.legacyLog;
      setResetReturnEventId(restored.resetReturnEventId);
      setUndoBudget(
        restored.undoBudget ?? getRemainingUndoBudget(restored.events, restored.headEventId),
      );

      setSetupSession(restored.setup);
      setHostPlayerId(restored.hostPlayerId);
      setHostName(restored.hostName);
      setPlaylistId(restored.playlistId);
      setFinalResults(session.results);
      setFinishGameState(session.results === null ? "ready" : "saved");
      persistedResultsRef.current = session.results;
      phaseRef.current = restoredGame?.phase ?? setupPhase(restored.setup?.step);
      setSetupInstanceKey((key) => key + 1);
      setView("game");
      setAvailabilityScreenOpen(false);
    },
    [sessionSync],
  );

  const resumeSession = async (gameId: string) => {
    if (sessionSync.status !== "saved") {
      setActiveSessionsError(true);
      return;
    }
    const request = resumeRequestRef.current + 1;
    resumeRequestRef.current = request;
    await claimController.ready();
    if (!workspaceActiveRef.current || resumeRequestRef.current !== request) return;
    const localGameId = sessionSync.gameId;
    const localRevision = sessionSync.revision;
    const localCurrent = sessionSync.current;
    const credential = claimCredential(
      gameId,
      localGameId === gameId ? sessionSync.claimGeneration : 0,
    );
    let acquiredCredential: GameSessionClaimCredential | null = null;
    setResumeGameId(gameId);
    setActiveSessionsError(false);
    try {
      const claim = await claimGameSession(gameId, credential, club.id);
      acquiredCredential = { claimId: credential.claimId, claimGeneration: claim.generation };
      if (!workspaceActiveRef.current || resumeRequestRef.current !== request) {
        void releaseGameSession(gameId, acquiredCredential, club.id).catch((error) =>
          reportError(error, { source: "api", context: "game-session.release-superseded" }),
        );
        return;
      }
      const session = await getGameSession(gameId, club.id);
      if (!workspaceActiveRef.current || resumeRequestRef.current !== request) {
        void releaseGameSession(gameId, acquiredCredential, club.id).catch((error) =>
          reportError(error, { source: "api", context: "game-session.release-superseded" }),
        );
        return;
      }
      if (
        sessionSync.gameId !== localGameId ||
        sessionSync.revision !== localRevision ||
        sessionSync.current !== localCurrent ||
        sessionSync.status !== "saved"
      ) {
        void releaseGameSession(gameId, acquiredCredential, club.id).catch((error) =>
          reportError(error, { source: "api", context: "game-session.release-stale-resume" }),
        );
        setResumeGameId(null);
        return;
      }
      applyRemoteSession(session, claim.generation);
      claimController.markOwned(gameId, claim.generation);
      sessionRetry.requestAutoSync();
      setResumeGameId(null);
    } catch (error) {
      reportError(error, { source: "api", context: "game-session.resume" });
      if (acquiredCredential !== null) {
        void releaseGameSession(gameId, acquiredCredential, club.id).catch((releaseError) =>
          reportError(releaseError, {
            source: "api",
            context: "game-session.release-failed-resume",
          }),
        );
      }
      if (workspaceActiveRef.current && resumeRequestRef.current === request) {
        setResumeGameId(null);
        if (!claimConflictReporterRef.current(error, gameId, "resume")) {
          setActiveSessionsError(true);
        }
      }
    }
  };

  const takeOverSession = async () => {
    const conflict = claimConflictRef.current;
    if (!workspaceActiveRef.current || conflict === null || takeoverPending) return;
    setTakeoverPending(true);
    setTakeoverError(false);
    try {
      await claimController.ready();
      if (!workspaceActiveRef.current || claimConflictRef.current !== conflict) return;
      const credential = claimCredential(
        conflict.gameId,
        sessionSync.gameId === conflict.gameId ? sessionSync.claimGeneration : 0,
      );
      const claim = await takeoverGameSession(conflict.gameId, credential, club.id);
      if (!workspaceActiveRef.current || claimConflictRef.current !== conflict) {
        void releaseGameSession(
          conflict.gameId,
          { claimId: credential.claimId, claimGeneration: claim.generation },
          club.id,
        ).catch((error) =>
          reportError(error, { source: "api", context: "game-session.release-superseded" }),
        );
        return;
      }
      claimController.markOwned(conflict.gameId, claim.generation);
      if (conflict.action === "resume" || conflict.action === "replace-local") {
        const replacedGameId = sessionSync.gameId;
        const session = await getGameSession(conflict.gameId, club.id);
        if (!workspaceActiveRef.current || claimConflictRef.current !== conflict) return;
        applyRemoteSession(session, claim.generation, conflict.action === "replace-local");
        if (
          conflict.action === "replace-local" &&
          replacedGameId !== null &&
          replacedGameId !== conflict.gameId
        ) {
          rotateClaimId(replacedGameId);
        }
      } else if (conflict.action === "delete" && conflict.expectedRevision !== null) {
        await clearGameSession(
          conflict.gameId,
          conflict.expectedRevision,
          { claimId: credential.claimId, claimGeneration: claim.generation },
          club.id,
        );
        if (!workspaceActiveRef.current || claimConflictRef.current !== conflict) return;
        if (sessionSync.gameId === conflict.gameId) {
          await sessionSync.clear(async () => undefined);
          resetLocalState();
        } else {
          rotateClaimId(conflict.gameId);
        }
        await Promise.all([refreshActiveSessions(), refreshPlayers()]);
      } else {
        sessionSync.rebindClaimGeneration(claim.generation);
      }
      if (!workspaceActiveRef.current) return;
      setClaimConflict(null);
      setClaimDialogOpen(false);
      sessionRetry.retryNow();
    } catch (error) {
      reportError(error, { source: "api", context: "game-session.takeover" });
      if (workspaceActiveRef.current && claimConflictRef.current === conflict) {
        setTakeoverError(true);
      }
    } finally {
      if (workspaceActiveRef.current) setTakeoverPending(false);
    }
  };

  const exitWorkspace = () => {
    workspaceActiveRef.current = false;
    releaseAndDisposeClaim();
    onExit();
  };

  const resetLocalState = useCallback(() => {
    const clearedGameId = sessionSync.gameId;
    setSessionName(nextGameName(window.localStorage, new Date()));
    setGame(null);
    setSetupSession(null);
    setHostPlayerId(null);
    setHostName(null);
    setFinalResults(null);
    persistedResultsRef.current = null;
    setFinishGameState("ready");
    setPlaylistId(defaultPlaylistId);
    setSetupInstanceKey((key) => key + 1);
    setView("game");
    setAvailabilityScreenOpen(false);
    setInitialGame(null);
    initialGameRef.current = null;
    setEvents([]);
    eventsRef.current = [];
    setHeadEventId(null);
    headEventIdRef.current = null;
    canonicalGameRef.current = null;
    setLegacyLog([]);
    legacyLogRef.current = [];
    setResetReturnEventId(null);
    setUndoBudget(0);
    gameScreenMutationGenerationRef.current += 1;
    previewTargetEventIdRef.current = null;
    setPreviewTargetEventId(null);
    setPreviewGame(null);
    liveGameBeforePreviewRef.current = null;
    phaseRef.current = "setup-players";
    setClaimConflict(null);
    setClaimDialogOpen(false);
    setTakeoverError(false);
    if (clearedGameId !== null) rotateClaimId(clearedGameId);
  }, [rotateClaimId, sessionSync]);

  useEffect(() => {
    if (
      finalResults === null ||
      sessionRetry.getSnapshot().phase !== "saved" ||
      sessionSync.pendingCount > 0 ||
      finalizingCompletionRef.current
    ) {
      return;
    }
    finalizingCompletionRef.current = true;
    persistedResultsRef.current = finalResults;
    void (async () => {
      try {
        await sessionSync.clear(async () => undefined);
        resetLocalState();
        void Promise.all([refreshPlayers(), refreshActiveSessions()]).catch((error: unknown) =>
          reportError(error, { source: "api", context: "game.finish-refresh" }),
        );
      } catch (error) {
        reportError(error, { source: "persistence", context: "game.finish-local-clear" });
      } finally {
        finalizingCompletionRef.current = false;
      }
    })();
  }, [
    finalResults,
    refreshActiveSessions,
    refreshPlayers,
    resetLocalState,
    sessionRetry,
    sessionSync,
    syncRender,
  ]);

  const clearGameState = async () => {
    if (!window.confirm(t("deleteActiveGameConfirmation"))) return;
    const clearingGameId = sessionSync.gameId;
    try {
      await claimController.ready();
      await sessionSync.clear((gameId, revision, generation) =>
        clearGameSession(gameId, revision, claimCredential(gameId, generation), club.id),
      );
    } catch (error) {
      reportError(error, { source: "persistence", context: "game-session.clear" });
      if (clearingGameId !== null) {
        claimConflictReporterRef.current(error, clearingGameId, "delete", sessionSync.revision);
      }
      return;
    }
    if (sessionSync.gameId !== null && sessionSync.gameId !== clearingGameId) return;
    resetLocalState();
    void refreshActiveSessions();
  };

  const deleteActiveSession = async (session: ActiveGameSessionSummary) => {
    if (!window.confirm(t("deleteSessionConfirmation", { name: session.name }))) return;
    setDeletingSessionId(session.gameId);
    let acquiredCredential: GameSessionClaimCredential | null = null;
    try {
      await claimController.ready();
      if (sessionSync.gameId === session.gameId) {
        await sessionSync.clear((gameId, revision, generation) =>
          clearGameSession(gameId, revision, claimCredential(gameId, generation), club.id),
        );
        resetLocalState();
      } else {
        const initialCredential = claimCredential(session.gameId, 0);
        const claim = await claimGameSession(session.gameId, initialCredential, club.id);
        acquiredCredential = {
          claimId: initialCredential.claimId,
          claimGeneration: claim.generation,
        };
        await clearGameSession(session.gameId, session.revision, acquiredCredential, club.id);
        rotateClaimId(session.gameId);
      }
      setSwipedSessionId(null);
      await Promise.all([refreshActiveSessions(), refreshPlayers()]);
    } catch (error) {
      reportError(error, { source: "api", context: "game-session.delete" });
      if (!claimConflictReporterRef.current(error, session.gameId, "delete", session.revision)) {
        setActiveSessionsError(true);
      }
      if (acquiredCredential !== null) {
        void releaseGameSession(session.gameId, acquiredCredential, club.id).catch((releaseError) =>
          reportError(releaseError, {
            source: "api",
            context: "game-session.release-failed-delete",
          }),
        );
      }
    } finally {
      setDeletingSessionId(null);
    }
  };

  const clearApplicationData = async () => {
    if (!window.confirm(t("clearApplicationDataConfirmation"))) return;
    setClearingAllData(true);
    setClearAllDataError(false);
    try {
      await sessionSync.clear(async () => undefined);
      claimController.clearAll();
      window.localStorage.clear();
      window.sessionStorage.clear();
      setMusicPreferences(readMusicPreferences(window.localStorage, club.id));

      clearErrorConsole();
      setDevModeEnabled(false);
      setDevUnlocked(false);
      setCanaryBurstKey(0);
      setPrivacyTapStage(0);
      if (privacyTapsRef.current.resetTimer !== null) {
        window.clearTimeout(privacyTapsRef.current.resetTimer);
      }
      privacyTapsRef.current = { count: 0, resetTimer: null };
      setAvailablePlayerIds(new Set());
      resetLocalState();
      window.localStorage.clear();
      setActiveDrawer(null);
    } catch (error) {
      reportError(error, { source: "persistence", context: "application-data.clear" });
      setClearAllDataError(true);
    } finally {
      setClearingAllData(false);
    }
  };

  const toggleFullscreen = async () => {
    try {
      if (currentFullscreenElement() === null) {
        if (typeof fullscreenTarget.requestFullscreen === "function") {
          await fullscreenTarget.requestFullscreen();
        } else {
          await fullscreenTarget.webkitRequestFullscreen?.();
        }
      } else if (typeof document.exitFullscreen === "function") {
        await document.exitFullscreen();
      } else {
        await fullscreenDocument.webkitExitFullscreen?.();
      }
    } catch (error) {
      reportError(error, { source: "application", context: "fullscreen.toggle" });
      setIsFullscreen(currentFullscreenElement() !== null);
    }
  };

  const deletionProtectedPlayerIds = new Set([
    ...(game === null
      ? (setupSession?.selectedPlayerIds.filter((playerId) => playerId !== "") ?? [])
      : game.players.map(({ id }) => id)),
    ...(game === null
      ? setupSession?.hostPlayerId === undefined || setupSession.hostPlayerId === ""
        ? []
        : [setupSession.hostPlayerId]
      : hostPlayerId === null
        ? []
        : [hostPlayerId]),
  ]);
  const availablePlayersForSetup = players.filter(({ id }) => availablePlayerIds.has(id));

  const persistenceSnapshot = sessionRetry.getSnapshot();
  const persistenceState =
    persistenceSnapshot.phase === "saved" && sessionSync.status === "offline"
      ? "offline"
      : persistenceSnapshot.phase;
  const pendingChanges = sessionSync.pendingCount;
  const pendingLabel = t("pendingChanges", { count: pendingChanges });
  const saveStatusLabel =
    persistenceState === "saved"
      ? t("savedToServer")
      : persistenceState === "offline"
        ? persistenceSnapshot.terminalReason === "rejected"
          ? t("saveBlocked", { pendingLabel })
          : t("offline", { pendingLabel })
        : persistenceState === "retrying"
          ? t("saveFailed", {
              attempt: persistenceSnapshot.attempt,
              maxAttempts: persistenceSnapshot.maxAttempts,
              pendingLabel,
            })
          : t("saving", { pendingLabel });
  const setupStep = setupSession?.step ?? "players";
  const roleGiveawayActive = view === "game" && game === null && setupStep === "roles";
  const tableLayoutActive = view === "game" && (game !== null || roleGiveawayActive);
  useLayoutEffect(() => {
    if (!tableLayoutActive || appShellRef.current === null) return;
    appShellRef.current.scrollTop = 0;
    appShellRef.current.scrollLeft = 0;
  }, [tableLayoutActive]);
  const showApplicationStatus =
    view !== "timeline" && (view === "players" || (game === null && !roleGiveawayActive));
  const applicationStatusTitle =
    view === "players"
      ? t("playersStatistics")
      : availabilityScreenOpen
        ? t("availablePlayers")
        : t("gameSetup");
  const applicationStatusPhase =
    view === "players"
      ? players.length < 11
        ? t("needPlayers", { needed: 11, registered: players.length })
        : t("availableRegistered", {
            available: availablePlayersForSetup.length,
            registered: players.length,
          })
      : setupStep === "music"
        ? t("tableMusic")
        : availabilityScreenOpen
          ? t("availableCount", { count: availablePlayersForSetup.length })
          : t("selectPlayers");
  const nextBackgroundShade =
    backgroundShadeOrder[
      (backgroundShadeOrder.indexOf(backgroundShade) + 1) % backgroundShadeOrder.length
    ]!;
  const selectLightingRenderer = useCallback((renderer: LightingRenderer) => {
    writeLightingRenderer(window.localStorage, renderer);
    dispatchLighting({ type: "select", renderer });
  }, []);
  const setPlayerLighting = useCallback((enabled: boolean) => {
    writePlayerLightingEnabled(window.localStorage, enabled);
    dispatchLighting({ type: "set-player-lighting", enabled });
  }, []);
  const reportVgpuReady = useCallback(
    (generation: number) => dispatchLighting({ type: "vgpu-ready", generation }),
    [],
  );
  const reportVgpuFailure = useCallback(
    (generation: number) => dispatchLighting({ type: "vgpu-failed", generation }),
    [],
  );

  const showWorkspaceTools = previewGame === null && (view === "game" || view === "players");
  const togglePrivacy = () => {
    setPrivacyHidden((hidden) => !hidden);
    if (!isManager) {
      setPrivacyTapStage(0);
      return;
    }
    const sequence = privacyTapsRef.current;
    if (sequence.resetTimer !== null) window.clearTimeout(sequence.resetTimer);
    const count = sequence.count + 1;
    if (count >= 5) {
      privacyTapsRef.current = { count: 0, resetTimer: null };
      setPrivacyTapStage(5);
      setDevUnlocked(true);
      setCanaryBurstKey((key) => key + 1);
      return;
    }
    privacyTapsRef.current = {
      count,
      resetTimer: window.setTimeout(() => {
        privacyTapsRef.current = { count: 0, resetTimer: null };
        setPrivacyTapStage(0);
      }, 500),
    };
    setPrivacyTapStage(count);
  };
  const hasCurrentGameState =
    sessionSync.gameId !== null ||
    game !== null ||
    setupSession !== null ||
    playlistId !== defaultPlaylistId;
  const musicSetupPanel = musicSetupOpen ? (
    <section
      id="manage-music-setup"
      className="manage-music-setup"
      aria-label={t("musicPlayerSetup")}
    >
      <div className={`music-status ${musicState === "playing" ? "is-playing" : ""}`}>
        <span className="status-dot" />
        <strong>{musicLabel[musicState]}</strong>
      </div>
      <button type="button" onClick={() => setMusicReloadRequest((request) => request + 1)}>
        {t("reloadMusicPlayer")}
      </button>
      <AccountPlaylistPicker
        playlistId={playlistId}
        onPlaylistIdChange={changePlaylistId}
        onAccountDisconnected={clearMusicAccountState}
      />
    </section>
  ) : null;
  const activeSessionsPanel = (
    <section className="manage-active-sessions" aria-label={t("activeGames")}>
      <h3>{t("activeGames")}</h3>
      {activeSessionsError ? (
        <p role="alert">{t("activeGamesUnavailable")}</p>
      ) : activeSessions.length === 0 ? (
        <p>{t("noActiveGames")}</p>
      ) : (
        <ul>
          {activeSessions.map((session) => (
            <li
              key={session.gameId}
              className={swipedSessionId === session.gameId ? "is-delete-revealed" : ""}
              onTouchStart={(event) => {
                sessionSwipeStartRef.current = {
                  gameId: session.gameId,
                  x: event.touches[0]?.clientX ?? 0,
                };
              }}
              onTouchEnd={(event) => {
                const start = sessionSwipeStartRef.current;
                sessionSwipeStartRef.current = null;
                if (start?.gameId !== session.gameId) return;
                const delta = (event.changedTouches[0]?.clientX ?? start.x) - start.x;
                if (delta < -44) setSwipedSessionId(session.gameId);
                else if (delta > 44) setSwipedSessionId(null);
              }}
            >
              <button
                type="button"
                className="session-delete-action"
                disabled={deletingSessionId === session.gameId}
                onClick={() => void deleteActiveSession(session)}
              >
                {deletingSessionId === session.gameId ? t("deleting") : t("delete")}
              </button>
              <div className="session-swipe-content">
                <div>
                  <strong>{session.name}</strong>
                  <span>
                    {t("activeSessionSummary", {
                      host: session.hostName ?? t("hostNotSelected"),
                      phase: phaseLabel(session.phase, t),
                      day: session.day,
                    })}
                  </span>
                </div>
                <button
                  type="button"
                  disabled={resumeGameId === session.gameId}
                  onClick={() => {
                    setActiveDrawer(null);
                    void resumeSession(session.gameId);
                  }}
                >
                  {resumeGameId === session.gameId
                    ? t("resuming")
                    : t("resumeSession", { name: session.name })}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  const claimInitializing = !claimControllerReady && sessionSync.gameId !== null;
  const content = (
    <div
      ref={appShellRef}
      inert={claimConflict === null && !claimInitializing ? undefined : true}
      className={`app-shell${backgroundShadeClass[backgroundShade]}${
        tableLayoutActive ? " has-live-game table-layout-shell" : ""
      }${showApplicationStatus ? " has-top-level-screen" : ""}${
        isFullscreen ? " is-fullscreen" : ""
      }`}
      data-background-shade={backgroundShade}
      data-lighting-renderer={lighting.effectiveRenderer}
      data-lighting-renderer-requested={lighting.requestedRenderer}
      data-vgpu-status={lighting.vgpuStatus}
      data-player-lighting={lighting.playerLightingEnabled ? "enabled" : "disabled"}
    >
      {showApplicationStatus ? (
        <header
          className="app-status-bar game-header"
          role="banner"
          aria-label={t("applicationStatus")}
        >
          {club.headerLogo === null ? null : (
            <img className="active-club-header-logo" src={club.headerLogo} alt="" />
          )}
          <div>
            <p className="eyebrow">
              {view === "players" ? t("persistentPlayers") : t("gameSetupSession", { sessionName })}{" "}
              · {t("hostView")}
            </p>
            <h1 aria-label={applicationStatusTitle}>
              <span className="active-club-title-name">{club.name}</span>
              <span aria-hidden="true"> · </span>
              {applicationStatusTitle}
            </h1>
          </div>
          <div className="phase-banner">{applicationStatusPhase}</div>
        </header>
      ) : null}
      {showWorkspaceTools ? (
        <div className="app-fixed-toolbar" aria-label={t("applicationTools")}>
          <button
            type="button"
            className="club-exit-button icon-toolbar-button"
            aria-label={t("chooseAnotherClub", { clubName: club.name })}
            onClick={exitWorkspace}
          >
            <DoorOpen aria-hidden="true" />
          </button>
          <button
            type="button"
            className="save-indicator icon-toolbar-button"
            data-status={persistenceState}
            aria-label={saveStatusLabel}
            aria-live="polite"
            aria-busy={persistenceState === "saving" || persistenceState === "retrying"}
            title={saveStatusLabel}
            onClick={() => sessionRetry.retryNow()}
          >
            <Save aria-hidden="true" />
          </button>
          <button
            type="button"
            className="fullscreen-button icon-toolbar-button"
            aria-label={
              fullscreenAvailable
                ? isFullscreen
                  ? t("exitFullscreen")
                  : t("enterFullscreen")
                : t("fullscreenUnavailable")
            }
            aria-pressed={isFullscreen}
            disabled={!fullscreenAvailable}
            onClick={() => void toggleFullscreen()}
          >
            {isFullscreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="undo-button icon-toolbar-button"
            aria-label={t("undoLastAction", { count: undoCount })}
            disabled={undoCount === 0}
            onClick={undoLastGameAction}
          >
            <Undo2 aria-hidden="true" />
            <span className="toolbar-count">{undoCount}</span>
          </button>
          <button
            type="button"
            className={`privacy-button icon-toolbar-button is-tap-${privacyTapStage}`}
            aria-label={privacyHidden ? t("showPrivateInfo") : t("hidePrivateInfo")}
            aria-pressed={privacyHidden}
            onClick={togglePrivacy}
          >
            {privacyHidden ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
            {canaryBurstKey > 0 ? <CanaryFirework burstKey={canaryBurstKey} /> : null}
          </button>
          {isManager ? (
            <button
              type="button"
              className="log-toolbar-button icon-toolbar-button"
              aria-label={activeDrawer === "log" ? t("closeGameLog") : t("openGameLog")}
              aria-expanded={activeDrawer === "log"}
              aria-controls="game-log-drawer"
              onClick={(event) => {
                drawerTriggerRef.current = event.currentTarget;
                setActiveDrawer((drawer) => (drawer === "log" ? null : "log"));
              }}
            >
              <ListTree aria-hidden="true" />
              <span className="toolbar-count">{log.length}</span>
            </button>
          ) : null}
          <button
            type="button"
            className="manage-toolbar-button icon-toolbar-button"
            aria-label={activeDrawer === "manage" ? t("closeManageMenu") : t("openManageMenu")}
            aria-expanded={activeDrawer === "manage"}
            aria-controls="manage-menu-drawer"
            onClick={(event) => {
              drawerTriggerRef.current = event.currentTarget;
              setActiveDrawer((drawer) => (drawer === "manage" ? null : "manage"));
            }}
          >
            <SlidersHorizontal aria-hidden="true" />
          </button>
          {isManager && devUnlocked ? (
            <button
              type="button"
              className="dev-toolbar-button icon-toolbar-button"
              aria-label={activeDrawer === "dev" ? t("closeDeveloperMenu") : t("openDeveloperMenu")}
              aria-expanded={activeDrawer === "dev"}
              aria-controls="dev-menu-drawer"
              onClick={(event) => {
                drawerTriggerRef.current = event.currentTarget;
                setActiveDrawer((drawer) => (drawer === "dev" ? null : "dev"));
              }}
            >
              <Wrench aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
      {isManager && showWorkspaceTools && activeDrawer === "log" ? (
        <aside
          ref={drawerRef}
          id="game-log-drawer"
          className="app-drawer game-log-drawer"
          role="dialog"
          aria-label={t("gameLog")}
          onKeyDown={closeDrawerOnEscape}
        >
          <h2 tabIndex={-1}>{t("log")}</h2>
          <div className="game-log-list">
            {log.length === 0 ? <p>{t("noActionsRecorded")}</p> : null}
            {[...log].reverse().map((entry) => {
              const previewable = events.some(({ id }) => id === entry.id);
              return (
                <article key={entry.id}>
                  <span className="log-sequence">#{entry.sequence}</span>
                  <div>
                    <strong>{eventLabel(entry.type, t)}</strong>
                    <small>
                      {phaseLabel(entry.phase, t)} · {formatTime(entry.createdAt)}
                    </small>
                    <div className="log-state-actions">
                      <button
                        type="button"
                        disabled={!previewable}
                        aria-label={t("previewStateAfterLog", { sequence: entry.sequence })}
                        onClick={() => previewEventState(entry.id)}
                      >
                        {t("previewState")}
                      </button>
                      <button
                        type="button"
                        className="danger-action"
                        disabled={!previewable || finalResults !== null}
                        aria-label={t("resetGameToLog", { sequence: entry.sequence })}
                        onClick={() => resetToEventState(entry.id)}
                      >
                        {t("reset")}
                      </button>
                    </div>
                    {!previewable ? <small>{t("legacyStatePreviewUnavailable")}</small> : null}
                  </div>
                </article>
              );
            })}
          </div>
        </aside>
      ) : null}
      {showWorkspaceTools && activeDrawer === "manage" ? (
        <aside
          ref={drawerRef}
          id="manage-menu-drawer"
          className="app-drawer manage-menu-drawer"
          role="dialog"
          aria-label={t("manage")}
          onKeyDown={closeDrawerOnEscape}
        >
          <h2 tabIndex={-1}>{t("manage")}</h2>
          <div className="manage-menu-actions">
            <button
              type="button"
              onClick={() => {
                if (view === "players" && availablePlayersForSetup.length < 11) {
                  const missing = 11 - availablePlayersForSetup.length;
                  setPlayerGateError(
                    players.length < 11
                      ? { key: "addRegisteredPlayers", count: 11 - players.length }
                      : { key: "markAvailablePlayers", count: missing },
                  );
                  setActiveDrawer(null);
                  return;
                }
                setPlayerGateError(null);
                setActiveDrawer(null);
                if (hasCurrentGameState) void clearGameState();
                else resetLocalState();
              }}
            >
              {t("startNewGame")}
            </button>
            {isManager ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setPlayerGateError(null);
                    setAvailabilityScreenOpen(false);
                    setView("players");
                    setActiveDrawer(null);
                  }}
                >
                  {t("playersScreen")}
                </button>
                <button
                  type="button"
                  aria-expanded={musicSetupOpen}
                  aria-controls="manage-music-setup"
                  onClick={() => setMusicSetupOpen((open) => !open)}
                >
                  {musicSetupOpen ? t("hideMusicPlayerSetup") : t("musicPlayerSetup")}
                </button>
              </>
            ) : null}
          </div>
          {isManager ? musicSetupPanel : null}
          {activeSessionsPanel}
          {isManager ? (
            <div className="manage-menu-actions manage-club-actions">
              <button
                type="button"
                onClick={() => {
                  setActiveDrawer(null);
                  onEditClub();
                }}
              >
                {t("editClub")}
              </button>
              <label className="theme-color-field">
                <span>{t("glassColor")}</span>
                <input
                  type="color"
                  aria-label={t("glassColor")}
                  value={themeColor}
                  onChange={(event) => onThemeColorChange(event.currentTarget.value)}
                />
              </label>
              <LanguageSelector
                value={club.language}
                disabled={languageSaving}
                onChange={(language) => {
                  setLanguageError(false);
                  setLanguageSaving(true);
                  void onLanguageChange(language)
                    .catch((error: unknown) => {
                      reportError(error, { source: "api", context: "clubs.language" });
                      setLanguageError(true);
                    })
                    .finally(() => setLanguageSaving(false));
                }}
              />
              {languageError ? <p role="alert">{t("clubLanguageSaveFailed")}</p> : null}
              <button
                type="button"
                className="danger-action"
                onClick={() => {
                  setActiveDrawer(null);
                  void onDeleteClub();
                }}
              >
                {t("deleteClub")}
              </button>
            </div>
          ) : null}
        </aside>
      ) : null}
      {isManager && showWorkspaceTools && activeDrawer === "dev" ? (
        <aside
          ref={drawerRef}
          id="dev-menu-drawer"
          className="app-drawer dev-menu-drawer"
          role="dialog"
          aria-label={t("developerMenu")}
          onKeyDown={closeDrawerOnEscape}
        >
          <div className="dev-menu-header">
            <h2 tabIndex={-1}>{t("devMenu")}</h2>
            <p
              className="dev-menu-version"
              aria-label={t("canaryVersion", { version: webPackage.version })}
            >
              <Bird aria-hidden="true" strokeWidth={2.5} />
              <span>{t("canaryVersionLabel", { version: webPackage.version })}</span>
            </p>
          </div>
          <div className="dev-menu-actions">
            <label className="dev-renderer-field">
              <span>{t("lightingRenderer")}</span>
              <select
                aria-label={t("lightingRenderer")}
                value={lighting.requestedRenderer}
                onChange={(event) =>
                  selectLightingRenderer(event.currentTarget.value as LightingRenderer)
                }
              >
                <option value="legacy">{t("lightingRendererLegacy")}</option>
                <option value="svg">{t("lightingRendererSvg")}</option>
                <option value="vgpu">{t("lightingRendererVgpu")}</option>
              </select>
              {lighting.vgpuStatus === "initializing" ? (
                <small role="status">{t("vgpuInitializing")}</small>
              ) : lighting.vgpuStatus === "fallback" ? (
                <small role="status">{t("vgpuFallback")}</small>
              ) : null}
            </label>
            <button
              type="button"
              className="dev-setting-toggle"
              aria-label={
                lighting.playerLightingEnabled
                  ? t("disablePlayerLighting")
                  : t("enablePlayerLighting")
              }
              aria-pressed={lighting.playerLightingEnabled}
              onClick={() => setPlayerLighting(!lighting.playerLightingEnabled)}
            >
              <span>
                <strong>{t("playerLighting")}</strong>
                <small>{t("playerLightingDescription")}</small>
              </span>
              <span className="dev-setting-state">
                {t(lighting.playerLightingEnabled ? "settingOn" : "settingOff")}
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                viewBeforeTimelineRef.current = view === "players" ? "players" : "game";
                setActiveDrawer(null);
                setView("timeline");
              }}
            >
              {t("pastGameTimeline")}
            </button>
            <button
              type="button"
              onClick={() => {
                viewBeforeConsoleRef.current = view === "players" ? "players" : "game";
                setActiveDrawer(null);
                setView("console");
              }}
            >
              {t("console")}
            </button>
            <button type="button" onClick={() => setBackgroundShade(nextBackgroundShade)}>
              {t("useBackground", {
                background: t(backgroundShadeMessageKey[nextBackgroundShade]),
              })}
            </button>
            <button
              type="button"
              aria-pressed={devModeEnabled}
              onClick={() => setDevModeEnabled((enabled) => !enabled)}
            >
              {devModeEnabled ? t("disableDevMode") : t("enableDevMode")}
            </button>
            <button
              type="button"
              className="danger-action"
              disabled={clearingAllData}
              onClick={() => void clearApplicationData()}
            >
              {clearingAllData ? t("clearing") : t("clearAllData")}
            </button>
          </div>
          {clearAllDataError ? (
            <p className="dev-menu-error" role="alert">
              {t("clearDataFailed")}
            </p>
          ) : null}
        </aside>
      ) : null}

      {isManager && view === "console" ? (
        <ErrorConsoleScreen onBack={() => setView(viewBeforeConsoleRef.current)} />
      ) : isManager && view === "timeline" ? (
        <GameTimelineScreen
          clubId={club.id}
          players={players}
          onBack={() => setView(viewBeforeTimelineRef.current)}
          showDevelopmentTools={devModeEnabled}
          currentHistory={currentTimelineHistory}
          onPreviewCurrentEvent={(eventId) => {
            previewEventState(eventId);
            setView("game");
          }}
          {...(finalResults === null
            ? {
                onResetCurrentEvent: (eventId: string) => {
                  void resetToEventState(eventId).then((reset) => {
                    if (reset) setView("game");
                  });
                },
              }
            : {})}
        />
      ) : isManager && view === "players" ? (
        <>
          {playerGateError !== null ? (
            <p className="player-gate-error" role="alert">
              {t(playerGateError.key, { count: playerGateError.count })}
            </p>
          ) : null}
          {playersError ? (
            <p className="players-load-error" role="alert">
              {t("playerProfilesUnavailable")}
            </p>
          ) : null}
          <PlayersScreen
            players={players}
            onCreate={createProfile}
            onUpdate={updateProfile}
            onDelete={deleteProfile}
            deletionProtectedPlayerIds={deletionProtectedPlayerIds}
          />
        </>
      ) : game === null && availabilityScreenOpen ? (
        <AvailablePlayersScreen
          players={players}
          availablePlayerIds={availablePlayerIds}
          onAvailabilityChange={updatePlayerAvailability}
          onClose={() => setAvailabilityScreenOpen(false)}
        />
      ) : game === null ? (
        <>
          <SetupWizard
            key={setupInstanceKey}
            players={availablePlayersForSetup}
            bestMoveEnabled={club.bestMoveEnabled}
            showDevelopmentTools={isManager && devModeEnabled}
            onPopulateDevelopmentPlayers={populateDevelopmentPlayers}
            onOpenAvailablePlayers={() => setAvailabilityScreenOpen(true)}
            privacyHidden={privacyHidden}
            initialSessionState={setupSession}
            onSessionStateChange={handleSetupSessionChange}
            onEvent={logEvent}
            onStartGame={() => {
              musicRef.current?.startOpeningQueue();
            }}
            onComplete={(next, selectedHostPlayerId, selectedHostName) => {
              const baseline: InitialGameBaseline = { replayVersion: 1, game: next };
              const gameId = sessionSync.gameId ?? createRandomId();
              sessionSync.ensureGameId(gameId);
              const sequence =
                Math.max(0, ...legacyLogRef.current.map((entry) => entry.sequence)) + 1;
              const started = createGameLogEntry({
                gameId,
                id: createRandomId(),
                sequence,
                parentEventId: null,
                createdAt: new Date().toISOString(),
                before: next,
                draft: { type: "game.checkpointed", payload: {} },
              });
              initialGameRef.current = baseline;
              eventsRef.current = [started.entry];
              headEventIdRef.current = started.entry.id;
              canonicalGameRef.current = next;
              hasIntermediateDraftRef.current = false;
              setInitialGame(baseline);
              setEvents([started.entry]);
              setHeadEventId(started.entry.id);
              setResetReturnEventId(null);
              setUndoBudget(0);
              phaseRef.current = next.phase;
              setSetupSession(null);
              setHostPlayerId(selectedHostPlayerId);
              setHostName(selectedHostName);
              setFinalResults(null);
              if (musicState === "playing") musicRef.current?.playFirstRegularTrack();
              setGame(next);
            }}
          />
        </>
      ) : (
        <GameScreen
          key={`${previewGame === null ? "live" : "preview"}-${renderedGameScreenMutationGeneration}`}
          game={previewGame ?? game}
          gameName={sessionName}
          hostName={hostName ?? t("host")}
          onGameChange={(nextGame) => {
            if (canApplyGameScreenMutation()) changeGame(nextGame);
          }}
          onEvent={(type, payload) => {
            if (canApplyGameScreenMutation()) logEvent(type, payload);
          }}
          onAcceptedEvent={(draft) => {
            if (canApplyGameScreenMutation()) acceptGameEvent(draft);
          }}
          mode={previewGame === null ? "live" : "preview"}
          previewSequence={previewEntry?.sequence}
          onExitPreview={exitPreview}
          canResetPreview={finalResults === null}
          onResetPreview={() => {
            if (previewTargetEventId !== null) resetToEventState(previewTargetEventId);
          }}
          privacyHidden={privacyHidden}
          clubLogo={club.headerLogo}
          clubName={club.name}
          finishGameState={finishGameState}
          onFinishGame={() => {
            if (canApplyGameScreenMutation()) void finishGame();
          }}
        />
      )}

      <LiveSidePanel game={view === "game" ? (previewGame ?? game) : null} hidden={view !== "game"}>
        {isManager ? (
          <MusicDock
            expanded={musicPlayerExpanded}
            onExpandedChange={setMusicPlayerExpanded}
            hidden={view !== "game"}
            isPlaying={musicState === "playing"}
            canFadeIn={musicState === "paused"}
            onFadeIn={() => {
              void musicRef.current?.fadeIn();
            }}
            onQuickFadeOut={() => {
              void musicRef.current?.quickFadeOut();
            }}
            onSlowFadeOut={() => {
              void musicRef.current?.slowFadeOut();
            }}
          >
            <YouTubePlaylistPlayer
              ref={musicRef}
              playlistId={playlistId}
              onStateChange={handleMusicState}
              expanded={musicPlayerExpanded}
              reloadRequest={musicReloadRequest}
              rememberedQueueOrder={
                musicPreferences.lastPlaylistId === playlistId ? musicPreferences.queueOrder : []
              }
              onQueueOrderChange={changeQueueOrder}
              initialStageEntryKeys={
                musicPreferences.lastPlaylistId === playlistId
                  ? musicPreferences.initialStageEntryKeys
                  : []
              }
              onInitialStageEntryKeysChange={(changedPlaylistId, entryKeys) =>
                changeQueueTags("initialStageEntryKeys", changedPlaylistId, entryKeys)
              }
              endgameEntryKeys={
                musicPreferences.lastPlaylistId === playlistId
                  ? musicPreferences.endgameEntryKeys
                  : []
              }
              onEndgameEntryKeysChange={(changedPlaylistId, entryKeys) =>
                changeQueueTags("endgameEntryKeys", changedPlaylistId, entryKeys)
              }
            />
          </MusicDock>
        ) : null}
      </LiveSidePanel>
    </div>
  );

  return (
    <LightingRendererContext.Provider value={lighting}>
      <VgpuLightingProvider
        enabled={lighting.requestedRenderer === "vgpu"}
        generation={lighting.vgpuGeneration}
        onReady={reportVgpuReady}
        onFailure={reportVgpuFailure}
      >
        {content}
        {claimInitializing ? (
          <aside className="claim-conflict-banner" role="status">
            <p>{t("claimSecuring")}</p>
          </aside>
        ) : null}
        {claimConflict !== null && !claimDialogOpen ? (
          <aside className="claim-conflict-banner" role="status">
            <p>{t("claimConflictBlocked")}</p>
            <div className="claim-conflict-actions">
              <button type="button" onClick={() => setClaimDialogOpen(true)}>
                {t("claimConflictResolve")}
              </button>
              <button type="button" onClick={exitWorkspace}>
                {t("claimConflictExit")}
              </button>
            </div>
          </aside>
        ) : null}
        {claimConflict === null || !claimDialogOpen ? null : (
          <div className="claim-conflict-backdrop">
            <section
              className="claim-conflict-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="claim-conflict-title"
              aria-describedby="claim-conflict-description"
            >
              <p className="eyebrow">{t("claimConflictEyebrow")}</p>
              <h2 id="claim-conflict-title">{t("claimConflictTitle")}</h2>
              <p id="claim-conflict-description">
                {claimConflict.action === "replace-local"
                  ? t("claimConflictActiveGameBody", {
                      game: claimConflict.gameName ?? t("claimConflictUnknownGame"),
                    })
                  : t("claimConflictBody", {
                      holder: claimConflict.holderName ?? t("claimConflictUnknownHolder"),
                    })}
              </p>
              <dl className="claim-conflict-details">
                {claimConflict.claimedAt === null ? null : (
                  <div>
                    <dt>{t("claimConflictClaimedAt")}</dt>
                    <dd>{formatTime(claimConflict.claimedAt)}</dd>
                  </div>
                )}
                {claimConflict.lastSeenAt === null ? null : (
                  <div>
                    <dt>{t("claimConflictLastSeen")}</dt>
                    <dd>{formatTime(claimConflict.lastSeenAt)}</dd>
                  </div>
                )}
                {claimConflict.expiresAt === null ? null : (
                  <div>
                    <dt>{t("claimConflictExpires")}</dt>
                    <dd>{formatTime(claimConflict.expiresAt)}</dd>
                  </div>
                )}
              </dl>
              {takeoverError ? <p role="alert">{t("claimConflictTakeoverError")}</p> : null}
              <div className="claim-conflict-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setClaimDialogOpen(false)}
                  autoFocus
                >
                  {t("claimConflictCancel")}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void takeOverSession()}
                  disabled={takeoverPending}
                >
                  {takeoverPending ? t("claimConflictTakingOver") : t("claimConflictTakeOver")}
                </button>
              </div>
            </section>
          </div>
        )}
      </VgpuLightingProvider>
    </LightingRendererContext.Provider>
  );
};

export const App = () => {
  const { locale, setLocale, t } = useMessages(shellMessages);
  const portalLocale = useRef(locale).current;
  const [themeColor, setThemeColor] = useState(() => readThemeColor(window.localStorage));
  const [user, setUser] = useState<AppUser | null>(null);
  const [authConfigured, setAuthConfigured] = useState<boolean | null>(null);
  const [authUnavailable, setAuthUnavailable] = useState(false);
  const [clubs, setClubs] = useState<readonly Club[]>([]);
  const [selectedClub, setSelectedClub] = useState<Club | null>(null);
  const [editingClub, setEditingClub] = useState<Club | "new" | null>(null);
  const [openingCurtains, setOpeningCurtains] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ShellMessageKey | null>(null);

  useEffect(() => {
    setLocale(selectedClub?.language ?? portalLocale);
  }, [portalLocale, selectedClub?.language, setLocale]);

  useEffect(() => {
    applyThemeColor(document.documentElement, window.localStorage, themeColor);
  }, [themeColor]);

  const refreshClubs = useCallback(async () => {
    setLoading(true);
    try {
      setClubs(await listClubs());
      setError(null);
    } catch (error) {
      reportError(error, { source: "api", context: "clubs.list" });
      setError("clubsUnavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let current = true;
    void getAuthSession()
      .then((session) => {
        if (!current) return;
        setAuthConfigured(session.configured);
        setAuthUnavailable(false);
        setUser(session.user);
        setError(null);
      })
      .catch((error: unknown) => {
        reportError(error, { source: "api", context: "auth.session" });
        if (current) setAuthUnavailable(true);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (user !== null) void refreshClubs();
  }, [refreshClubs, user]);

  const endSession = async () => {
    setLoading(true);
    try {
      await signOut();
      clearGameSessionStorage(window.localStorage);
      clearGameSessionStorage(window.sessionStorage);
      setUser(null);
      setClubs([]);
      setSelectedClub(null);
      setEditingClub(null);
      setError(null);
    } catch (error) {
      reportError(error, { source: "api", context: "auth.sign-out" });
      setError("signOutFailed");
    } finally {
      setLoading(false);
    }
  };

  const saveClub = async (clubId: string | null, input: ClubInput | ClubUpdateInput) => {
    if (user === null) throw new Error("Sign in before editing a club");
    try {
      if (clubId === null && (!("ownerConsent" in input) || input.ownerConsent !== true)) {
        throw new Error("Owner profile consent is required to create a club");
      }
      const saved =
        clubId === null
          ? await createClub(input as ClubInput)
          : await updateClub(clubId, input as ClubUpdateInput);
      setClubs((current) =>
        clubId === null
          ? [...current, saved]
          : current.map((club) => (club.id === clubId ? saved : club)),
      );
      setError(null);
    } catch (saveError) {
      reportError(saveError, { source: "api", context: "clubs.save" });
      setError("clubSaveFailed");
      throw saveError;
    }
  };

  const removeClub = async (club: Club) => {
    if (user === null) throw new Error("Sign in before deleting a club");
    if (!window.confirm(t("deleteClubConfirmation", { name: club.name }))) {
      return;
    }
    try {
      await deleteClub(club.id);
      window.localStorage.removeItem(gameSessionStorageKey(club.id));
      window.localStorage.removeItem(legacyGameSessionStorageKey(club.id));
      window.sessionStorage.removeItem(gameSessionStorageKey(club.id));
      window.sessionStorage.removeItem(legacyGameSessionStorageKey(club.id));
      window.localStorage.removeItem(availablePlayerStorageKey(club.id));
      setClubs((current) => current.filter(({ id }) => id !== club.id));
      setSelectedClub(null);
      setEditingClub(null);
      setError(null);
    } catch (error) {
      reportError(error, { source: "api", context: "clubs.delete" });
      setError("clubDeleteFailed");
    }
  };

  const openClub = (club: Club) => {
    setEditingClub(null);
    setSelectedClub(club);
    setOpeningCurtains(true);
    window.setTimeout(() => setOpeningCurtains(false), 900);
  };

  const changeSelectedClubLanguage = async (language: Locale) => {
    if (selectedClub === null) return;
    const saved = await updateClub(selectedClub.id, {
      name: selectedClub.name,
      city: selectedClub.city,
      headerLogo: selectedClub.headerLogo,
      cardLogo: selectedClub.cardLogo,
      language,
      bestMoveEnabled: selectedClub.bestMoveEnabled,
    });
    setSelectedClub(saved);
    setClubs((current) => current.map((club) => (club.id === saved.id ? saved : club)));
  };

  if (selectedClub !== null) {
    return (
      <>
        <ClubWorkspace
          key={selectedClub.id}
          club={selectedClub}
          onExit={() => {
            setSelectedClub(null);
            setEditingClub(null);
          }}
          onEditClub={() => {
            setSelectedClub(null);
            setEditingClub(selectedClub);
          }}
          onDeleteClub={() => removeClub(selectedClub)}
          onLanguageChange={changeSelectedClubLanguage}
          themeColor={themeColor}
          onThemeColorChange={setThemeColor}
        />
        {openingCurtains ? (
          <div className="club-curtain-opening" aria-hidden="true">
            <div className="curtain curtain-left" />
            <div className="curtain curtain-right" />
          </div>
        ) : null}
      </>
    );
  }

  return (
    <ClubPortal
      user={user}
      authConfigured={authConfigured}
      authUnavailable={authUnavailable}
      themeColor={themeColor}
      clubs={clubs}
      loading={loading}
      error={error === null ? null : t(error)}
      editing={editingClub}
      onSignOut={endSession}
      onThemeColorChange={setThemeColor}
      onEditingChange={setEditingClub}
      onSaveClub={saveClub}
      onOpenClub={openClub}
    />
  );
};

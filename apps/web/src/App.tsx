import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  applyGameEvent,
  CASPER_PLAYER_ID,
  FEDERATION_RULES_EDITION,
  createGameLogEntry,
  isFederationGame,
  createInitialGameBaseline,
  hashGameState,
  isCasperPlayer,
  isMeaningfulGameEventDraft,
  isTerminalGamePhase,
  replayGameLog,
  selectVotingCandidate,
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
import { ShotObservationDetails } from "./features/night/ShotObservationDetails.js";
import {
  ApiError,
  checkServerReady,
  clearGameSession,
  createGameSession,
  createPlayer,
  deletePlayer,
  getAuthSession,
  getAppVersion,
  getGameSession,
  listActiveGameSessions,
  listPlayers,
  saveGameSessionOperation,
  updatePlayer,
  createClub,
  deleteClub,
  getMusicAccountStatus,
  listClubs,
  signOut,
  updateClub,
} from "./api/client.js";
import type {
  ActiveGameSessionSummary,
  CurrentGameSessionState,
  FinalGameResults,
  GameSessionState,
  MusicAccountStatus,
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
  clearDeveloperPreferences,
  readDeveloperPreferences,
  writeDeveloperModeEnabled,
  writeDeveloperUnlocked,
} from "./features/developer/developer-preferences.js";
import {
  createLightingRendererState,
  LightingRendererContext,
  lightingRendererReducer,
} from "./features/effects/LightingRendererContext.js";
import {
  writeLightingRenderer,
  writePlayerPulse,
  type LightingRenderer,
  type PlayerPulseSettings,
} from "./features/effects/lighting-preferences.js";
import { VgpuLightingProvider } from "./features/effects/vgpu/VgpuLightingProvider.js";
import { GameScreen } from "./features/game/GameScreen.js";
import { AdjudicationControls } from "./features/game/AdjudicationControls.js";
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
import { PlayerDirectoryProvider } from "./features/players/player-display.js";
import { useMessages, type FeatureI18n, type Locale } from "./i18n/I18nProvider.js";
import { LanguageSelector } from "./i18n/LanguageSelector.js";
import { shellMessages, type ShellMessageKey } from "./i18n/messages/shell.js";

import {
  clearApplicationBrowserStorage,
  clearApplicationBrowserStorageLocked,
  clearBrowserGameStorage,
  clearBrowserGameStorageForClub,
  clearBrowserGameStorageForClubLocked,
  discardBrowserGameStorage,
  discardInvalidBrowserGameStorage,
  prepareBrowserGameStorage,
  readBrowserGameAttachment,
  readBrowserGameStorageState,
  releaseBrowserGameStorage,
  type BrowserGameAttachment,
  type BrowserGameStorageState,
} from "./browser-game-storage.js";
import {
  BrowserGameStorageBusyError,
  type BrowserGameStorageGuard,
  withBrowserGameStorageGuard,
} from "./browser-game-storage-lock.js";

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
  "mafia-sleep": "phaseMafiaSleep",
  "don-identification": "phaseDonIdentification",
  "sheriff-identification": "phaseSheriffIdentification",
  "free-seating": "phaseFreeSeating",
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
  draw: "phaseDraw",
  cancelled: "phaseCancelled",
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
  "car-crash.count-completed": "eventCollectiveCountCompleted",
  "mafia.shots-resolved": "eventMafiaShotsResolved",
  "don.checked": "eventDonChecked",
  "don.check-skipped": "eventDonCheckSkipped",
  "sheriff.checked": "eventSheriffChecked",
  "sheriff.check-skipped": "eventSheriffCheckSkipped",
  "best-move.completed": "eventBestMoveCompleted",
  "game.completed": "eventGameCompleted",
  "game.drawn": "eventGameDrawn",
  "game.cancelled": "eventGameCancelled",
  "voting.order-announced": "eventOrderAnnounced",
  "voting.candidate-mentioned": "eventCandidateMentioned",
  "voting.candidate-inspected": "eventCandidateInspected",
  "voting.candidate-stopped": "eventCandidateStopped",
  "voting.live-advanced": "eventLiveAdvanced",
  "vote.accepted": "eventVoteAccepted",
  "vote.recorded": "eventVoteRecorded",
  "voting.candidate-selected": "eventCandidateSelected",
  "vote.corrected": "eventVoteCorrected",
  "voting.count-disputed": "eventCountDisputed",
  "voting.count-ruled": "eventCountRuled",
  "voting.legally-skipped": "eventVotingSkipped",
  "mafia.multiple-shot-observed": "eventMultipleShot",
  "mafia.shots-observed": "eventPhysicalShotsObserved",
  "best-move.number-accepted": "eventBestMoveNumber",
  "best-move.slip-corrected": "eventBestMoveSlip",
  "best-move.finalized": "eventBestMoveCompleted",
  "game.adjudicated": "eventAdjudicated",
  "discipline.removal-observed": "eventRemovalObserved",
  "discipline.removals-announced": "eventRemovalsAnnounced",
  "discipline.foul-issued": "eventFoulIssued",
};
const phaseLabel = (phase: string, t: ShellTranslator): string =>
  t(phaseMessageKeys[phase] ?? "unknownPhase", { value: phase });
const eventLabel = (eventType: string, t: ShellTranslator): string =>
  t(eventMessageKeys[eventType] ?? "unknownEvent", { value: eventType });

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
const nextGameName = (storage: Storage, now: Date): string => {
  const date = [now.getDate(), now.getMonth() + 1, now.getFullYear() % 100]
    .map((value) => String(value).padStart(2, "0"))
    .join(".");
  const key = `mafia-dashboard.game-sequence.${date}`;
  const next = Math.max(0, Number(storage.getItem(key)) || 0) + 1;
  storage.setItem(key, String(next));
  return `${date} #${next}`;
};

interface PersistedState extends CurrentGameSessionState {
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

const setupHumanPlayerIds = (setup: SetupWizardSessionState | null) =>
  [setup?.hostPlayerId ?? "", ...(setup?.selectedPlayerIds ?? [])].filter(
    (id) => id !== "" && id !== CASPER_PLAYER_ID,
  );

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

const asPersistedState = (state: GameSessionState | undefined): PersistedState => {
  if (state === undefined) {
    return {
      setup: null,
      game: null,
      hostPlayerId: null,
      playlistId: defaultPlaylistId,
      log: [],
      undoHistory: [],
      undoBudget: 0,
      initialGame: null,
      events: [],
      headEventId: null,
      resetReturnEventId: null,
      legacyLog: [],
    };
  }
  return {
    ...state,
    setup: state.setup as SetupWizardSessionState | null,
    game: state.game as GameState | null,
    log: state.log as readonly LocalLogEntry[],
    undoBudget: state.undoBudget as number,
    initialGame: state.initialGame as InitialGameBaseline | null,
    events: state.events as readonly GameLogEntry[],
    headEventId: state.headEventId as string | null,
    resetReturnEventId: state.resetReturnEventId as string | null,
    legacyLog: state.legacyLog as readonly LocalLogEntry[],
  };
};

export const ClubWorkspace = ({
  club,
  storageGuard,
  onExit,
  onEditClub,
  onDeleteClub,
  onLanguageChange = () => Promise.resolve(),
  themeColor = DEFAULT_THEME_COLOR,
  onThemeColorChange = () => undefined,
}: {
  readonly club: Club;
  readonly storageGuard?: BrowserGameStorageGuard;
  readonly onExit: () => void;
  readonly onEditClub: () => void;
  readonly onDeleteClub: () => Promise<void>;
  readonly onLanguageChange?: (language: Locale) => Promise<void>;
  readonly themeColor?: string;
  readonly onThemeColorChange?: (color: string) => void;
}) => {
  const { t, formatTime } = useMessages(shellMessages);
  const isManager = club.role === "manager";
  const sessionSyncRef = useRef<GameSessionOutbox | null>(null);
  if (sessionSyncRef.current === null) {
    sessionSyncRef.current = new GameSessionOutbox({
      storage: window.localStorage,
      storageGuard,
      clubId: club.id,
      createId: createRandomId,
      create: (input) => createGameSession(input, club.id),
      save: (gameId, operation) => saveGameSessionOperation(gameId, operation, club.id),
    });
  }
  const sessionSync = sessionSyncRef.current;
  const sessionRetryRef = useRef<SessionRetryController | null>(null);
  if (sessionRetryRef.current === null) {
    sessionRetryRef.current = new SessionRetryController({
      flush: () => sessionSync.flush(),
      probe: checkServerReady,
      pendingCount: () => sessionSync.pendingCount,
      reportTerminal: (error) =>
        reportError(error, { source: "persistence", context: "game-session.offline" }),
    });
  }
  const sessionRetry = sessionRetryRef.current;
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
  // The saved game can contain an open ballot; only the retained event head is canonical.
  const initialCanonicalGame = (() => {
    if (initialState.initialGame === null) return initialState.game;
    try {
      return initialState.headEventId === null
        ? initialState.initialGame.game
        : replayGameLog(
            initialState.initialGame,
            getActiveBranch(initialState.events, initialState.headEventId),
          ).game;
    } catch (error) {
      reportError(error, { source: "persistence", context: "game-session.replay-initial" });
      return null;
    }
  })();
  const initialDerivedGame = initialState.game ?? initialCanonicalGame;
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
  const [finalResults, setFinalResults] = useState<FinalGameResults | null>(
    initialCurrent?.results ?? null,
  );
  const [finishGameState, setFinishGameState] = useState<
    "ready" | "saving" | "saved" | "queued" | "blocked"
  >(
    initialCurrent?.results === null || initialCurrent?.results === undefined
      ? "ready"
      : sessionSync.pendingCount > 0
        ? "queued"
        : "saved",
  );
  const [players, setPlayers] = useState<readonly PlayerProfile[]>([]);
  const [playersLoaded, setPlayersLoaded] = useState(false);
  const [availablePlayerIds, setAvailablePlayerIds] = useState<ReadonlySet<string>>(
    () =>
      new Set([
        ...readAvailablePlayerIds(window.localStorage, club.id),
        ...setupHumanPlayerIds(initialState.setup),
      ]),
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
  const [musicAccountStatus, setMusicAccountStatus] = useState<MusicAccountStatus | null>(null);
  const [musicAccountStatusError, setMusicAccountStatusError] = useState(false);
  const [musicAccountStatusRequest, setMusicAccountStatusRequest] = useState(0);
  const musicAccountStatusRevision = useRef(0);

  useEffect(() => {
    if (!isManager) return undefined;
    let current = true;
    const revision = ++musicAccountStatusRevision.current;
    setMusicAccountStatusError(false);
    void getMusicAccountStatus()
      .then((status) => {
        if (current && revision === musicAccountStatusRevision.current)
          setMusicAccountStatus(status);
      })
      .catch((error: unknown) => {
        reportError(error, { source: "api", context: "music-account.status" });
        if (current && revision === musicAccountStatusRevision.current)
          setMusicAccountStatusError(true);
      });
    return () => {
      current = false;
    };
  }, [club.id, isManager, musicAccountStatusRequest]);

  const changePlaylistId = useCallback(
    (nextPlaylistId: string) => {
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
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [appVersionUnavailable, setAppVersionUnavailable] = useState(false);
  const [roleDrawBackAction, setRoleDrawBackAction] = useState<(() => void) | null>(null);
  const [musicSetupOpen, setMusicSetupOpen] = useState(false);
  const [backgroundShade, setBackgroundShade] = useState<BackgroundShade>("black");
  const [lighting, dispatchLighting] = useReducer(
    lightingRendererReducer,
    window.localStorage,
    createLightingRendererState,
  );

  const [initialDeveloperPreferences] = useState(() =>
    readDeveloperPreferences(window.localStorage),
  );
  const [devModeEnabled, setDevModeEnabled] = useState(
    () => initialDeveloperPreferences.unlocked && initialDeveloperPreferences.devModeEnabled,
  );
  const [devUnlocked, setDevUnlocked] = useState(() => initialDeveloperPreferences.unlocked);
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
  const privacyButtonRef = useRef<HTMLButtonElement | null>(null);
  const restorePrivacyFocusRef = useRef(false);
  const preserveDrawerCloseFocusRef = useRef(false);
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
  const canonicalGameRef = useRef<GameState | null>(initialCanonicalGame);
  const legacyLogRef = useRef<readonly LocalLogEntry[]>(initialState.legacyLog);
  const previewTargetEventIdRef = useRef<string | null>(null);
  const gameScreenMutationGenerationRef = useRef(0);
  const liveGameBeforePreviewRef = useRef<GameState | null>(null);
  const hasIntermediateDraftRef = useRef(
    initialCanonicalGame !== null &&
      initialDerivedGame !== null &&
      hashGameState(initialDerivedGame) !== hashGameState(initialCanonicalGame),
  );
  const viewBeforeTimelineRef = useRef<Exclude<WorkspaceView, "timeline">>("game");
  const viewBeforeConsoleRef = useRef<"game" | "players">("game");
  const phaseRef = useRef(initialState.game?.phase ?? setupPhase(initialState.setup?.step));
  const playerRequestRef = useRef(0);
  const activeSessionsRequestRef = useRef(0);
  const resumeRequestRef = useRef(0);
  const unavailableGameIdsRef = useRef(new Set<string>());
  const persistedResultsRef = useRef<FinalGameResults | null>(initialCurrent?.results ?? null);
  const finishRequestedRef = useRef(initialCurrent?.results != null);
  const finalizingCompletionRef = useRef(false);
  const fullscreenTarget = document.documentElement as WebkitFullscreenElement;
  const fullscreenDocument = document as WebkitFullscreenDocument;
  const fullscreenAvailable =
    typeof fullscreenTarget.requestFullscreen === "function" ||
    typeof fullscreenTarget.webkitRequestFullscreen === "function";

  useEffect(() => {
    const previousDrawer = previousDrawerRef.current;
    if (activeDrawer === null) {
      if (
        previousDrawer !== null &&
        !preserveDrawerCloseFocusRef.current &&
        drawerTriggerRef.current?.isConnected
      )
        drawerTriggerRef.current.focus();
      preserveDrawerCloseFocusRef.current = false;
    } else {
      drawerRef.current?.querySelector<HTMLElement>("h2")?.focus();
    }
    previousDrawerRef.current = activeDrawer;
  }, [activeDrawer]);

  useEffect(() => {
    if (!restorePrivacyFocusRef.current) return;
    restorePrivacyFocusRef.current = false;
    privacyButtonRef.current?.focus();
  }, [devUnlocked]);

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
    !sessionSync.isCreating &&
    !sessionSync.isRemoved &&
    previewTargetEventIdRef.current === null &&
    gameScreenMutationGenerationRef.current === renderedGameScreenMutationGeneration;

  const refreshPlayers = useCallback(async () => {
    const request = playerRequestRef.current + 1;
    playerRequestRef.current = request;
    try {
      const nextPlayers = await listPlayers(club.id);
      if (playerRequestRef.current === request) {
        setPlayers(nextPlayers);
        setPlayersLoaded(true);
        setPlayersError(false);
        // Synthetic Casper never counts as a registered human; names alone are not reserved.
        if (isManager && nextPlayers.filter((player) => !isCasperPlayer(player)).length < 10)
          setView("players");
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
        const canonicalName = current?.name;
        if (canonicalName !== undefined) setSessionName(canonicalName);
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
    const gameId = sessionSync.gameId;
    if (sessionSync.needsRemoteVerification && gameId !== null) {
      void getGameSession(gameId, club.id)
        .then(() => {
          if (!active) return;
          sessionSync.confirmRemoteGame(gameId);
          sessionRetry.requestAutoSync();
        })
        .catch((error: unknown) => {
          if (!active) return;
          if (error instanceof ApiError && error.status === 404) {
            sessionSync.adoptLegacyDraft();
            sessionRetry.requestAutoSync();
            return;
          }
          reportError(error, { source: "api", context: "game-session.verify-legacy" });
        });
    } else {
      sessionRetry.requestAutoSync();
    }
    return () => {
      active = false;
    };
  }, [club.id, sessionRetry, sessionSync]);

  useEffect(() => {
    const recover = () => sessionRetry.requestAutoSync();
    window.addEventListener("online", recover);
    return () => window.removeEventListener("online", recover);
  }, [sessionRetry]);

  useEffect(() => {
    const snapshot = {
      setup: setupSession,
      game,
      hostPlayerId,
      playlistId,
      log,
      undoHistory: [],
      undoBudget,
      initialGame,
      events,
      headEventId,
      resetReturnEventId,
      legacyLog,
    } as CurrentGameSessionState;
    if (sessionSync.gameId === null && !sessionSync.isCreating) {
      if (
        !sessionSync.needsRemoteVerification &&
        !sessionSync.isRemoved &&
        setupSession !== null &&
        hasSetupProgress(setupSession)
      ) {
        sessionSync.beginCreation(sessionName, snapshot, finalResults);
        sessionRetry.requestAutoSync();
      }
      return;
    }
    sessionSync.enqueue(sessionName, snapshot, finalResults);
    sessionRetry.requestAutoSync();
  }, [
    finalResults,
    events,
    game,
    headEventId,
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
    const { phase, terminalReason } = sessionRetry.getSnapshot();
    setFinishGameState(
      phase === "offline"
        ? terminalReason === "rejected"
          ? "blocked"
          : "queued"
        : phase === "saved"
          ? "saved"
          : "saving",
    );
  }, [finalResults, sessionRetry, syncRender]);

  const logEvent = useCallback(
    (type: string, payload: Record<string, unknown>) => {
      if (previewTargetEventIdRef.current !== null || isAuxiliaryEvent(type)) return;
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
    if (previewTargetEventIdRef.current !== null) return;
    const canonical = canonicalGameRef.current;
    hasIntermediateDraftRef.current =
      canonical !== null && hashGameState(next) !== hashGameState(canonical);
    setGame(next);
  };

  const acceptGameEvent = useCallback(
    (draft: CanonicalGameEventDraft) => {
      if (previewTargetEventIdRef.current !== null) return;
      const baseline = initialGameRef.current;
      const before = canonicalGameRef.current;
      const gameId = sessionSync.gameId;
      if (baseline === null || before === null || gameId === null) return;
      // V1 folds provisional turns into later decisions. V2 reducers require the
      // exact accepted phase/cursor, so judge progression must also be canonical.
      if (!isFederationGame(before) && !isMeaningfulGameEventDraft(draft)) {
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
      if (created.after.phase !== "finished") {
        setFinalResults(null);
        setFinishGameState("ready");
      }
    },
    [game, sessionSync],
  );

  const moveHeadLocally = useCallback((targetEventId: string | null) => {
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
    setFinalResults(null);
    setFinishGameState("ready");
  }, []);

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
    if (sessionSync.isCreating || sessionSync.isRemoved) return;
    if (
      game === null ||
      !isTerminalGamePhase(game.phase) ||
      hostPlayerId === null ||
      finalResults !== null ||
      finishRequestedRef.current
    )
      return;
    const outcomeEvent = eventsRef.current.find(({ id }) => id === headEventIdRef.current);
    const reason =
      outcomeEvent?.type === "game.drawn" || outcomeEvent?.type === "game.cancelled"
        ? outcomeEvent.payload.reason
        : null;
    let playedAt = outcomeEvent?.createdAt;
    if (game.phase === "finished" && game.winner !== null) {
      acceptGameEvent({ type: "game.completed", payload: { winner: game.winner } });
      playedAt = eventsRef.current.at(-1)?.createdAt;
    } else if (
      (game.phase === "draw" &&
        game.rulesDrawReason === undefined &&
        outcomeEvent?.type !== "game.drawn") ||
      (game.phase === "cancelled" && outcomeEvent?.type !== "game.cancelled")
    )
      return;
    const results = buildFinalGameResults(
      game,
      new Date(playedAt ?? Date.now()),
      hostPlayerId,
      reason,
    );
    if (results === null) return;
    finishRequestedRef.current = true;
    setFinishGameState("saving");
    setFinalResults(results);
    sessionSync.enqueue(
      sessionName,
      {
        setup: setupSession,
        game,
        hostPlayerId,
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
      } as CurrentGameSessionState,
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
    if (
      !available &&
      game === null &&
      setupSession !== null &&
      (setupSession.hostPlayerId === playerId || setupSession.selectedPlayerIds.includes(playerId))
    ) {
      // The wizard is unmounted in the availability screen. Save deliberate
      // removals now, rather than waiting for it to prune selections on return.
      handleSetupSessionChange({
        ...setupSession,
        step: "players",
        hostPlayerId:
          setupSession.hostPlayerId === playerId ? "" : (setupSession.hostPlayerId ?? ""),
        selectedPlayerIds: setupSession.selectedPlayerIds.map((id) => (id === playerId ? "" : id)),
        setup: null,
      });
    }
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
      if (sessionSync.isRemoved) return;
      // A local edit supersedes any GET that was started from the Manage drawer.
      resumeRequestRef.current += 1;
      phaseRef.current = setupPhase(next.step);
      setSetupSession((current) =>
        hasSetupProgress(next) || current !== null
          ? {
              ...next,
              bestMoveEnabled:
                current?.bestMoveEnabled ?? next.bestMoveEnabled ?? club.bestMoveEnabled,
            }
          : null,
      );
      const nextHostId = next.hostPlayerId;
      if (nextHostId === undefined || nextHostId === "") {
        setHostPlayerId(null);
        return;
      }
      setHostPlayerId(nextHostId);
    },
    [club.bestMoveEnabled, sessionSync],
  );

  const applyRemoteSession = useCallback(
    (session: RemoteGameSession) => {
      sessionSync.activateRemote({ ...session, state: asPersistedState(session.state) });
      const current = sessionSync.current;
      if (current === null) return;
      const restored = asPersistedState(current.state);
      gameScreenMutationGenerationRef.current += 1;
      setSessionName(current.name);
      let canonicalRestoredGame: GameState | null = restored.game;
      if (restored.initialGame !== null) {
        try {
          canonicalRestoredGame =
            restored.headEventId === null
              ? restored.initialGame.game
              : replayGameLog(
                  restored.initialGame,
                  getActiveBranch(restored.events, restored.headEventId),
                ).game;
        } catch (error) {
          reportError(error, { source: "persistence", context: "game-session.replay-resumed" });
          canonicalRestoredGame = null;
        }
      }
      const restoredGame = restored.game ?? canonicalRestoredGame;
      hasIntermediateDraftRef.current =
        canonicalRestoredGame !== null &&
        restoredGame !== null &&
        hashGameState(restoredGame) !== hashGameState(canonicalRestoredGame);
      setGame(restoredGame);
      setInitialGame(restored.initialGame);
      initialGameRef.current = restored.initialGame;
      setEvents(restored.events);
      eventsRef.current = restored.events;
      setHeadEventId(restored.headEventId);
      headEventIdRef.current = restored.headEventId;
      canonicalGameRef.current = canonicalRestoredGame;
      setLegacyLog(restored.legacyLog);
      legacyLogRef.current = restored.legacyLog;
      setResetReturnEventId(restored.resetReturnEventId);
      setUndoBudget(
        restored.undoBudget ?? getRemainingUndoBudget(restored.events, restored.headEventId),
      );
      setSetupSession(restored.setup);
      setAvailablePlayerIds(
        (current) => new Set([...current, ...setupHumanPlayerIds(restored.setup)]),
      );
      setHostPlayerId(restored.hostPlayerId);
      setPlaylistId(restored.playlistId);
      setFinalResults(current.results);
      finishRequestedRef.current = current.results !== null;
      setFinishGameState(current.results === null ? "ready" : "saved");
      persistedResultsRef.current = current.results;
      phaseRef.current = restoredGame?.phase ?? setupPhase(restored.setup?.step);
      setSetupInstanceKey((key) => key + 1);
      setView("game");
      setAvailabilityScreenOpen(false);
    },
    [sessionSync],
  );

  const resumeSession = async (gameId: string) => {
    if (unavailableGameIdsRef.current.has(gameId)) return;
    const request = resumeRequestRef.current + 1;
    resumeRequestRef.current = request;
    setResumeGameId(gameId);
    setActiveSessionsError(false);
    try {
      // An unacknowledged draft cannot be parked under its eventual server ID.
      // Finish creation first; failures leave the latest editable setup active.
      if (sessionSync.isCreating) await sessionSync.flush();
      if (resumeRequestRef.current !== request || unavailableGameIdsRef.current.has(gameId)) return;
      const session = await getGameSession(gameId, club.id);
      if (resumeRequestRef.current !== request || unavailableGameIdsRef.current.has(gameId)) return;
      applyRemoteSession(session);
      sessionRetry.requestAutoSync();
    } catch (error) {
      reportError(error, { source: "api", context: "game-session.resume" });
      if (resumeRequestRef.current === request) setActiveSessionsError(true);
    } finally {
      if (resumeRequestRef.current === request) setResumeGameId(null);
    }
  };

  const exitWorkspace = () => onExit();

  const resetLocalState = useCallback(() => {
    setSessionName(nextGameName(window.localStorage, new Date()));
    setGame(null);
    setSetupSession(null);
    setHostPlayerId(null);
    setFinalResults(null);
    finishRequestedRef.current = false;
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
  }, []);

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

  const startNewGame = async (openAvailablePlayers = false) => {
    if (!window.confirm(t("startNewGameConfirmation"))) return;
    const request = ++resumeRequestRef.current;
    try {
      if (sessionSync.isCreating) await sessionSync.flush();
      if (resumeRequestRef.current !== request) return;
      sessionSync.park();
    } catch (error) {
      reportError(error, { source: "persistence", context: "game-session.park" });
      return;
    }
    resetLocalState();
    setAvailabilityScreenOpen(openAvailablePlayers);
    void refreshActiveSessions();
  };

  const deleteActiveSession = async (session: ActiveGameSessionSummary) => {
    if (!window.confirm(t("deleteSessionConfirmation", { name: session.name }))) return;
    // A delayed GET must not reopen a game whose deletion is pending or complete.
    unavailableGameIdsRef.current.add(session.gameId);
    const deletingCurrent = sessionSync.gameId === session.gameId;
    let deletionAcknowledged = false;
    setDeletingSessionId(session.gameId);
    setActiveSessionsError(false);
    try {
      if (deletingCurrent) {
        await sessionSync.clear((gameId) => clearGameSession(gameId, club.id));
        if (sessionSync.gameId === null) {
          resetLocalState();
        }
      } else {
        await clearGameSession(session.gameId, club.id);
      }
      deletionAcknowledged = true;
      setSwipedSessionId(null);
      await Promise.all([refreshActiveSessions(), refreshPlayers()]);
    } catch (error) {
      if (!deletionAcknowledged) unavailableGameIdsRef.current.delete(session.gameId);
      reportError(error, { source: "api", context: "game-session.delete" });
      setActiveSessionsError(true);
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
      if (storageGuard === undefined) {
        await clearApplicationBrowserStorage(window.localStorage, window.sessionStorage);
      } else {
        clearApplicationBrowserStorageLocked(
          window.localStorage,
          window.sessionStorage,
          storageGuard,
        );
      }
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
  const humanPlayers = players.filter((player) => !isCasperPlayer(player));
  const availablePlayersForSetup = humanPlayers.filter(({ id }) => availablePlayerIds.has(id));

  const persistenceSnapshot = sessionRetry.getSnapshot();
  const persistenceState =
    persistenceSnapshot.phase === "saved" && sessionSync.status === "offline"
      ? "offline"
      : persistenceSnapshot.phase;
  const pendingChanges = sessionSync.pendingCount;
  const pendingLabel = t("pendingChanges", { count: pendingChanges });
  const saveStatusLabel = sessionSync.isRemoved
    ? t("gameRemoved")
    : persistenceState === "saved"
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
      ? humanPlayers.length < 10
        ? t("needPlayers", { needed: 10, registered: humanPlayers.length })
        : t("availableRegistered", {
            available: availablePlayersForSetup.length,
            registered: humanPlayers.length,
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
  const updateRoleDrawBackAction = useCallback((action: (() => void) | null) => {
    setRoleDrawBackAction(() => action);
  }, []);
  const setPlayerPulse = useCallback((settings: PlayerPulseSettings) => {
    writePlayerPulse(window.localStorage, settings);
    dispatchLighting({ type: "set-player-pulse", settings });
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
  useEffect(() => {
    if (
      activeDrawer !== "dev" ||
      !isManager ||
      !devUnlocked ||
      !showWorkspaceTools ||
      appVersion !== null
    ) {
      return;
    }
    let active = true;
    setAppVersionUnavailable(false);
    void getAppVersion().then(
      (version) => {
        if (active) setAppVersion(version);
      },
      () => {
        if (active) setAppVersionUnavailable(true);
      },
    );
    return () => {
      active = false;
    };
  }, [activeDrawer, appVersion, devUnlocked, isManager, showWorkspaceTools]);

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
      writeDeveloperUnlocked(window.localStorage, true);
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
  const setDevelopmentToolsEnabled = useCallback(
    (enabled: boolean) => {
      if (!isManager || !devUnlocked) return;
      writeDeveloperModeEnabled(window.localStorage, enabled);
      setDevModeEnabled(enabled);
    },
    [devUnlocked, isManager],
  );
  const hideDeveloperMode = useCallback(() => {
    if (!isManager) return;
    clearDeveloperPreferences(window.localStorage);
    setDevModeEnabled(false);
    setDevUnlocked(false);
    setActiveDrawer(null);
    setPrivacyTapStage(0);
    if (privacyTapsRef.current.resetTimer !== null) {
      window.clearTimeout(privacyTapsRef.current.resetTimer);
    }
    privacyTapsRef.current = { count: 0, resetTimer: null };
    restorePrivacyFocusRef.current = true;
  }, [isManager]);
  const hasCurrentGameState =
    sessionSync.gameId !== null ||
    game !== null ||
    setupSession !== null ||
    playlistId !== defaultPlaylistId;
  const musicAccountConnected =
    isManager &&
    !musicAccountStatusError &&
    musicAccountStatus?.configured === true &&
    musicAccountStatus.connected === true;
  const toggleMusicSetup = () => {
    const next = !musicSetupOpen;
    setMusicSetupOpen(next);
    if (next && (musicAccountStatus !== null || musicAccountStatusError)) {
      setMusicAccountStatusRequest((request) => request + 1);
    }
  };
  const musicSetupPanel = musicSetupOpen ? (
    <section
      id="manage-music-setup"
      className="manage-music-setup"
      aria-label={t("musicPlayerSetup")}
    >
      {musicAccountConnected ? (
        <>
          <div className={`music-status ${musicState === "playing" ? "is-playing" : ""}`}>
            <span className="status-dot" />
            <strong>{musicLabel[musicState]}</strong>
          </div>
          <button type="button" onClick={() => setMusicReloadRequest((request) => request + 1)}>
            {t("reloadMusicPlayer")}
          </button>
        </>
      ) : null}
      <AccountPlaylistPicker
        playlistId={playlistId}
        onPlaylistIdChange={changePlaylistId}
        onAccountDisconnected={clearMusicAccountState}
        status={musicAccountStatus}
        statusError={musicAccountStatusError}
        onRetry={() => setMusicAccountStatusRequest((request) => request + 1)}
        onStatusChange={(status) => {
          musicAccountStatusRevision.current += 1;
          setMusicAccountStatusError(false);
          setMusicAccountStatus(status);
        }}
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
              <div className="session-swipe-content">
                <div>
                  <strong>{session.name}</strong>
                  <span>
                    {t("activeSessionSummary", {
                      host:
                        session.hostPlayerId === null
                          ? t("hostNotSelected")
                          : (players.find(({ id }) => id === session.hostPlayerId)?.nickname ??
                            t("player.anonymous")),
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
                <button
                  type="button"
                  className="session-delete-visible-action danger-action"
                  aria-label={t("deleteSession", { name: session.name })}
                  disabled={deletingSessionId === session.gameId}
                  onClick={() => void deleteActiveSession(session)}
                >
                  {deletingSessionId === session.gameId ? t("deleting") : t("delete")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  const content = (
    <div
      ref={appShellRef}
      className={`app-shell${backgroundShadeClass[backgroundShade]}${
        tableLayoutActive ? " has-live-game table-layout-shell" : ""
      }${view === "game" && game !== null ? " has-game-screen" : ""}${
        showApplicationStatus ? " has-top-level-screen" : ""
      }${isFullscreen ? " is-fullscreen" : ""}`}
      data-background-shade={backgroundShade}
      data-lighting-renderer={lighting.effectiveRenderer}
      data-lighting-renderer-requested={lighting.requestedRenderer}
      data-vgpu-status={lighting.vgpuStatus}
      data-player-pulse={lighting.playerPulse.enabled ? "enabled" : "disabled"}
      data-player-pulse-speed={lighting.playerPulse.speed}
      data-player-pulse-strength={lighting.playerPulse.strength}
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
              {view === "players" ? t("persistentPlayers") : t("gameSetupSession", { sessionName })}
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
            ref={privacyButtonRef}
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
                    {!privacyHidden && entry.type === "mafia.shots-observed" ? (
                      <ShotObservationDetails observations={entry.payload.observations} />
                    ) : null}
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
                if (view === "players" && humanPlayers.length < 10) {
                  setPlayerGateError({
                    key: "addRegisteredPlayers",
                    count: 10 - humanPlayers.length,
                  });
                  setActiveDrawer(null);
                  return;
                }
                setPlayerGateError(null);
                setActiveDrawer(null);
                const openAvailablePlayers = availablePlayersForSetup.length < 10;
                if (hasCurrentGameState) startNewGame(openAvailablePlayers);
                else {
                  resetLocalState();
                  setAvailabilityScreenOpen(openAvailablePlayers);
                }
              }}
            >
              {t("startNewGame")}
            </button>
            {roleDrawBackAction === null ? null : (
              <button
                type="button"
                onClick={() => {
                  preserveDrawerCloseFocusRef.current = true;
                  roleDrawBackAction();
                  setActiveDrawer(null);
                }}
              >
                {t("backToPlayerSelection")}
              </button>
            )}
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
                  onClick={toggleMusicSetup}
                >
                  {musicSetupOpen ? t("hideMusicPlayerSetup") : t("musicPlayerSetup")}
                </button>
                {!musicSetupOpen &&
                !musicAccountStatusError &&
                musicAccountStatus?.configured === true &&
                musicAccountStatus.connected === false ? (
                  <a className="oauth-connect" href="/api/music/oauth/start">
                    {t("connectMusicAccount")}
                  </a>
                ) : null}
                {!musicSetupOpen &&
                !musicAccountStatusError &&
                musicAccountStatus?.configured === false ? (
                  <button type="button" disabled>
                    {t("musicAccountConnectionUnavailable")}
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
          {isManager ? musicSetupPanel : null}
          {game !== null &&
          isFederationGame(game) &&
          !["finished", "draw", "cancelled"].includes(game.phase) &&
          finalResults === null &&
          previewGame === null &&
          !privacyHidden &&
          finishGameState !== "blocked" &&
          canApplyGameScreenMutation() ? (
            <AdjudicationControls
              game={game}
              onAcceptedEvent={(draft) => {
                if (!canApplyGameScreenMutation()) return;
                acceptGameEvent(draft);
                setActiveDrawer(null);
              }}
            />
          ) : null}
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
      {isManager && devUnlocked && showWorkspaceTools && activeDrawer === "dev" ? (
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
              aria-label={
                appVersion !== null
                  ? t("canaryVersion", { version: appVersion })
                  : t(appVersionUnavailable ? "canaryVersionUnavailable" : "canaryVersionLoading")
              }
            >
              <Bird aria-hidden="true" strokeWidth={2.5} />
              <span>
                {t("canaryVersionLabel", {
                  version:
                    appVersion ?? t(appVersionUnavailable ? "canaryUnavailable" : "canaryLoading"),
                })}
              </span>
            </p>
          </div>
          <div className="dev-menu-actions">
            <button
              type="button"
              className="dev-setting-toggle"
              aria-label={
                lighting.requestedRenderer === "vgpu"
                  ? t("disableRaytracing")
                  : t("enableRaytracing")
              }
              aria-pressed={lighting.requestedRenderer === "vgpu"}
              onClick={() =>
                selectLightingRenderer(lighting.requestedRenderer === "vgpu" ? "legacy" : "vgpu")
              }
            >
              <span>
                <strong>{t("raytracing")}</strong>
                <small>{t("raytracingDescription")}</small>
              </span>
              <span className="dev-setting-state">
                {t(lighting.requestedRenderer === "vgpu" ? "settingOn" : "settingOff")}
              </span>
            </button>
            {lighting.vgpuStatus === "initializing" ? (
              <p className="dev-renderer-status" role="status">
                {t("vgpuInitializing")}
              </p>
            ) : lighting.vgpuStatus === "fallback" ? (
              <p className="dev-renderer-status" role="status">
                {t("vgpuFallback")}
              </p>
            ) : null}
            <button
              type="button"
              className="dev-setting-toggle"
              disabled={lighting.requestedRenderer !== "vgpu"}
              aria-label={
                lighting.playerPulse.enabled ? t("disablePlayerPulse") : t("enablePlayerPulse")
              }
              aria-pressed={lighting.playerPulse.enabled}
              onClick={() =>
                setPlayerPulse({ ...lighting.playerPulse, enabled: !lighting.playerPulse.enabled })
              }
            >
              <span>
                <strong>{t("playerPulse")}</strong>
                <small>{t("playerPulseDescription")}</small>
              </span>
              <span className="dev-setting-state">
                {t(lighting.playerPulse.enabled ? "settingOn" : "settingOff")}
              </span>
            </button>
            <label className="dev-renderer-field">
              <span>{t("playerPulseSpeedValue", { speed: lighting.playerPulse.speed })}</span>
              <input
                type="range"
                aria-label={t("playerPulseSpeed")}
                min="0.25"
                max="3"
                step="0.25"
                value={lighting.playerPulse.speed}
                disabled={lighting.requestedRenderer !== "vgpu"}
                onChange={(event) =>
                  setPlayerPulse({
                    ...lighting.playerPulse,
                    speed: Number(event.currentTarget.value),
                  })
                }
              />
            </label>
            <label className="dev-renderer-field">
              <span>
                {t("playerPulseStrengthValue", {
                  strength: Math.round(lighting.playerPulse.strength * 100),
                })}
              </span>
              <input
                type="range"
                aria-label={t("playerPulseStrength")}
                min="0"
                max="50"
                step="1"
                value={Math.round(lighting.playerPulse.strength * 100)}
                disabled={lighting.requestedRenderer !== "vgpu"}
                onChange={(event) =>
                  setPlayerPulse({
                    ...lighting.playerPulse,
                    strength: Number(event.currentTarget.value) / 100,
                  })
                }
              />
            </label>
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
              onClick={() => setDevelopmentToolsEnabled(!devModeEnabled)}
            >
              {devModeEnabled ? t("disableDevMode") : t("enableDevMode")}
            </button>
            <button type="button" className="danger-action" onClick={hideDeveloperMode}>
              {t("hideDeveloperMode")}
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
          showDevelopmentTools={isManager && devUnlocked && devModeEnabled}
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
            onBack={() => setView("game")}
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
            playersLoading={!playersLoaded}
            rulesEdition={
              setupSession === null ? FEDERATION_RULES_EDITION : setupSession.rulesEdition
            }
            bestMoveEnabled={setupSession?.bestMoveEnabled ?? club.bestMoveEnabled}
            showDevelopmentTools={isManager && devUnlocked && devModeEnabled}
            onPopulateDevelopmentPlayers={populateDevelopmentPlayers}
            onOpenAvailablePlayers={() => setAvailabilityScreenOpen(true)}
            onRoleDrawBackActionChange={updateRoleDrawBackAction}
            persistencePending={sessionSync.isCreating || sessionSync.isRemoved}
            initialSessionState={setupSession}
            onSessionStateChange={handleSetupSessionChange}
            onEvent={logEvent}
            onStartGame={() => {
              musicRef.current?.startOpeningQueue();
            }}
            onComplete={(next, selectedHostPlayerId) => {
              const gameId = sessionSync.gameId;
              if (gameId === null || sessionSync.isCreating || sessionSync.isRemoved) return;
              const baseline = createInitialGameBaseline(next);
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
              // Federation setup records retain acknowledged club deviations after play starts.
              if (!isFederationGame(next)) setSetupSession(null);
              setHostPlayerId(selectedHostPlayerId);
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
          clubDeviationsAcknowledged={setupSession?.clubDeviationsAcknowledged}
          hostName={
            hostPlayerId === null
              ? t("host")
              : (players.find(({ id }) => id === hostPlayerId)?.nickname ?? t("player.anonymous"))
          }
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

      <LiveSidePanel
        game={view === "game" ? (previewGame ?? game) : null}
        hidden={view !== "game"}
        onSelectVotingCandidate={
          view === "game" &&
          previewGame === null &&
          finalResults === null &&
          finishGameState !== "blocked" &&
          game?.phase === "voting"
            ? (seat) => {
                if (canApplyGameScreenMutation() && game.phase === "voting") {
                  if (isFederationGame(game)) {
                    acceptGameEvent({
                      type: "voting.candidate-selected",
                      payload: { candidateSeat: seat },
                    });
                  } else {
                    changeGame(selectVotingCandidate(game, seat));
                  }
                }
              }
            : undefined
        }
      >
        {musicAccountConnected ? (
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
        playerPulse={lighting.playerPulse}
        onReady={reportVgpuReady}
        onFailure={reportVgpuFailure}
      >
        <PlayerDirectoryProvider profiles={players}>{content}</PlayerDirectoryProvider>
      </VgpuLightingProvider>
    </LightingRendererContext.Provider>
  );
};

type LockedClubWorkspaceProps = Omit<
  Parameters<typeof ClubWorkspace>[0],
  "storageGuard" | "onDeleteClub"
> & {
  readonly onDeleteClub: (guard: BrowserGameStorageGuard) => Promise<void>;
  readonly onStorageMismatch: (attachment: BrowserGameAttachment) => void;
  readonly onStorageInvalid: (rawSnapshot: string) => void;
  readonly onStorageError: (message: "browserGameLockBusy" | "browserGameLockUnavailable") => void;
};

const LockedClubWorkspace = ({
  onDeleteClub,
  onStorageMismatch,
  onStorageInvalid,
  onStorageError,
  ...workspaceProps
}: LockedClubWorkspaceProps) => {
  const { t } = useMessages(shellMessages);
  const [storageGuard, setStorageGuard] = useState<BrowserGameStorageGuard | null>(null);
  const errorRef = useRef(onStorageError);
  errorRef.current = onStorageError;
  const mismatchRef = useRef(onStorageMismatch);
  mismatchRef.current = onStorageMismatch;
  const invalidRef = useRef(onStorageInvalid);
  invalidRef.current = onStorageInvalid;

  useEffect(() => {
    let cancelled = false;
    let release: () => void = () => undefined;
    const lifetime = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Skip StrictMode's cancelled first effect before requesting ownership.
    void Promise.resolve()
      .then(() => {
        if (cancelled) return;
        return withBrowserGameStorageGuard(
          async (guard) => {
            if (cancelled) return;
            const currentStorage = readBrowserGameStorageState(window.localStorage);
            if (currentStorage.kind === "invalid") {
              invalidRef.current(currentStorage.rawSnapshot);
              return;
            }
            if (
              currentStorage.kind === "ready" &&
              currentStorage.attachment.clubId !== workspaceProps.club.id
            ) {
              mismatchRef.current(currentStorage.attachment);
              return;
            }
            setStorageGuard(guard);
            await lifetime;
          },
          { ifAvailable: true },
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof BrowserGameStorageBusyError) {
          errorRef.current("browserGameLockBusy");
        } else {
          reportError(error, { source: "persistence", context: "browser-game.lock" });
          errorRef.current("browserGameLockUnavailable");
        }
      });
    return () => {
      cancelled = true;
      release();
    };
  }, [workspaceProps.club.id]);

  if (storageGuard === null) {
    return (
      <main className="app-shell">
        <p role="status">{t("browserGameLockWaiting")}</p>
      </main>
    );
  }
  return (
    <ClubWorkspace
      {...workspaceProps}
      storageGuard={storageGuard}
      onDeleteClub={() => onDeleteClub(storageGuard)}
    />
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
  const [blockedClub, setBlockedClub] = useState<Club | null>(null);
  const [browserGameState, setBrowserGameState] = useState<BrowserGameStorageState>({
    kind: "empty",
  });
  const [editingClub, setEditingClub] = useState<Club | "new" | null>(null);
  const [openingCurtains, setOpeningCurtains] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ShellMessageKey | null>(null);
  const [storageError, setStorageError] = useState<ShellMessageKey | null>(null);
  const [browserGameRecoveryPending, setBrowserGameRecoveryPending] = useState(false);
  const [browserGameRecoveryError, setBrowserGameRecoveryError] = useState(false);
  const [browserGameReleaseError, setBrowserGameReleaseError] = useState(false);

  useEffect(() => {
    setLocale(selectedClub?.language ?? portalLocale);
  }, [portalLocale, selectedClub?.language, setLocale]);

  useEffect(() => {
    applyThemeColor(document.documentElement, window.localStorage, themeColor);
  }, [themeColor]);

  useEffect(() => {
    if (user === null) return;
    let current = true;
    const refreshClubs = async () => {
      setLoading(true);
      try {
        const nextClubs = await listClubs();
        if (!current) return;
        let nextBrowserGameState: BrowserGameStorageState;
        try {
          nextBrowserGameState = await prepareBrowserGameStorage(
            { localStorage: window.localStorage },
            { ifAvailable: true },
          );
        } catch (error) {
          if (!current) return;
          if (error instanceof BrowserGameStorageBusyError) {
            setStorageError("browserGameLockBusy");
          } else {
            reportError(error, { source: "persistence", context: "browser-game.prepare" });
            setStorageError("browserGameLockUnavailable");
          }
          return;
        }
        if (!current) return;
        setClubs(nextClubs);
        setBrowserGameState(nextBrowserGameState);
        if (nextBrowserGameState.kind === "ready") {
          setSelectedClub(
            nextClubs.find(({ id }) => id === nextBrowserGameState.attachment.clubId) ?? null,
          );
        }
        setError(null);
      } catch (error) {
        if (!current) return;
        reportError(error, { source: "api", context: "clubs.list" });
        setError("clubsUnavailable");
      } finally {
        if (current) setLoading(false);
      }
    };
    void refreshClubs();
    return () => {
      current = false;
    };
  }, [user]);

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

  const endSession = async () => {
    setLoading(true);
    try {
      await signOut();
      await clearBrowserGameStorage(window.localStorage);
      setUser(null);
      setClubs([]);
      setSelectedClub(null);
      setBlockedClub(null);
      setBrowserGameState({ kind: "empty" });
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

  const removeClub = async (club: Club, storageGuard?: BrowserGameStorageGuard) => {
    if (user === null) throw new Error("Sign in before deleting a club");
    if (!window.confirm(t("deleteClubConfirmation", { name: club.name }))) {
      return;
    }
    try {
      await deleteClub(club.id);
      const cleanup = {
        localStorage: window.localStorage,
        clubId: club.id,
      };
      if (storageGuard === undefined) {
        await clearBrowserGameStorageForClub(cleanup);
      } else {
        clearBrowserGameStorageForClubLocked(cleanup, storageGuard);
      }
      window.localStorage.removeItem(availablePlayerStorageKey(club.id));
      setClubs((current) => current.filter(({ id }) => id !== club.id));
      setSelectedClub(null);
      setBlockedClub(null);
      setBrowserGameState(readBrowserGameStorageState(window.localStorage));
      setEditingClub(null);
      setError(null);
    } catch (error) {
      reportError(error, { source: "api", context: "clubs.delete" });
      setError("clubDeleteFailed");
    }
  };

  const openClub = (club: Club) => {
    if (browserGameState.kind === "invalid") return;
    setEditingClub(null);
    const attachment = readBrowserGameAttachment(window.localStorage);
    if (attachment !== null && attachment.clubId !== club.id) {
      setBrowserGameState({ kind: "ready", attachment });
      setBlockedClub(club);
      return;
    }
    setBlockedClub(null);
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

  const openBrowserGameOwner = () => {
    if (browserGameState.kind !== "ready") return;
    const owner = clubs.find(({ id }) => id === browserGameState.attachment.clubId);
    if (owner === undefined) return;
    setBlockedClub(null);
    setSelectedClub(owner);
  };

  const releaseAndOpenBlockedClub = async () => {
    if (browserGameState.kind !== "ready" || blockedClub === null) return;
    const target = blockedClub;
    setBrowserGameReleaseError(false);
    try {
      const released = await releaseBrowserGameStorage(
        window.localStorage,
        browserGameState.attachment,
      );
      const current = await prepareBrowserGameStorage({ localStorage: window.localStorage });
      setBrowserGameState(current);
      if (current.kind !== "empty") {
        if (!released) setBrowserGameReleaseError(true);
        return;
      }
      setBlockedClub(null);
      setSelectedClub(target);
    } catch (error) {
      reportError(error, { source: "persistence", context: "browser-game.release" });
      setBrowserGameReleaseError(true);
    }
  };

  const discardUnavailableBrowserGame = async () => {
    if (browserGameState.kind !== "ready" || browserGameRecoveryPending) return;
    const expected = browserGameState.attachment;
    const target = blockedClub;
    if (!window.confirm(t("browserGameDiscardConfirmation"))) return;
    setBrowserGameRecoveryPending(true);
    setBrowserGameRecoveryError(false);
    try {
      let discardError: unknown = null;
      try {
        await discardBrowserGameStorage({ localStorage: window.localStorage }, expected);
      } catch (error) {
        discardError = error;
      }
      const nextState = await prepareBrowserGameStorage({ localStorage: window.localStorage });
      setBrowserGameState(nextState);
      if (nextState.kind !== "empty") {
        if (discardError !== null) {
          reportError(discardError, { source: "persistence", context: "browser-game.discard" });
        }
        setBrowserGameRecoveryError(true);
        return;
      }
      setBlockedClub(null);
      if (target !== null && clubs.some(({ id }) => id === target.id)) {
        setSelectedClub(target);
        return;
      }
      setSelectedClub(null);
      if (target !== null) setError("browserGameRecoveryTargetUnavailable");
    } catch (error) {
      reportError(error, { source: "persistence", context: "browser-game.discard" });
      setBrowserGameRecoveryError(true);
    } finally {
      setBrowserGameRecoveryPending(false);
    }
  };

  const discardInvalidBrowserGame = async () => {
    if (browserGameState.kind !== "invalid") return;
    if (!window.confirm(t("browserGameInvalidDiscardConfirmation"))) return;
    const rawSnapshot = browserGameState.rawSnapshot;
    try {
      await discardInvalidBrowserGameStorage({ localStorage: window.localStorage }, rawSnapshot);
      setBrowserGameState({ kind: "empty" });
      setBlockedClub(null);
    } catch (error) {
      reportError(error, { source: "persistence", context: "browser-game.discard-invalid" });
      setBrowserGameState(readBrowserGameStorageState(window.localStorage));
    }
  };

  if (storageError !== null) {
    return (
      <main className="club-portal">
        <section className="browser-game-dialog" role="alert">
          {t(storageError)}
        </section>
      </main>
    );
  }

  if (selectedClub !== null) {
    return (
      <>
        <LockedClubWorkspace
          key={selectedClub.id}
          club={selectedClub}
          onExit={() => {
            setSelectedClub(null);
            setEditingClub(null);
            setBrowserGameState(readBrowserGameStorageState(window.localStorage));
          }}
          onEditClub={() => {
            setSelectedClub(null);
            setEditingClub(selectedClub);
          }}
          onDeleteClub={(storageGuard) => removeClub(selectedClub, storageGuard)}
          onStorageMismatch={(attachment) => {
            setSelectedClub(null);
            setBrowserGameState({ kind: "ready", attachment });
            setBlockedClub(selectedClub);
          }}
          onStorageInvalid={(rawSnapshot) => {
            setSelectedClub(null);
            setBrowserGameState({ kind: "invalid", rawSnapshot });
            setBlockedClub(null);
          }}
          onLanguageChange={changeSelectedClubLanguage}
          onStorageError={setStorageError}
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

  const missingOwner =
    browserGameState.kind === "ready" &&
    !clubs.some(({ id }) => id === browserGameState.attachment.clubId);

  return (
    <>
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
      {browserGameState.kind === "invalid" ? (
        <div className="browser-game-backdrop">
          <section
            className="browser-game-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="browser-game-invalid-title"
          >
            <p className="eyebrow">{t("browserGameEyebrow")}</p>
            <h2 id="browser-game-invalid-title">{t("browserGameInvalidTitle")}</h2>
            <p>{t("browserGameInvalidBody")}</p>
            <div className="browser-game-actions">
              <button type="button" onClick={() => void discardInvalidBrowserGame()}>
                {t("browserGameInvalidDiscard")}
              </button>
            </div>
          </section>
        </div>
      ) : browserGameState.kind === "ready" && (blockedClub !== null || missingOwner) ? (
        <div className="browser-game-backdrop">
          <section
            className="browser-game-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="browser-game-attached-title"
          >
            <p className="eyebrow">{t("browserGameEyebrow")}</p>
            <h2 id="browser-game-attached-title">{t("browserGameAttachedTitle")}</h2>
            <p>
              {missingOwner
                ? t("browserGameMissingOwnerBody", {
                    game: browserGameState.attachment.name ?? browserGameState.attachment.gameId,
                  })
                : t("browserGameAttachedBody", {
                    game: browserGameState.attachment.name ?? browserGameState.attachment.gameId,
                    club:
                      clubs.find(({ id }) => id === browserGameState.attachment.clubId)?.name ??
                      browserGameState.attachment.clubId,
                    target: blockedClub?.name ?? "",
                  })}
            </p>
            {browserGameState.attachment.unresolved && !missingOwner ? (
              <p>{t("browserGameReleaseBlocked")}</p>
            ) : null}
            {browserGameRecoveryError ? <p role="alert">{t("browserGameRecoveryFailed")}</p> : null}
            {browserGameReleaseError ? <p role="alert">{t("browserGameReleaseFailed")}</p> : null}
            <div className="browser-game-actions">
              {!missingOwner ? (
                <button type="button" className="secondary" onClick={openBrowserGameOwner}>
                  {t("browserGameOpenOwner", {
                    club:
                      clubs.find(({ id }) => id === browserGameState.attachment.clubId)?.name ??
                      browserGameState.attachment.clubId,
                  })}
                </button>
              ) : null}
              {missingOwner ? (
                <button
                  type="button"
                  disabled={browserGameRecoveryPending}
                  onClick={() => void discardUnavailableBrowserGame()}
                >
                  {browserGameRecoveryPending
                    ? t("browserGameRecoveryWorking")
                    : blockedClub === null
                      ? t("browserGameDiscard")
                      : t("browserGameDiscardAndOpen", { club: blockedClub.name })}
                </button>
              ) : blockedClub !== null ? (
                <button
                  type="button"
                  disabled={browserGameState.attachment.unresolved}
                  onClick={releaseAndOpenBlockedClub}
                >
                  {t("browserGameReleaseAndOpen", { club: blockedClub.name })}
                </button>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
};

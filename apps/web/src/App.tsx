import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyGameEvent,
  createGameLogEntry,
  hashGameState,
  isMeaningfulGameEventDraft,
  replayGameLog,
  type CanonicalGameEventDraft,
  type GameLogEntry,
  type GameState,
  type InitialGameBaseline,
} from "@mafia/game-domain";
import {
  DoorOpen,
  Eye,
  EyeOff,
  ListTree,
  Maximize2,
  Minimize2,
  Save,
  Undo2,
  Wrench,
} from "lucide-react";
import {
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
  updateClub,
} from "./api/client.js";
import type {
  ActiveGameSessionSummary,
  FinalGameResults,
  GameSessionState,
  PlayerProfile,
  PlayerProfileInput,
  RemoteGameSession,
  Club,
  ClubInput,
  AppUser,
} from "./api/client.js";
import { ClubPortal } from "./features/clubs/ClubPortal.js";
import { ErrorConsoleScreen } from "./features/console/ErrorConsoleScreen.js";
import { clearErrorConsole, reportError } from "./features/console/error-console.js";
import { GameScreen } from "./features/game/GameScreen.js";
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
  writeMusicPreferences,
  type MusicPreferencesV1,
} from "./features/music/music-preferences.js";
import { musicStageForPhase } from "./features/music/music-stage.js";
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
import {
  DEFAULT_GLASS_SETTINGS,
  GLASS_SETTINGS_BOUNDS,
  readGlassSettings,
  writeGlassSettings,
  type GlassSettings,
} from "./features/theme/glass-settings.js";
import { supportsTrueRefraction } from "./features/theme/refractive-support.js";
import { GameSessionOutbox } from "./session-outbox.js";
import { createRandomId } from "./utils/random-id.js";
import { applyColorTheme, readColorTheme, type ColorTheme } from "./theme.js";
import "./styles/app.css";
import "./styles/clubs.css";
import "./styles/timeline.css";

interface LocalLogEntry {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly phase: string;
  readonly payload: Record<string, unknown>;
  readonly secret: boolean;
  readonly createdAt: string;
}

type BackgroundShade = "black" | "grey-33" | "grey-66" | "white";
type WorkspaceView = "game" | "players" | "timeline" | "console";

const backgroundShadeOrder: readonly BackgroundShade[] = ["black", "grey-33", "grey-66", "white"];
const backgroundShadeClass: Record<BackgroundShade, string> = {
  black: "",
  "grey-33": " is-background-grey-33",
  "grey-66": " is-background-grey-66",
  white: " is-light-background",
};
const backgroundShadeLabel: Record<BackgroundShade, string> = {
  black: "black",
  "grey-33": "33% grey",
  "grey-66": "66% grey",
  white: "white",
};
const defaultClubId = "00000000-0000-4000-8000-000000000101";
const gameSessionStoragePrefix = "mafia-dashboard.game-session.v4";
const legacyGameSessionStoragePrefix = "mafia-dashboard.game-session.v3";
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

const isTouchTablet = () =>
  /iPad/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ||
  (/Android/.test(navigator.userAgent) &&
    !/Mobile/.test(navigator.userAgent) &&
    navigator.maxTouchPoints > 0);

const defaultPlaylistId = import.meta.env.VITE_YOUTUBE_PLAYLIST_ID ?? "";
const developmentAdjectives = ["Crimson", "Midnight", "Velvet", "Golden", "Silent"] as const;
const developmentAliases = ["Fox", "Raven", "Wolf", "Owl", "Viper"] as const;

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

const isSecretEvent = (type: string, payload: Record<string, unknown>) =>
  payload.secret === true ||
  type === "setup.role-drawn" ||
  type.includes("shot") ||
  type.includes("checked");

const isAuxiliaryEvent = (type: string) =>
  type.startsWith("timer.") || type.startsWith("music.") || type.startsWith("setup.");

const toLocalLogEntry = (entry: GameLogEntry): LocalLogEntry => ({
  id: entry.id,
  sequence: entry.sequence,
  type: entry.type,
  phase: entry.phaseBefore,
  payload: entry.payload as Record<string, unknown>,
  secret: entry.secret,
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
  colorTheme = "midnight",
  onColorThemeChange = () => undefined,
}: {
  readonly club: Club;
  readonly onExit: () => void;
  readonly onEditClub: () => void;
  readonly onDeleteClub: () => Promise<void>;
  readonly colorTheme?: ColorTheme;
  readonly onColorThemeChange?: (theme: ColorTheme) => void;
}) => {
  const sessionSyncRef = useRef<GameSessionOutbox | null>(null);
  if (sessionSyncRef.current === null) {
    sessionSyncRef.current = new GameSessionOutbox({
      storage: window.sessionStorage,
      storageKey: gameSessionStorageKey(club.id),
      legacyStorageKey: legacyGameSessionStorageKey(club.id),
      createId: createRandomId,
      save: (gameId, operation) => saveGameSessionOperation(gameId, operation, club.id),
      read: (gameId) => getGameSession(gameId, club.id),
      clearRemote: (gameId, expectedRevision) =>
        clearGameSession(gameId, expectedRevision, club.id),
      saveLegacy: (gameId, mutation) => saveGameSession(gameId, mutation, club.id),
    });
  }
  const sessionSync = sessionSyncRef.current;
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
  const [undoBudget, setUndoBudget] = useState(() =>
    initialState.resetReturnEventId === null
      ? getRemainingUndoBudget(initialState.events, initialState.headEventId)
      : 0,
  );
  const [resetReturnUndoBudget, setResetReturnUndoBudget] = useState(() =>
    getRemainingUndoBudget(initialState.events, initialState.resetReturnEventId),
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
  const [finishGameState, setFinishGameState] = useState<"ready" | "saving" | "saved" | "error">(
    initialCurrent?.results === null || initialCurrent?.results === undefined ? "ready" : "saved",
  );
  const [players, setPlayers] = useState<readonly PlayerProfile[]>([]);
  const [availablePlayerIds, setAvailablePlayerIds] = useState<ReadonlySet<string>>(() =>
    readAvailablePlayerIds(window.localStorage, club.id),
  );
  const [playersError, setPlayersError] = useState(false);
  const [rosterGateError, setRosterGateError] = useState<string | null>(null);
  const [playlistId, setPlaylistId] = useState(initialPlaylistId);
  const [musicPreferences, setMusicPreferences] =
    useState<MusicPreferencesV1>(initialMusicPreferences);
  const [musicPlayerExpanded, setMusicPlayerExpanded] = useState(false);
  const [musicVolumePresets, setMusicVolumePresets] = useState<readonly [number, number]>([50, 80]);
  const [activeMusicVolume, setActiveMusicVolume] = useState(80);
  const [musicReloadRequest, setMusicReloadRequest] = useState(0);
  const [musicState, setMusicState] = useState<YouTubePlaybackState>("idle");

  const changePlaylistId = useCallback(
    (nextPlaylistId: string) => {
      setPlaylistId(nextPlaylistId);
      setMusicPreferences((current) => {
        const next = { ...current, lastPlaylistId: nextPlaylistId };
        writeMusicPreferences(window.localStorage, club.id, next);
        return next;
      });
    },
    [club.id],
  );
  const changeStagePlaylistIds = useCallback(
    (stagePlaylistIds: MusicPreferencesV1["stagePlaylistIds"]) => {
      setMusicPreferences((current) => {
        const next = { ...current, stagePlaylistIds };
        writeMusicPreferences(window.localStorage, club.id, next);
        return next;
      });
    },
    [club.id],
  );
  const clearMusicAccountState = useCallback(() => {
    setPlaylistId("");
    setMusicPreferences((current) => {
      const next = { ...current, lastPlaylistId: "", stagePlaylistIds: {} };
      writeMusicPreferences(window.localStorage, club.id, next);
      return next;
    });
  }, [club.id]);
  const changeQueueOrder = useCallback(
    (changedPlaylistId: string, order: readonly string[]) => {
      setMusicPreferences((current) => {
        const next = {
          ...current,
          queueOrderByPlaylist: {
            ...current.queueOrderByPlaylist,
            [changedPlaylistId]: order,
          },
        };
        writeMusicPreferences(window.localStorage, club.id, next);
        return next;
      });
    },
    [club.id],
  );

  useEffect(() => {
    if (game === null) return;
    const stage = musicStageForPhase(game.phase);
    const mappedPlaylistId = stage === null ? undefined : musicPreferences.stagePlaylistIds[stage];
    if (mappedPlaylistId && mappedPlaylistId !== playlistId) changePlaylistId(mappedPlaylistId);
  }, [changePlaylistId, game, musicPreferences.stagePlaylistIds, playlistId]);

  const [activeSessions, setActiveSessions] = useState<readonly ActiveGameSessionSummary[]>([]);
  const [activeSessionsError, setActiveSessionsError] = useState(false);
  const [resumeGameId, setResumeGameId] = useState<string | null>(null);
  const [swipedSessionId, setSwipedSessionId] = useState<string | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [activeDrawer, setActiveDrawer] = useState<"log" | "dev" | null>(null);
  const [musicSetupOpen, setMusicSetupOpen] = useState(false);
  const [backgroundShade, setBackgroundShade] = useState<BackgroundShade>("black");
  const [glassSettings, setGlassSettings] = useState<GlassSettings>(() =>
    readGlassSettings(window.localStorage),
  );
  const [devModeEnabled, setDevModeEnabled] = useState(false);
  const [privacyHidden, setPrivacyHidden] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(() => currentFullscreenElement() !== null);
  const [clearingAllData, setClearingAllData] = useState(false);
  const [clearAllDataError, setClearAllDataError] = useState(false);
  const [, setSyncRender] = useState(0);

  const musicRef = useRef<YouTubePlayerHandle>(null);
  const devDrawerRef = useRef<HTMLElement>(null);
  const touchTablet = useRef(isTouchTablet()).current;
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
  const fullscreenTarget = document.documentElement as WebkitFullscreenElement;
  const fullscreenDocument = document as WebkitFullscreenDocument;
  const fullscreenAvailable =
    typeof fullscreenTarget.requestFullscreen === "function" ||
    typeof fullscreenTarget.webkitRequestFullscreen === "function";
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
  const undoCount = resetReturnEventId === null ? undoHistory.length : 1;
  const previewEntry = events.find(({ id }) => id === previewTargetEventId);
  const renderedGameScreenMutationGeneration = gameScreenMutationGenerationRef.current;
  const canApplyGameScreenMutation = () =>
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
        if (nextPlayers.length < 11) setView("players");
      }
    } catch (error) {
      reportError(error, { source: "api", context: "players.list" });
      if (playerRequestRef.current === request) setPlayersError(true);
    }
  }, [club.id]);

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

  useEffect(() => {
    const root = document.documentElement;
    const visualViewport = window.visualViewport;
    const syncViewportHeight = () => {
      root.style.setProperty(
        "--app-viewport-height",
        `${visualViewport?.height ?? window.innerHeight}px`,
      );
    };
    syncViewportHeight();
    window.addEventListener("resize", syncViewportHeight);
    visualViewport?.addEventListener("resize", syncViewportHeight);
    return () => {
      window.removeEventListener("resize", syncViewportHeight);
      visualViewport?.removeEventListener("resize", syncViewportHeight);
      root.style.removeProperty("--app-viewport-height");
    };
  }, []);

  useEffect(() => {
    let lastTouch: { readonly x: number; readonly y: number } | null = null;
    const rememberTouch = (event: TouchEvent) => {
      const touch = event.touches[0];
      lastTouch = touch === undefined ? null : { x: touch.clientX, y: touch.clientY };
    };
    const scrollableAncestor = (target: EventTarget | null) => {
      let element = target instanceof Element ? target : null;
      while (element !== null && element !== document.documentElement) {
        if (element instanceof HTMLElement) {
          const overflowY = window.getComputedStyle(element).overflowY;
          if (
            (overflowY === "auto" || overflowY === "scroll") &&
            element.scrollHeight > element.clientHeight + 1
          ) {
            return element;
          }
        }
        element = element.parentElement;
      }
      return null;
    };
    const containViewportPan = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (touch === undefined || lastTouch === null) return;
      const deltaX = touch.clientX - lastTouch.x;
      const deltaY = touch.clientY - lastTouch.y;
      lastTouch = { x: touch.clientX, y: touch.clientY };
      if (Math.abs(deltaY) <= Math.abs(deltaX)) return;

      const scroller = scrollableAncestor(event.target);
      const canScroll =
        scroller !== null &&
        (deltaY > 0
          ? scroller.scrollTop > 0
          : scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1);
      if (!canScroll) event.preventDefault();
    };
    const clearTouch = () => {
      lastTouch = null;
    };

    document.addEventListener("touchstart", rememberTouch, { passive: true });
    document.addEventListener("touchmove", containViewportPan, { passive: false });
    document.addEventListener("touchend", clearTouch, { passive: true });
    document.addEventListener("touchcancel", clearTouch, { passive: true });
    return () => {
      document.removeEventListener("touchstart", rememberTouch);
      document.removeEventListener("touchmove", containViewportPan);
      document.removeEventListener("touchend", clearTouch);
      document.removeEventListener("touchcancel", clearTouch);
    };
  }, []);

  useEffect(() => {
    if (activeDrawer !== "dev") return;
    const drawer = devDrawerRef.current;
    if (drawer === null) return;
    let lastTouchY = 0;
    const rememberTouch = (event: TouchEvent) => {
      lastTouchY = event.touches[0]?.clientY ?? lastTouchY;
    };
    const containEdgeSwipe = (event: TouchEvent) => {
      const touchY = event.touches[0]?.clientY;
      if (touchY === undefined) return;
      const deltaY = touchY - lastTouchY;
      const atTop = drawer.scrollTop <= 0;
      const atBottom = drawer.scrollTop + drawer.clientHeight >= drawer.scrollHeight - 1;
      if ((atTop && deltaY > 0) || (atBottom && deltaY < 0)) event.preventDefault();
      lastTouchY = touchY;
    };
    drawer.addEventListener("touchstart", rememberTouch, { passive: true });
    drawer.addEventListener("touchmove", containEdgeSwipe, { passive: false });
    return () => {
      drawer.removeEventListener("touchstart", rememberTouch);
      drawer.removeEventListener("touchmove", containEdgeSwipe);
    };
  }, [activeDrawer]);

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
    void sessionSync.flush().catch((error: unknown) => {
      reportError(error, { source: "persistence", context: "game-session.initial-flush" });
    });
  }, [sessionSync]);

  useEffect(() => {
    const hasContent =
      initialGame !== null ||
      setupSession !== null ||
      hostPlayerId !== null ||
      hostName !== null ||
      playlistId !== defaultPlaylistId ||
      log.length > 0;
    if (!hasContent) return;
    sessionSync.enqueue(
      sessionName,
      {
        setup: setupSession,
        game: initialGame === null ? canonicalGameRef.current : null,
        hostPlayerId,
        hostName,
        playlistId,
        log,
        undoHistory: [],
        initialGame,
        events,
        headEventId,
        resetReturnEventId,
        legacyLog,
      } as GameSessionState,
      finalResults,
    );
    void sessionSync
      .flush()
      .then(() => {
        if (persistedResultsRef.current !== finalResults) {
          persistedResultsRef.current = finalResults;
          void refreshPlayers();
        }
      })
      .catch((error: unknown) => {
        reportError(error, { source: "persistence", context: "game-session.auto-flush" });
      });
  }, [
    finalResults,
    events,
    headEventId,
    hostName,
    hostPlayerId,
    initialGame,
    legacyLog,
    log,
    playlistId,
    refreshPlayers,
    resetReturnEventId,
    sessionName,
    sessionSync,
    setupSession,
  ]);

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
        secret: isSecretEvent(type, payload),
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
      if (created.after.phase !== "finished") {
        setFinalResults(null);
        setFinishGameState("ready");
      }
    },
    [game, sessionSync],
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
      if (
        nextGame.phase === "finished" &&
        target?.type === "game.completed" &&
        hostPlayerId !== null
      ) {
        setFinalResults(
          buildFinalGameResults(nextGame, new Date(target?.createdAt ?? Date.now()), hostPlayerId),
        );
        setFinishGameState("saved");
      } else {
        setFinalResults(null);
        setFinishGameState("ready");
      }
    },
    [hostPlayerId],
  );

  const persistHeadMove = useCallback(
    async (
      targetEventId: string,
      nextResetReturnEventId: string | null,
      nextResults: FinalGameResults | null,
    ): Promise<boolean> => {
      const baseline = initialGameRef.current;
      if (baseline === null) return false;
      sessionSync.enqueue(
        sessionName,
        {
          setup: setupSession,
          game: null,
          hostPlayerId,
          hostName,
          playlistId,
          log: legacyLogRef.current,
          undoHistory: [],
          initialGame: baseline,
          events: eventsRef.current,
          headEventId: targetEventId,
          resetReturnEventId: nextResetReturnEventId,
          legacyLog: legacyLogRef.current,
        } as GameSessionState,
        nextResults,
      );
      try {
        await sessionSync.flush();
        return true;
      } catch (error) {
        reportError(error, { source: "persistence", context: "game-session.flush" });
        return false;
      }
    },
    [hostName, hostPlayerId, playlistId, sessionName, sessionSync, setupSession],
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
      const branch = getActiveBranch(eventsRef.current, headEventIdRef.current);
      const targetIndex = branch.findIndex(({ id }) => id === eventId);
      if (targetIndex < 0) return false;
      const futureCount = branch.length - targetIndex - 1;
      const target = branch[targetIndex]!;
      if (
        !window.confirm(
          `Reset the active game to log #${target.sequence}? ${futureCount} later active ${futureCount === 1 ? "action" : "actions"} will leave the current branch. Their history will be preserved.`,
        )
      ) {
        return false;
      }
      const previousHead = headEventIdRef.current;
      if (previousHead === null || !(await persistHeadMove(eventId, previousHead, null)))
        return false;
      gameScreenMutationGenerationRef.current += 1;
      setResetReturnUndoBudget(undoBudget);
      moveHeadLocally(eventId);
      setResetReturnEventId(previousHead);
      setUndoBudget(0);
      previewTargetEventIdRef.current = null;
      setPreviewTargetEventId(null);
      setPreviewGame(null);
      liveGameBeforePreviewRef.current = null;
      setActiveDrawer(null);
      return true;
    },
    [moveHeadLocally, persistHeadMove, undoBudget],
  );

  const finishGame = async () => {
    if (game?.phase !== "finished" || hostPlayerId === null || finishGameState === "saving") return;
    acceptGameEvent({
      type: "game.completed",
      payload: { winner: game.winner ?? "red" },
      secret: false,
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
        game: initialGame === null ? canonicalGameRef.current : null,
        hostPlayerId,
        hostName,
        playlistId,
        log: [
          ...legacyLogRef.current,
          ...getActiveBranch(eventsRef.current, headEventIdRef.current).map(toLocalLogEntry),
        ],
        undoHistory: [],
        initialGame: initialGameRef.current,
        events: eventsRef.current,
        headEventId: headEventIdRef.current,
        resetReturnEventId,
        legacyLog: legacyLogRef.current,
      } as GameSessionState,
      results,
    );
    try {
      await sessionSync.flush();
      persistedResultsRef.current = results;
      await Promise.all([refreshPlayers(), refreshActiveSessions()]);
      await sessionSync.clear(async () => undefined);
      resetLocalState();
    } catch (error) {
      reportError(error, { source: "api", context: "game.finish" });
      setFinishGameState("error");
    }
  };

  const undoLastGameAction = async () => {
    if (resetReturnEventId !== null) {
      const baseline = initialGameRef.current;
      const target = eventsRef.current.find(({ id }) => id === resetReturnEventId);
      if (baseline === null || target === undefined || hostPlayerId === null) return;
      const restoredGame = replayToEvent(baseline, eventsRef.current, resetReturnEventId);
      const restoredResults = buildFinalGameResults(
        restoredGame,
        new Date(target.createdAt),
        hostPlayerId,
      );
      if (!(await persistHeadMove(resetReturnEventId, null, restoredResults))) return;
      moveHeadLocally(resetReturnEventId);
      setResetReturnEventId(null);
      setUndoBudget(resetReturnUndoBudget);
      setResetReturnUndoBudget(0);
      return;
    }
    const entry = undoHistory.at(-1);
    if (entry?.parentEventId == null) return;
    if (!(await persistHeadMove(entry.parentEventId, null, null))) return;
    moveHeadLocally(entry.parentEventId);
    setUndoBudget((current) => Math.max(0, current - 1));
  };

  const handleMusicState = useCallback((state: YouTubePlaybackState) => {
    setMusicState(state);
  }, []);

  const musicLabel: Record<YouTubePlaybackState, string> = {
    idle: "Playlist required",
    loading: "Loading player",
    playing: "Playing",
    paused: "Ready · paused",
    error: "Playback unavailable",
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
    const created: PlayerProfile[] = [];
    try {
      for (let index = 0; index < 11; index += 1) {
        const adjective =
          developmentAdjectives[Math.floor(Math.random() * developmentAdjectives.length)];
        const alias = developmentAliases[Math.floor(Math.random() * developmentAliases.length)];
        created.push(
          await createPlayer(
            {
              nickname: `Dev ${adjective} ${alias} ${batchId}-${index + 1}`,
              consent: false,
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
    [players],
  );

  const applyRemoteSession = useCallback(
    (session: RemoteGameSession) => {
      const restored = asPersistedState(session.state);
      sessionSync.restore(
        session.gameId,
        session.revision,
        session.name,
        session.state,
        session.results,
      );
      gameScreenMutationGenerationRef.current += 1;
      setSessionName(session.name);
      const restoredGame =
        restored.initialGame === null
          ? restored.game
          : restored.headEventId === null
            ? restored.initialGame.game
            : replayGameLog(
                restored.initialGame,
                getActiveBranch(restored.events, restored.headEventId),
              ).game;
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
        restored.resetReturnEventId === null
          ? getRemainingUndoBudget(restored.events, restored.headEventId)
          : 0,
      );
      setResetReturnUndoBudget(
        getRemainingUndoBudget(restored.events, restored.resetReturnEventId),
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
    const localGameId = sessionSync.gameId;
    const localRevision = sessionSync.revision;
    const localCurrent = sessionSync.current;
    setResumeGameId(gameId);
    setActiveSessionsError(false);
    try {
      const session = await getGameSession(gameId, club.id);
      if (resumeRequestRef.current !== request) return;
      if (
        sessionSync.gameId !== localGameId ||
        sessionSync.revision !== localRevision ||
        sessionSync.current !== localCurrent ||
        sessionSync.status !== "saved"
      ) {
        setResumeGameId(null);
        return;
      }
      applyRemoteSession(session);
      setResumeGameId(null);
    } catch (error) {
      reportError(error, { source: "api", context: "game-session.resume" });
      if (resumeRequestRef.current === request) {
        setResumeGameId(null);
        setActiveSessionsError(true);
      }
    }
  };

  const resetLocalState = () => {
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
    setResetReturnUndoBudget(0);
    gameScreenMutationGenerationRef.current += 1;
    previewTargetEventIdRef.current = null;
    setPreviewTargetEventId(null);
    setPreviewGame(null);
    liveGameBeforePreviewRef.current = null;
    phaseRef.current = "setup-players";
  };

  const clearGameState = async () => {
    if (
      !window.confirm(
        "Delete this active game from the server? This is irreversible and removes its saved session and game log for every browser.",
      )
    )
      return;
    const clearingGameId = sessionSync.gameId;
    try {
      await sessionSync.clear((gameId, revision) => clearGameSession(gameId, revision, club.id));
    } catch (error) {
      reportError(error, { source: "persistence", context: "game-session.clear" });
      return;
    }
    if (sessionSync.gameId !== null && sessionSync.gameId !== clearingGameId) return;
    resetLocalState();
    void refreshActiveSessions();
  };

  const deleteActiveSession = async (session: ActiveGameSessionSummary) => {
    if (
      !window.confirm(
        `Delete "${session.name}" and all associated game statistics? This cannot be undone.`,
      )
    )
      return;
    setDeletingSessionId(session.gameId);
    try {
      if (sessionSync.gameId === session.gameId) {
        await sessionSync.clear((gameId, revision) => clearGameSession(gameId, revision, club.id));
        resetLocalState();
      } else {
        await clearGameSession(session.gameId, session.revision, club.id);
      }
      setSwipedSessionId(null);
      await Promise.all([refreshActiveSessions(), refreshPlayers()]);
    } catch (error) {
      reportError(error, { source: "api", context: "game-session.delete" });
      setActiveSessionsError(true);
    } finally {
      setDeletingSessionId(null);
    }
  };

  const clearApplicationData = async () => {
    if (
      !window.confirm(
        "Clear all data stored by Mafia Dashboard in this browser? Server players, sessions, results, and music will not be deleted.",
      )
    )
      return;
    setClearingAllData(true);
    setClearAllDataError(false);
    try {
      await sessionSync.clear(async () => undefined);
      window.localStorage.clear();
      window.sessionStorage.clear();
      setMusicPreferences(readMusicPreferences(window.localStorage, club.id));
      setGlassSettings(DEFAULT_GLASS_SETTINGS);
      clearErrorConsole();
      setDevModeEnabled(false);
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

  const persistenceState = sessionSync.status;
  const setupStep = setupSession?.step ?? "players";
  const roleGiveawayActive = view === "game" && game === null && setupStep === "roles";
  const showApplicationStatus =
    view !== "timeline" && (view === "players" || (game === null && !roleGiveawayActive));
  const applicationStatusTitle =
    view === "players"
      ? "Players & statistics"
      : availabilityScreenOpen
        ? "Available players"
        : "Game setup";
  const applicationStatusPhase =
    view === "players"
      ? players.length < 11
        ? `Need 11 players · ${players.length} registered`
        : `${availablePlayersForSetup.length} available · ${players.length} registered`
      : setupStep === "music"
        ? "Table music"
        : availabilityScreenOpen
          ? `${availablePlayersForSetup.length} available`
          : "Select players";
  const nextBackgroundShade =
    backgroundShadeOrder[
      (backgroundShadeOrder.indexOf(backgroundShade) + 1) % backgroundShadeOrder.length
    ]!;
  const colorThemeOrder: readonly ColorTheme[] = ["midnight", "malaga", "malaga-glass"];
  const nextColorTheme =
    colorThemeOrder[(colorThemeOrder.indexOf(colorTheme) + 1) % colorThemeOrder.length] ??
    "midnight";
  const nextColorThemeLabel =
    nextColorTheme === "malaga"
      ? "Málaga gold"
      : nextColorTheme === "malaga-glass"
        ? "Málaga Glass"
        : "Midnight";
  const browserBrands = /(?:Chrome|Chromium|CriOS|Edg)\//.test(navigator.userAgent)
    ? ["Chromium"]
    : /Safari\//.test(navigator.userAgent)
      ? ["Safari"]
      : [];
  const trueRefractionSupported = supportsTrueRefraction({
    enabled: glassSettings.enabled,
    cssSupportsFilterUrl:
      typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      CSS.supports("backdrop-filter", "url(#refractive-probe)"),
    browserBrands,
  });
  const updateGlassSettings = (next: Partial<GlassSettings>) => {
    setGlassSettings((current) => writeGlassSettings(window.localStorage, { ...current, ...next }));
  };
  const showWorkspaceTools = previewGame === null && (view === "game" || view === "players");

  return (
    <div
      className={`app-shell${backgroundShadeClass[backgroundShade]}${
        view === "game" && (game !== null || roleGiveawayActive)
          ? " has-live-game table-layout-shell"
          : ""
      }${game !== null && view === "game" ? " has-timer-rail" : ""}${
        showApplicationStatus ? " has-top-level-screen" : ""
      }${isFullscreen ? " is-fullscreen" : ""}`}
      data-background-shade={backgroundShade}
    >
      {showApplicationStatus ? (
        <header
          className="app-status-bar game-header"
          role="banner"
          aria-label="Application status"
        >
          {club.headerLogo === null ? null : (
            <img className="active-club-header-logo" src={club.headerLogo} alt="" />
          )}
          <div>
            <p className="eyebrow">
              {view === "players" ? "Persistent roster" : `Game setup · ${sessionName}`} · Host view
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
        <div className="app-fixed-toolbar" aria-label="Application tools">
          <button
            type="button"
            className="club-exit-button icon-toolbar-button"
            aria-label={`Choose another club · current club ${club.name}`}
            onClick={onExit}
          >
            <DoorOpen aria-hidden="true" />
          </button>
          <div
            className="save-indicator icon-toolbar-button"
            data-status={persistenceState}
            role="status"
            aria-label={`Save status: ${persistenceState}`}
            title={`Save status: ${persistenceState}`}
          >
            <Save aria-hidden="true" />
          </div>
          <button
            type="button"
            className="fullscreen-button icon-toolbar-button"
            aria-label={
              fullscreenAvailable
                ? isFullscreen
                  ? "Exit fullscreen"
                  : "Enter fullscreen"
                : "Fullscreen unavailable"
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
            aria-label={`Undo last action · ${undoCount} available`}
            disabled={undoCount === 0}
            onClick={undoLastGameAction}
          >
            <Undo2 aria-hidden="true" />
            <span className="toolbar-count">{undoCount}</span>
          </button>
          <button
            type="button"
            className="privacy-button icon-toolbar-button"
            aria-label={privacyHidden ? "Show private info" : "Hide private info"}
            aria-pressed={privacyHidden}
            onClick={() => setPrivacyHidden((hidden) => !hidden)}
          >
            {privacyHidden ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="log-toolbar-button icon-toolbar-button"
            aria-label={activeDrawer === "log" ? "Close game log" : "Open game log"}
            aria-expanded={activeDrawer === "log"}
            onClick={() => setActiveDrawer((drawer) => (drawer === "log" ? null : "log"))}
          >
            <ListTree aria-hidden="true" />
            <span className="toolbar-count">{log.length}</span>
          </button>
          <button
            type="button"
            className="dev-toolbar-button icon-toolbar-button"
            aria-label={activeDrawer === "dev" ? "Close developer menu" : "Open developer menu"}
            aria-expanded={activeDrawer === "dev"}
            onClick={() => setActiveDrawer((drawer) => (drawer === "dev" ? null : "dev"))}
          >
            <Wrench aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {showWorkspaceTools && activeDrawer === "log" ? (
        <aside className="app-drawer game-log-drawer" role="dialog" aria-label="Game log">
          <h2>Log</h2>
          <div className="game-log-list">
            {log.length === 0 ? <p>No actions recorded yet.</p> : null}
            {[...log].reverse().map((entry) => {
              const previewable = events.some(({ id }) => id === entry.id);
              return (
                <article key={entry.id}>
                  <span className="log-sequence">#{entry.sequence}</span>
                  <div>
                    <strong>{entry.type}</strong>
                    <small>
                      {entry.phase} · {new Date(entry.createdAt).toLocaleTimeString()}
                    </small>
                    <div className="log-state-actions">
                      <button
                        type="button"
                        disabled={!previewable}
                        aria-label={`Preview state after log #${entry.sequence}`}
                        onClick={() => previewEventState(entry.id)}
                      >
                        Preview state
                      </button>
                      <button
                        type="button"
                        className="danger-action"
                        disabled={!previewable}
                        aria-label={`Reset game to state after log #${entry.sequence}`}
                        onClick={() => resetToEventState(entry.id)}
                      >
                        Reset
                      </button>
                    </div>
                    {!previewable ? (
                      <small>State preview unavailable for this legacy entry.</small>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        </aside>
      ) : null}
      {showWorkspaceTools && activeDrawer === "dev" ? (
        <aside
          ref={devDrawerRef}
          className="app-drawer dev-menu-drawer"
          role="dialog"
          aria-label="Developer menu"
        >
          <h2>Dev menu</h2>
          <div className="dev-menu-actions">
            <button
              type="button"
              onClick={() => {
                setActiveDrawer(null);
                onEditClub();
              }}
            >
              Edit club
            </button>
            {club.role === "owner" ? (
              <button
                type="button"
                className="danger-action"
                onClick={() => {
                  setActiveDrawer(null);
                  void onDeleteClub();
                }}
              >
                Delete club
              </button>
            ) : null}
            <button type="button" onClick={() => onColorThemeChange(nextColorTheme)}>
              Use {nextColorThemeLabel} theme
            </button>
            <fieldset className="glass-settings" disabled={colorTheme !== "malaga-glass"}>
              <legend>Glass settings</legend>
              <p className="muted">
                {trueRefractionSupported
                  ? "True refraction available"
                  : "True refraction unavailable · using fallback"}
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={glassSettings.enabled}
                  onChange={(event) => updateGlassSettings({ enabled: event.target.checked })}
                />
                <span>Enable glass effect</span>
              </label>
              {(
                [
                  ["blur", "Glass blur"],
                  ["glassThickness", "Glass thickness"],
                  ["bezelWidth", "Bezel width"],
                  ["refractiveIndex", "Refractive index"],
                  ["specularOpacity", "Specular opacity"],
                  ["specularAngle", "Specular angle"],
                  ["fallbackOpacity", "Fallback opacity"],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  <span>{label}</span>
                  <input
                    type="number"
                    aria-label={label}
                    min={GLASS_SETTINGS_BOUNDS[key].min}
                    max={GLASS_SETTINGS_BOUNDS[key].max}
                    step={GLASS_SETTINGS_BOUNDS[key].step}
                    value={glassSettings[key]}
                    onChange={(event) => updateGlassSettings({ [key]: Number(event.target.value) })}
                  />
                </label>
              ))}
              <button
                type="button"
                onClick={() =>
                  setGlassSettings(writeGlassSettings(window.localStorage, DEFAULT_GLASS_SETTINGS))
                }
              >
                Reset glass settings
              </button>
            </fieldset>
            <button
              type="button"
              onClick={() => {
                if (view === "players" && availablePlayersForSetup.length < 11) {
                  const missing = 11 - availablePlayersForSetup.length;
                  setRosterGateError(
                    players.length < 11
                      ? `Add ${11 - players.length} more registered ${11 - players.length === 1 ? "player" : "players"} before opening the game screen.`
                      : `Mark ${missing} more ${missing === 1 ? "player" : "players"} available before opening the game screen.`,
                  );
                  setActiveDrawer(null);
                  return;
                }
                setRosterGateError(null);
                setAvailabilityScreenOpen(false);
                setView((currentView) => (currentView === "players" ? "game" : "players"));
                setActiveDrawer(null);
              }}
            >
              {view === "players" ? "Game screen" : "Players screen"}
            </button>
            <button
              type="button"
              onClick={() => {
                viewBeforeTimelineRef.current = view === "players" ? "players" : "game";
                setActiveDrawer(null);
                setView("timeline");
              }}
            >
              Past game timeline
            </button>
            <button
              type="button"
              onClick={() => {
                viewBeforeConsoleRef.current = view === "players" ? "players" : "game";
                setActiveDrawer(null);
                setView("console");
              }}
            >
              Console
            </button>
            {game === null && setupSession === null && playlistId === defaultPlaylistId ? null : (
              <button type="button" className="danger-action" onClick={() => void clearGameState()}>
                Clear game state
              </button>
            )}
            <button type="button" onClick={() => setBackgroundShade(nextBackgroundShade)}>
              Use {backgroundShadeLabel[nextBackgroundShade]} background
            </button>
            <button
              type="button"
              aria-pressed={devModeEnabled}
              onClick={() => setDevModeEnabled((enabled) => !enabled)}
            >
              {devModeEnabled ? "Disable dev mode" : "Enable dev mode"}
            </button>
            <button
              type="button"
              aria-expanded={musicSetupOpen}
              aria-controls="dev-music-setup"
              onClick={() => setMusicSetupOpen((open) => !open)}
            >
              {musicSetupOpen ? "Hide music player setup" : "Music player setup"}
            </button>
            {musicSetupOpen ? (
              <section
                id="dev-music-setup"
                className="dev-music-setup"
                aria-label="Music player setup"
              >
                <div className={`music-status ${musicState === "playing" ? "is-playing" : ""}`}>
                  <span className="status-dot" />
                  <strong>{musicLabel[musicState]}</strong>
                </div>
                <button
                  type="button"
                  onClick={() => setMusicReloadRequest((request) => request + 1)}
                >
                  Reload music player
                </button>
                <fieldset className="volume-mode-setup">
                  <legend>Volume modes</legend>
                  {musicVolumePresets.map((volume, index) => (
                    <label key={index}>
                      <span>{index === 0 ? "Low" : "High"}</span>
                      <input
                        type="number"
                        min="1"
                        max="100"
                        value={volume}
                        onChange={(event) => {
                          const nextValue = Math.min(
                            100,
                            Math.max(1, Number(event.target.value) || 1),
                          );
                          const presets: readonly [number, number] =
                            index === 0
                              ? [nextValue, musicVolumePresets[1]]
                              : [musicVolumePresets[0], nextValue];
                          setMusicVolumePresets(presets);
                          setActiveMusicVolume(presets[1]);
                        }}
                      />
                    </label>
                  ))}
                </fieldset>
                <AccountPlaylistPicker
                  playlistId={playlistId}
                  onPlaylistIdChange={changePlaylistId}
                  onAccountDisconnected={clearMusicAccountState}
                  stagePlaylistIds={musicPreferences.stagePlaylistIds}
                  onStagePlaylistIdsChange={changeStagePlaylistIds}
                />
              </section>
            ) : null}
            <button
              type="button"
              className="danger-action"
              disabled={clearingAllData}
              onClick={() => void clearApplicationData()}
            >
              {clearingAllData ? "Clearing…" : "Clear all data"}
            </button>
          </div>
          <section className="dev-active-sessions" aria-labelledby="dev-active-sessions-title">
            <h3 id="dev-active-sessions-title">Active games</h3>
            {activeSessionsError ? (
              <p role="alert">Active games are temporarily unavailable.</p>
            ) : activeSessions.length === 0 ? (
              <p>No active games to resume.</p>
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
                      {deletingSessionId === session.gameId ? "Deleting…" : "Delete"}
                    </button>
                    <div className="session-swipe-content">
                      <div>
                        <strong>{session.name}</strong>
                        <span>
                          {session.hostName ?? "Host not selected"} · {session.phase} · day{" "}
                          {session.day}
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
                        {resumeGameId === session.gameId ? "Resuming…" : `Resume ${session.name}`}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {clearAllDataError ? (
            <p className="dev-menu-error" role="alert">
              Unable to clear all browser data completely.
            </p>
          ) : null}
        </aside>
      ) : null}

      {view === "console" ? (
        <ErrorConsoleScreen onBack={() => setView(viewBeforeConsoleRef.current)} />
      ) : view === "timeline" ? (
        <GameTimelineScreen
          clubId={club.id}
          onBack={() => setView(viewBeforeTimelineRef.current)}
          showDevelopmentTools={devModeEnabled}
          currentHistory={currentTimelineHistory}
          onPreviewCurrentEvent={(eventId) => {
            previewEventState(eventId);
            setView("game");
          }}
          onResetCurrentEvent={(eventId) => {
            void resetToEventState(eventId).then((reset) => {
              if (reset) setView("game");
            });
          }}
        />
      ) : view === "players" ? (
        <>
          {rosterGateError !== null ? (
            <p className="roster-gate-error" role="alert">
              {rosterGateError}
            </p>
          ) : null}
          {playersError ? (
            <p className="players-load-error" role="alert">
              Player profiles are temporarily unavailable.
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
            showDevelopmentTools={devModeEnabled}
            onPopulateDevelopmentPlayers={populateDevelopmentPlayers}
            onOpenAvailablePlayers={() => setAvailabilityScreenOpen(true)}
            privacyHidden={privacyHidden}
            fullscreenTouchPicker={touchTablet}
            initialSessionState={setupSession}
            onSessionStateChange={handleSetupSessionChange}
            musicPlaying={musicState === "playing"}
            musicStatus={musicLabel[musicState]}
            playlistId={playlistId}
            onPlaylistIdChange={changePlaylistId}
            volumePresets={musicVolumePresets}
            onVolumePresetsChange={(presets) => {
              setMusicVolumePresets(presets);
              setActiveMusicVolume(presets[1]);
            }}
            onEvent={logEvent}
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
                draft: { type: "game.checkpointed", payload: {}, secret: true },
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
              setResetReturnUndoBudget(0);
              phaseRef.current = next.phase;
              setSetupSession(null);
              setHostPlayerId(selectedHostPlayerId);
              setHostName(selectedHostName);
              setFinalResults(null);
              setGame(next);
            }}
          />
        </>
      ) : (
        <GameScreen
          key={`${previewGame === null ? "live" : "preview"}-${renderedGameScreenMutationGeneration}`}
          game={previewGame ?? game}
          gameName={sessionName}
          hostName={hostName ?? "Host"}
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
        game={view === "game" && previewGame === null ? game : null}
        hidden={view !== "game" || previewGame !== null}
        theme={colorTheme}
        glassSettings={glassSettings}
        supportsTrueRefraction={trueRefractionSupported}
      >
        <MusicDock
          expanded={musicPlayerExpanded}
          onExpandedChange={setMusicPlayerExpanded}
          hidden={view !== "game" || previewGame !== null}
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
            onExpandedChange={setMusicPlayerExpanded}
            volumePresets={musicVolumePresets}
            activeVolume={activeMusicVolume}
            onVolumeChange={setActiveMusicVolume}
            reloadRequest={musicReloadRequest}
            rememberedQueueOrder={musicPreferences.queueOrderByPlaylist[playlistId] ?? []}
            onQueueOrderChange={changeQueueOrder}
          />
        </MusicDock>
      </LiveSidePanel>
    </div>
  );
};

export const App = () => {
  const [colorTheme, setColorTheme] = useState<ColorTheme>(() =>
    readColorTheme(window.localStorage),
  );
  const [user, setUser] = useState<AppUser | null>(null);
  const [authConfigured, setAuthConfigured] = useState<boolean | null>(null);
  const [authUnavailable, setAuthUnavailable] = useState(false);
  const [clubs, setClubs] = useState<readonly Club[]>([]);
  const [selectedClub, setSelectedClub] = useState<Club | null>(null);
  const [editingClub, setEditingClub] = useState<Club | "new" | null>(null);
  const [openingCurtains, setOpeningCurtains] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    applyColorTheme(document.documentElement, window.localStorage, colorTheme);
  }, [colorTheme]);

  const refreshClubs = useCallback(async () => {
    setLoading(true);
    try {
      setClubs(await listClubs());
      setError(null);
    } catch (error) {
      reportError(error, { source: "api", context: "clubs.list" });
      setError("Clubs are temporarily unavailable.");
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
      clearGameSessionStorage(window.sessionStorage);
      setUser(null);
      setClubs([]);
      setSelectedClub(null);
      setEditingClub(null);
      setError(null);
    } catch (error) {
      reportError(error, { source: "api", context: "auth.sign-out" });
      setError("Sign out could not be completed.");
    } finally {
      setLoading(false);
    }
  };

  const saveClub = async (clubId: string | null, input: ClubInput) => {
    if (user === null) throw new Error("Sign in before editing a club");
    try {
      const saved = clubId === null ? await createClub(input) : await updateClub(clubId, input);
      setClubs((current) =>
        clubId === null
          ? [...current, saved]
          : current.map((club) => (club.id === clubId ? saved : club)),
      );
      setError(null);
    } catch (saveError) {
      reportError(saveError, { source: "api", context: "clubs.save" });
      setError("The club could not be saved.");
      throw saveError;
    }
  };

  const removeClub = async (club: Club) => {
    if (user === null) throw new Error("Sign in before deleting a club");
    if (
      !window.confirm(
        `Delete "${club.name}" and all of its players, games, and statistics? This cannot be undone.`,
      )
    ) {
      return;
    }
    try {
      await deleteClub(club.id);
      window.sessionStorage.removeItem(gameSessionStorageKey(club.id));
      window.sessionStorage.removeItem(legacyGameSessionStorageKey(club.id));
      window.localStorage.removeItem(availablePlayerStorageKey(club.id));
      setClubs((current) => current.filter(({ id }) => id !== club.id));
      setSelectedClub(null);
      setEditingClub(null);
      setError(null);
    } catch (error) {
      reportError(error, { source: "api", context: "clubs.delete" });
      setError("The club could not be deleted.");
    }
  };

  const openClub = (club: Club) => {
    setEditingClub(null);
    setSelectedClub(club);
    setOpeningCurtains(true);
    window.setTimeout(() => setOpeningCurtains(false), 900);
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
          colorTheme={colorTheme}
          onColorThemeChange={setColorTheme}
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
      colorTheme={colorTheme}
      clubs={clubs}
      loading={loading}
      error={error}
      editing={editingClub}
      onSignOut={endSession}
      onColorThemeChange={setColorTheme}
      onEditingChange={setEditingClub}
      onSaveClub={saveClub}
      onOpenClub={openClub}
    />
  );
};

import { useCallback, useEffect, useRef, useState } from "react";
import type { GameState } from "@mafia/game-domain";
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
import { GameScreen } from "./features/game/GameScreen.js";
import { MusicDock } from "./features/music/MusicDock.js";
import {
  YouTubePlaylistPlayer,
  type YouTubePlaybackState,
  type YouTubePlayerHandle,
} from "./features/music/YouTubePlaylistPlayer.js";
import { PlayersScreen } from "./features/players/PlayersScreen.js";
import { buildFinalGameResults } from "./features/players/game-results.js";
import { SetupWizard, type SetupWizardSessionState } from "./features/setup/SetupWizard.js";
import { GameSessionOutbox } from "./session-outbox.js";
import { createRandomId } from "./utils/random-id.js";
import { applyColorTheme, readColorTheme, type ColorTheme } from "./theme.js";
import "./styles/app.css";
import "./styles/clubs.css";

interface LocalLogEntry {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly phase: string;
  readonly payload: Record<string, unknown>;
  readonly secret: boolean;
  readonly createdAt: string;
}

interface UndoSnapshot {
  readonly game: GameState;
  readonly logLength: number;
  readonly sequence: number;
}

type BackgroundShade = "black" | "grey-33" | "grey-66" | "white";

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
const centerShadowStorageKey = "mafia-dashboard.center-shadow";
const defaultClubId = "00000000-0000-4000-8000-000000000101";
const gameSessionStoragePrefix = "mafia-dashboard.game-session.v3";
const gameSessionStorageKey = (clubId: string) =>
  clubId === defaultClubId ? gameSessionStoragePrefix : `${gameSessionStoragePrefix}.${clubId}`;
const clearGameSessionStorage = (storage: Storage) => {
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (key === gameSessionStoragePrefix || key?.startsWith(`${gameSessionStoragePrefix}.`)) {
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
  readonly undoHistory: readonly UndoSnapshot[];
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

const asPersistedState = (state: GameSessionState | undefined): PersistedState => ({
  ...migratePlanningNames(state),
  hostPlayerId: state?.hostPlayerId ?? null,
  hostName: state?.hostName ?? null,
  playlistId: state?.playlistId ?? defaultPlaylistId,
  log: (state?.log as readonly LocalLogEntry[] | undefined) ?? [],
  undoHistory: ((state?.undoHistory as readonly UndoSnapshot[] | undefined) ?? []).map(
    (snapshot) =>
      (snapshot.game as unknown as { phase: string }).phase === "mafia-negotiation"
        ? { ...snapshot, game: { ...snapshot.game, phase: "mafia-planning" } }
        : snapshot,
  ),
});

export const ClubWorkspace = ({
  club,
  onExit,
}: {
  readonly club: Club;
  readonly onExit: () => void;
}) => {
  const sessionSyncRef = useRef<GameSessionOutbox | null>(null);
  if (sessionSyncRef.current === null) {
    sessionSyncRef.current = new GameSessionOutbox({
      storage: window.sessionStorage,
      storageKey: gameSessionStorageKey(club.id),
      createId: createRandomId,
      save: (gameId, mutation) => saveGameSession(gameId, mutation, club.id),
    });
  }
  const sessionSync = sessionSyncRef.current;
  const initialCurrent = useRef(sessionSync.current).current;
  const initialState = useRef(asPersistedState(initialCurrent?.state)).current;

  const [view, setView] = useState<"game" | "players">("game");
  const [sessionName, setSessionName] = useState(
    () => initialCurrent?.name ?? nextGameName(window.localStorage, new Date()),
  );
  const [game, setGame] = useState<GameState | null>(initialState.game);
  const [setupSession, setSetupSession] = useState<SetupWizardSessionState | null>(
    initialState.setup,
  );
  const [setupInstanceKey, setSetupInstanceKey] = useState(0);
  const [randomFillRequest, setRandomFillRequest] = useState(0);
  const [hostPlayerId, setHostPlayerId] = useState<string | null>(initialState.hostPlayerId);
  const [hostName, setHostName] = useState<string | null>(initialState.hostName);
  const [finalResults, setFinalResults] = useState<FinalGameResults | null>(
    initialCurrent?.results ?? null,
  );
  const [finishGameState, setFinishGameState] = useState<"ready" | "saving" | "saved" | "error">(
    initialCurrent?.results === null || initialCurrent?.results === undefined ? "ready" : "saved",
  );
  const [players, setPlayers] = useState<readonly PlayerProfile[]>([]);
  const [playersError, setPlayersError] = useState(false);
  const [rosterGateError, setRosterGateError] = useState<string | null>(null);
  const [playlistId, setPlaylistId] = useState(initialState.playlistId);
  const [musicPlayerExpanded, setMusicPlayerExpanded] = useState(false);
  const [musicVolumePresets, setMusicVolumePresets] = useState<readonly [number, number]>([50, 80]);
  const [activeMusicVolume, setActiveMusicVolume] = useState(80);
  const [musicReloadRequest, setMusicReloadRequest] = useState(0);
  const [musicState, setMusicState] = useState<YouTubePlaybackState>("idle");
  const [log, setLog] = useState<readonly LocalLogEntry[]>(initialState.log);
  const [undoHistory, setUndoHistory] = useState<readonly UndoSnapshot[]>(initialState.undoHistory);
  const [activeSessions, setActiveSessions] = useState<readonly ActiveGameSessionSummary[]>([]);
  const [activeSessionsError, setActiveSessionsError] = useState(false);
  const [resumeGameId, setResumeGameId] = useState<string | null>(null);
  const [swipedSessionId, setSwipedSessionId] = useState<string | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [activeDrawer, setActiveDrawer] = useState<"log" | "dev" | null>(null);
  const [backgroundShade, setBackgroundShade] = useState<BackgroundShade>("black");
  const [centerShadowVisible, setCenterShadowVisible] = useState(
    () => window.localStorage.getItem(centerShadowStorageKey) !== "hidden",
  );
  const [privacyHidden, setPrivacyHidden] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(() => currentFullscreenElement() !== null);
  const [clearingAllData, setClearingAllData] = useState(false);
  const [clearAllDataError, setClearAllDataError] = useState(false);
  const [, setSyncRender] = useState(0);

  const musicRef = useRef<YouTubePlayerHandle>(null);
  const devDrawerRef = useRef<HTMLElement>(null);
  const touchTablet = useRef(isTouchTablet()).current;
  const sessionSwipeStartRef = useRef<{ readonly gameId: string; readonly x: number } | null>(null);
  const logRef = useRef<readonly LocalLogEntry[]>(initialState.log);
  const sequenceRef = useRef(initialState.log.at(-1)?.sequence ?? 0);
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
    } catch {
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
    } catch {
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
        const canonicalName = sessionSync.current?.name;
        if (canonicalName !== undefined) setSessionName(canonicalName);
      }),
    [sessionSync],
  );

  useEffect(() => {
    void sessionSync.flush().catch(() => undefined);
  }, [sessionSync]);

  useEffect(() => {
    const hasContent =
      game !== null ||
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
        game,
        hostPlayerId,
        hostName,
        playlistId,
        log,
        undoHistory,
      },
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
      .catch(() => undefined);
  }, [
    finalResults,
    game,
    hostName,
    hostPlayerId,
    log,
    playlistId,
    refreshPlayers,
    sessionName,
    sessionSync,
    setupSession,
    undoHistory,
  ]);

  const logEvent = useCallback((type: string, payload: Record<string, unknown>) => {
    if (isAuxiliaryEvent(type)) return;
    sequenceRef.current += 1;
    const entry: LocalLogEntry = {
      id: createRandomId(),
      sequence: sequenceRef.current,
      type,
      phase: phaseRef.current,
      payload,
      secret: isSecretEvent(type, payload),
      createdAt: new Date().toISOString(),
    };
    const nextLog = [...logRef.current, entry];
    logRef.current = nextLog;
    setLog(nextLog);
  }, []);

  const changeGame = (next: GameState) => {
    if (game !== null) {
      if (next.day > game.day) {
        setUndoHistory([]);
      } else {
        const snapshot: UndoSnapshot = {
          game,
          logLength: logRef.current.length,
          sequence: sequenceRef.current,
        };
        setUndoHistory((current) => [...current, snapshot].slice(-3));
      }
    }
    phaseRef.current = next.phase;
    setGame(next);
    if (next.phase === "finished" && game?.phase !== "finished") {
      setFinalResults(null);
      setFinishGameState("ready");
    } else if (next.phase !== "finished") {
      setFinalResults(null);
      setFinishGameState("ready");
    }
  };

  const finishGame = async () => {
    if (game?.phase !== "finished" || hostPlayerId === null || finishGameState === "saving") return;
    const results = buildFinalGameResults(game, new Date(), hostPlayerId);
    setFinishGameState("saving");
    setFinalResults(results);
    setUndoHistory([]);
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
      },
      results,
    );
    try {
      await sessionSync.flush();
      persistedResultsRef.current = results;
      await Promise.all([refreshPlayers(), refreshActiveSessions()]);
      setFinishGameState("saved");
    } catch {
      setFinishGameState("error");
    }
  };

  const undoLastGameAction = () => {
    const snapshot = undoHistory.at(-1);
    if (snapshot === undefined) return;
    setUndoHistory((current) => current.slice(0, -1));
    phaseRef.current = snapshot.game.phase;
    setGame(snapshot.game);
    if (snapshot.game.phase !== "finished") {
      setFinalResults(null);
      setFinishGameState("ready");
    }
    const restoredLog = logRef.current.slice(0, snapshot.logLength);
    logRef.current = restoredLog;
    setLog(restoredLog);
    sequenceRef.current = snapshot.sequence;
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

  const deleteProfile = async (playerId: string) => {
    await deletePlayer(playerId, club.id);
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
      setSessionName(session.name);
      setGame(restored.game);
      setSetupSession(restored.setup);
      setHostPlayerId(restored.hostPlayerId);
      setHostName(restored.hostName);
      setPlaylistId(restored.playlistId);
      setFinalResults(session.results);
      setFinishGameState(session.results === null ? "ready" : "saved");
      persistedResultsRef.current = session.results;
      setLog(restored.log);
      logRef.current = restored.log;
      setUndoHistory(restored.undoHistory);
      sequenceRef.current = restored.log.at(-1)?.sequence ?? 0;
      phaseRef.current = restored.game?.phase ?? setupPhase(restored.setup?.step);
      setSetupInstanceKey((key) => key + 1);
      setView("game");
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
    } catch {
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
    setFinishGameState("ready");
    setPlaylistId(defaultPlaylistId);
    setSetupInstanceKey((key) => key + 1);
    setView("game");
    setUndoHistory([]);
    setLog([]);
    logRef.current = [];
    sequenceRef.current = 0;
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
    } catch {
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
    } catch {
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
      setCenterShadowVisible(true);
      resetLocalState();
      window.localStorage.clear();
      setActiveDrawer(null);
    } catch {
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
    } catch {
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

  const persistenceState = sessionSync.status;
  const setupStep = setupSession?.step ?? "players";
  const roleGiveawayActive = view === "game" && game === null && setupStep === "roles";
  const showApplicationStatus = view === "players" || (game === null && !roleGiveawayActive);
  const applicationStatusTitle = view === "players" ? "Players & statistics" : "Game setup";
  const applicationStatusPhase =
    view === "players"
      ? players.length < 11
        ? `Need 11 players · ${players.length} registered`
        : `${players.length} game ${players.length === 1 ? "player" : "players"}`
      : setupStep === "music"
        ? "Table music"
        : "Select players";
  const nextBackgroundShade =
    backgroundShadeOrder[
      (backgroundShadeOrder.indexOf(backgroundShade) + 1) % backgroundShadeOrder.length
    ]!;

  return (
    <div
      className={`app-shell${backgroundShadeClass[backgroundShade]}${
        view === "game" && (game !== null || roleGiveawayActive)
          ? " has-live-game table-layout-shell"
          : ""
      }${game !== null ? " has-timer-rail" : ""}${
        showApplicationStatus ? " has-top-level-screen" : ""
      }${isFullscreen ? " is-fullscreen" : ""}${centerShadowVisible ? "" : " is-center-shadow-hidden"}`}
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
          aria-label={`Undo last action · ${undoHistory.length} available`}
          disabled={undoHistory.length === 0}
          onClick={undoLastGameAction}
        >
          <Undo2 aria-hidden="true" />
          <span className="toolbar-count">{undoHistory.length}</span>
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
      {activeDrawer === "log" ? (
        <aside className="app-drawer game-log-drawer" role="dialog" aria-label="Game log">
          <h2>Log</h2>
          <div className="game-log-list">
            {log.length === 0 ? <p>No actions recorded yet.</p> : null}
            {[...log].reverse().map((entry) => (
              <article key={entry.id}>
                <span className="log-sequence">#{entry.sequence}</span>
                <div>
                  <strong>{entry.type}</strong>
                  <small>
                    {entry.phase} · {new Date(entry.createdAt).toLocaleTimeString()}
                  </small>
                </div>
              </article>
            ))}
          </div>
        </aside>
      ) : null}
      {activeDrawer === "dev" ? (
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
                if (view === "players" && players.length < 11) {
                  setRosterGateError(
                    `Add ${11 - players.length} more registered ${11 - players.length === 1 ? "player" : "players"} before opening the game screen.`,
                  );
                  setActiveDrawer(null);
                  return;
                }
                setRosterGateError(null);
                setView((currentView) => (currentView === "players" ? "game" : "players"));
                setActiveDrawer(null);
              }}
            >
              {view === "players" ? "Game screen" : "Players screen"}
            </button>
            {view === "game" && game === null && setupStep === "players" ? (
              <button
                type="button"
                disabled={players.length < 11}
                onClick={() => {
                  setRandomFillRequest((request) => request + 1);
                  setActiveDrawer(null);
                }}
              >
                Randomly fill 10 seats
              </button>
            ) : null}
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
              onClick={() => {
                setCenterShadowVisible((visible) => {
                  const next = !visible;
                  window.localStorage.setItem(centerShadowStorageKey, next ? "visible" : "hidden");
                  return next;
                });
              }}
            >
              {centerShadowVisible ? "Hide table center shadow" : "Show table center shadow"}
            </button>
            <button type="button" onClick={() => setMusicReloadRequest((request) => request + 1)}>
              Reload music player
            </button>
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

      {view === "players" ? (
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
      ) : game === null ? (
        <>
          <SetupWizard
            key={setupInstanceKey}
            players={players}
            showDevelopmentTools={import.meta.env.DEV}
            onPopulateDevelopmentPlayers={populateDevelopmentPlayers}
            randomFillRequest={randomFillRequest}
            privacyHidden={privacyHidden}
            fullscreenTouchPicker={touchTablet}
            initialSessionState={setupSession}
            onSessionStateChange={handleSetupSessionChange}
            musicPlaying={musicState === "playing"}
            musicStatus={musicLabel[musicState]}
            playlistId={playlistId}
            onPlaylistIdChange={setPlaylistId}
            volumePresets={musicVolumePresets}
            onVolumePresetsChange={(presets) => {
              setMusicVolumePresets(presets);
              setActiveMusicVolume(presets[1]);
            }}
            onEvent={logEvent}
            onComplete={(next, selectedHostPlayerId, selectedHostName) => {
              phaseRef.current = next.phase;
              setSetupSession(null);
              setHostPlayerId(selectedHostPlayerId);
              setHostName(selectedHostName);
              setFinalResults(null);
              setUndoHistory([]);
              setGame(next);
            }}
          />
        </>
      ) : (
        <GameScreen
          game={game}
          gameName={sessionName}
          hostName={hostName ?? "Host"}
          onGameChange={changeGame}
          onEvent={logEvent}
          privacyHidden={privacyHidden}
          clubLogo={club.headerLogo}
          clubName={club.name}
          finishGameState={finishGameState}
          onFinishGame={() => void finishGame()}
        />
      )}

      <MusicDock
        expanded={musicPlayerExpanded}
        hidden={view === "players"}
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
        />
      </MusicDock>
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
    } catch {
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
      .catch(() => {
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
      setError(null);
    } catch {
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
      setClubs((current) => current.filter(({ id }) => id !== club.id));
      setError(null);
    } catch {
      setError("The club could not be deleted.");
    }
  };

  const openClub = (club: Club) => {
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
          onExit={() => setSelectedClub(null)}
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
      onSignOut={endSession}
      onColorThemeChange={setColorTheme}
      onSaveClub={saveClub}
      onDeleteClub={removeClub}
      onOpenClub={openClub}
    />
  );
};

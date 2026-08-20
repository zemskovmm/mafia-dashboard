import { useCallback, useEffect, useRef, useState } from "react";
import type { GameState } from "@mafia/game-domain";
import {
  clearGameSession,
  createPlayer,
  deletePlayer,
  getGameSession,
  listActiveGameSessions,
  listPlayers,
  saveGameSession,
  updatePlayer,
} from "./api/client.js";
import type {
  ActiveGameSessionSummary,
  FinalGameResults,
  GameSessionState,
  PlayerProfile,
  PlayerProfileInput,
  RemoteGameSession,
} from "./api/client.js";
import { GameScreen } from "./features/game/GameScreen.js";
import { LiveMusicControls } from "./features/music/LiveMusicControls.js";
import { LocalDJPlayer, type LocalDJSessionState } from "./features/music/LocalDJPlayer.js";
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
import "./styles/app.css";

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

const isTouchIPad = () =>
  /iPad/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

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

const asPersistedState = (state: GameSessionState | undefined): PersistedState => ({
  setup: (state?.setup as SetupWizardSessionState | null | undefined) ?? null,
  game: (state?.game as GameState | null | undefined) ?? null,
  hostPlayerId: state?.hostPlayerId ?? null,
  hostName: state?.hostName ?? null,
  playlistId: state?.playlistId ?? defaultPlaylistId,
  log: (state?.log as readonly LocalLogEntry[] | undefined) ?? [],
  undoHistory: (state?.undoHistory as readonly UndoSnapshot[] | undefined) ?? [],
});

export const App = () => {
  const sessionSyncRef = useRef<GameSessionOutbox | null>(null);
  if (sessionSyncRef.current === null) {
    sessionSyncRef.current = new GameSessionOutbox({
      storage: window.sessionStorage,
      createId: createRandomId,
      save: saveGameSession,
    });
  }
  const sessionSync = sessionSyncRef.current;
  const initialCurrent = useRef(sessionSync.current).current;
  const initialState = useRef(asPersistedState(initialCurrent?.state)).current;

  const [view, setView] = useState<"game" | "players">("game");
  const [sessionName, setSessionName] = useState(initialCurrent?.name ?? "Mafia table");
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
  const [players, setPlayers] = useState<readonly PlayerProfile[]>([]);
  const [playersError, setPlayersError] = useState(false);
  const [playlistId, setPlaylistId] = useState(initialState.playlistId);
  const [musicSource, setMusicSource] = useState<"youtube" | "local">("youtube");
  const [musicPlayerExpanded, setMusicPlayerExpanded] = useState(false);
  const [musicVolumePresets, setMusicVolumePresets] = useState<readonly [number, number]>([50, 80]);
  const [activeMusicVolume, setActiveMusicVolume] = useState(80);
  const [musicReloadRequest, setMusicReloadRequest] = useState(0);
  const [localDjSession, setLocalDjSession] = useState<LocalDJSessionState | null>(null);
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
  const [privacyHidden, setPrivacyHidden] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(() => currentFullscreenElement() !== null);
  const [clearingAllData, setClearingAllData] = useState(false);
  const [clearAllDataError, setClearAllDataError] = useState(false);
  const [, setSyncRender] = useState(0);

  const musicRef = useRef<YouTubePlayerHandle>(null);
  const devDrawerRef = useRef<HTMLElement>(null);
  const touchIPad = useRef(isTouchIPad()).current;
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
      const nextPlayers = await listPlayers();
      if (playerRequestRef.current === request) {
        setPlayers(nextPlayers);
        setPlayersError(false);
      }
    } catch {
      if (playerRequestRef.current === request) setPlayersError(true);
    }
  }, []);

  const refreshActiveSessions = useCallback(async () => {
    const request = activeSessionsRequestRef.current + 1;
    activeSessionsRequestRef.current = request;
    try {
      const sessions = await listActiveGameSessions();
      if (activeSessionsRequestRef.current === request) {
        setActiveSessions(sessions);
        setActiveSessionsError(false);
      }
    } catch {
      if (activeSessionsRequestRef.current === request) setActiveSessionsError(true);
    }
  }, []);

  useEffect(() => {
    void refreshPlayers();
    void refreshActiveSessions();
  }, [refreshActiveSessions, refreshPlayers]);

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
    if (next.phase === "finished" && game?.phase !== "finished" && hostPlayerId !== null) {
      setFinalResults(buildFinalGameResults(next, new Date(), hostPlayerId));
    } else if (next.phase !== "finished") {
      setFinalResults(null);
    }
  };

  const undoLastGameAction = () => {
    const snapshot = undoHistory.at(-1);
    if (snapshot === undefined) return;
    setUndoHistory((current) => current.slice(0, -1));
    phaseRef.current = snapshot.game.phase;
    setGame(snapshot.game);
    if (snapshot.game.phase !== "finished") setFinalResults(null);
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
    await createPlayer(input);
    await refreshPlayers();
  };

  const updateProfile = async (playerId: string, input: PlayerProfileInput) => {
    await updatePlayer(playerId, input);
    await refreshPlayers();
  };

  const deleteProfile = async (playerId: string) => {
    await deletePlayer(playerId);
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
          await createPlayer({
            nickname: `Dev ${adjective} ${alias} ${batchId}-${index + 1}`,
            consent: false,
            firstName: null,
            lastName: null,
            email: null,
          }),
        );
      }
      return created;
    } catch (error) {
      await Promise.allSettled(created.map(({ id }) => deletePlayer(id)));
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
      const session = await getGameSession(gameId);
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
    setSessionName("Mafia table");
    setGame(null);
    setSetupSession(null);
    setHostPlayerId(null);
    setHostName(null);
    setFinalResults(null);
    setPlaylistId(defaultPlaylistId);
    setMusicSource("youtube");
    setLocalDjSession(null);
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
      await sessionSync.clear(clearGameSession);
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
        await sessionSync.clear(clearGameSession);
        resetLocalState();
      } else {
        await clearGameSession(session.gameId, session.revision);
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
      resetLocalState();
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
      ? `${players.length} game ${players.length === 1 ? "player" : "players"}`
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
      }`}
    >
      {showApplicationStatus ? (
        <header
          className="app-status-bar game-header"
          role="banner"
          aria-label="Application status"
        >
          <div>
            <p className="eyebrow">
              {view === "players" ? "Persistent roster" : "Game setup"} · Host view
            </p>
            <h1>{applicationStatusTitle}</h1>
          </div>
          <div className="phase-banner">{applicationStatusPhase}</div>
        </header>
      ) : null}
      <div className="app-fixed-toolbar" aria-label="Application tools">
        <div className="save-indicator" data-status={persistenceState}>
          <span />{" "}
          {persistenceState === "saved"
            ? "Saved"
            : persistenceState === "offline"
              ? "Local only"
              : "Saving"}
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
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
          </svg>
        </button>
        <button
          type="button"
          className="undo-button"
          aria-label={`Undo last action · ${undoHistory.length} available`}
          disabled={undoHistory.length === 0}
          onClick={undoLastGameAction}
        >
          Undo · {undoHistory.length}
        </button>
        <button
          type="button"
          className="privacy-button icon-toolbar-button"
          aria-label={privacyHidden ? "Show private info" : "Hide private info"}
          aria-pressed={privacyHidden}
          onClick={() => setPrivacyHidden((hidden) => !hidden)}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M2 5c3.6 0 6.5 1 8.5 3.5a2 2 0 0 0 3 0C15.5 6 18.4 5 22 5v4.5c0 4.1-3.4 7.5-7.5 7.5-.9 0-1.7-.4-2.2-1.1a.4.4 0 0 0-.6 0c-.5.7-1.3 1.1-2.2 1.1C5.4 17 2 13.6 2 9.5V5Z" />
            <path d="M6 11c1.5 0 2.5.5 3 2M18 11c-1.5 0-2.5.5-3 2" />
          </svg>
        </button>
        <button
          type="button"
          className="log-toolbar-button"
          aria-label={activeDrawer === "log" ? "Close game log" : "Open game log"}
          aria-expanded={activeDrawer === "log"}
          onClick={() => setActiveDrawer((drawer) => (drawer === "log" ? null : "log"))}
        >
          Log <span>{log.length}</span>
        </button>
        <button
          type="button"
          aria-label={activeDrawer === "dev" ? "Close developer menu" : "Open developer menu"}
          aria-expanded={activeDrawer === "dev"}
          onClick={() => setActiveDrawer((drawer) => (drawer === "dev" ? null : "dev"))}
        >
          Dev
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
            {musicSource === "youtube" ? (
              <button type="button" onClick={() => setMusicReloadRequest((request) => request + 1)}>
                Reload music player
              </button>
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

      {view === "players" ? (
        <>
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
            fullscreenTouchPicker={isFullscreen && touchIPad}
            initialSessionState={setupSession}
            onSessionStateChange={handleSetupSessionChange}
            musicPlaying={musicState === "playing"}
            musicStatus={musicLabel[musicState]}
            playlistId={playlistId}
            onPlaylistIdChange={setPlaylistId}
            musicSource={musicSource}
            volumePresets={musicVolumePresets}
            onVolumePresetsChange={(presets) => {
              setMusicVolumePresets(presets);
              setActiveMusicVolume(presets[1]);
            }}
            onMusicSourceChange={(source) => {
              setMusicSource(source);
              setMusicPlayerExpanded(false);
              setMusicState("idle");
            }}
            onStartMusic={() => {
              void musicRef.current?.fadeIn();
            }}
            onQuickStopMusic={() => {
              void musicRef.current?.quickFadeOut();
            }}
            onSlowStopMusic={() => {
              void musicRef.current?.slowFadeOut();
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
          hostName={hostName ?? "Host"}
          onGameChange={changeGame}
          onEvent={logEvent}
          privacyHidden={privacyHidden}
        />
      )}

      <div
        className={`${musicSource === "local" ? "local-dj-dock" : "youtube-dock"} is-compact${
          musicSource === "youtube" && musicPlayerExpanded ? " is-expanded" : ""
        }`}
      >
        {musicSource === "local" ? (
          <LocalDJPlayer
            ref={musicRef}
            onStateChange={handleMusicState}
            initialSessionState={localDjSession}
            onSessionStateChange={setLocalDjSession}
          />
        ) : (
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
        )}
        <LiveMusicControls
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
        />
      </div>
    </div>
  );
};

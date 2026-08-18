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

interface PersistedState extends GameSessionState {
  readonly setup: SetupWizardSessionState | null;
  readonly game: GameState | null;
  readonly log: readonly LocalLogEntry[];
  readonly undoHistory: readonly UndoSnapshot[];
}

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

const isSecretEvent = (type: string, payload: Record<string, unknown>) =>
  payload.secret === true ||
  type === "setup.role-drawn" ||
  type.includes("shot") ||
  type.includes("checked");

const isAuxiliaryEvent = (type: string) => type.startsWith("timer.") || type.startsWith("music.");

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
  const [hostPlayerId, setHostPlayerId] = useState<string | null>(initialState.hostPlayerId);
  const [hostName, setHostName] = useState<string | null>(initialState.hostName);
  const [finalResults, setFinalResults] = useState<FinalGameResults | null>(
    initialCurrent?.results ?? null,
  );
  const [players, setPlayers] = useState<readonly PlayerProfile[]>([]);
  const [playersError, setPlayersError] = useState(false);
  const [playlistId, setPlaylistId] = useState(initialState.playlistId);
  const [musicSource, setMusicSource] = useState<"youtube" | "local">("youtube");
  const [localDjSession, setLocalDjSession] = useState<LocalDJSessionState | null>(null);
  const [musicState, setMusicState] = useState<YouTubePlaybackState>("idle");
  const [log, setLog] = useState<readonly LocalLogEntry[]>(initialState.log);
  const [undoHistory, setUndoHistory] = useState<readonly UndoSnapshot[]>(initialState.undoHistory);
  const [activeSessions, setActiveSessions] = useState<readonly ActiveGameSessionSummary[]>([]);
  const [activeSessionsError, setActiveSessionsError] = useState(false);
  const [resumeGameId, setResumeGameId] = useState<string | null>(null);
  const [, setSyncRender] = useState(0);

  const musicRef = useRef<YouTubePlayerHandle>(null);
  const logRef = useRef<readonly LocalLogEntry[]>(initialState.log);
  const sequenceRef = useRef(initialState.log.at(-1)?.sequence ?? 0);
  const phaseRef = useRef(initialState.game?.phase ?? "setup-players");
  const playerRequestRef = useRef(0);
  const activeSessionsRequestRef = useRef(0);
  const resumeRequestRef = useRef(0);
  const persistedResultsRef = useRef<FinalGameResults | null>(initialCurrent?.results ?? null);

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
      phaseRef.current = restored.game?.phase ?? "setup-players";
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

  return (
    <div className={`app-shell${view === "game" && game !== null ? " has-live-game" : ""}`}>
      <nav className="app-navigation" aria-label="Application sections">
        <button type="button" aria-pressed={view === "game"} onClick={() => setView("game")}>
          {game === null ? "Game setup" : "Live game"}
        </button>
        <button type="button" aria-pressed={view === "players"} onClick={() => setView("players")}>
          Players &amp; statistics
        </button>
        {game === null && setupSession === null && playlistId === defaultPlaylistId ? null : (
          <button type="button" className="clear-game-state" onClick={() => void clearGameState()}>
            Clear game state
          </button>
        )}
      </nav>
      <div className="save-indicator" data-status={persistenceState}>
        <span />{" "}
        {persistenceState === "saved"
          ? "Saved"
          : persistenceState === "offline"
            ? "Local only"
            : "Saving"}
      </div>

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
          <section className="active-game-sessions" aria-labelledby="active-game-sessions-title">
            <h2 id="active-game-sessions-title">Active games</h2>
            {activeSessionsError ? (
              <p role="alert">Active games are temporarily unavailable.</p>
            ) : activeSessions.length === 0 ? (
              <p>No active games to resume.</p>
            ) : (
              <ul>
                {activeSessions.map((session) => (
                  <li key={session.gameId}>
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
                      onClick={() => void resumeSession(session.gameId)}
                    >
                      {resumeGameId === session.gameId ? "Resuming…" : `Resume ${session.name}`}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <SetupWizard
            key={setupInstanceKey}
            players={players}
            showDevelopmentTools={import.meta.env.DEV}
            onPopulateDevelopmentPlayers={populateDevelopmentPlayers}
            initialSessionState={setupSession}
            onSessionStateChange={handleSetupSessionChange}
            musicPlaying={musicState === "playing"}
            musicStatus={musicLabel[musicState]}
            playlistId={playlistId}
            onPlaylistIdChange={setPlaylistId}
            musicSource={musicSource}
            onMusicSourceChange={(source) => {
              setMusicSource(source);
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
          onUndo={undoLastGameAction}
          undoCount={undoHistory.length}
        />
      )}

      {view === "players" ? null : (
        <div
          className={`${musicSource === "local" ? "local-dj-dock" : "youtube-dock"}${
            game === null ? "" : " is-compact"
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
            />
          )}
          {game === null ? null : (
            <LiveMusicControls
              isPlaying={musicState === "playing"}
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
          )}
        </div>
      )}

      {view === "players" ? null : (
        <details className="game-log-drawer">
          <summary>
            Game log <span>{log.length}</span>
          </summary>
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
        </details>
      )}
    </div>
  );
};

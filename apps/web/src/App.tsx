import { useCallback, useEffect, useRef, useState } from "react";
import type { GameState } from "@mafia/game-domain";
import {
  appendRemoteEvent,
  createPlayer,
  createRemoteGame,
  listPlayers,
  saveGameResults,
  updatePlayer,
} from "./api/client.js";
import type { FinalGameResults, PlayerProfile, PlayerProfileInput } from "./api/client.js";
import { GameScreen } from "./features/game/GameScreen.js";
import { LiveMusicControls } from "./features/music/LiveMusicControls.js";
import {
  YouTubePlaylistPlayer,
  type YouTubePlaybackState,
  type YouTubePlayerHandle,
} from "./features/music/YouTubePlaylistPlayer.js";
import { PlayersScreen } from "./features/players/PlayersScreen.js";
import { buildFinalGameResults } from "./features/players/game-results.js";
import { SetupWizard, type SetupWizardSessionState } from "./features/setup/SetupWizard.js";
import { createRandomId } from "./utils/random-id.js";
import "./styles/app.css";

interface LocalLogEntry {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly phase: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: Date;
}

interface PendingRemoteEvent {
  readonly idempotencyKey: string;
  readonly type: string;
  readonly phase: string;
  readonly seat?: number;
  readonly payload: Record<string, unknown>;
  readonly secret: boolean;
}

const noQueuedVideos: readonly string[] = [];
const gameSessionStorageKey = "mafia-dashboard.game-session.v1";
const defaultPlaylistId = import.meta.env.VITE_YOUTUBE_PLAYLIST_ID ?? "";

interface GameSessionSnapshot {
  readonly version: 1;
  readonly game: GameState | null;
  readonly setup: SetupWizardSessionState | null;
  readonly playlistId: string;
  readonly remoteGameId: string | null;
}

const loadGameSession = (): GameSessionSnapshot => {
  const empty: GameSessionSnapshot = {
    version: 1,
    game: null,
    setup: null,
    playlistId: defaultPlaylistId,
    remoteGameId: null,
  };
  try {
    const stored = window.sessionStorage.getItem(gameSessionStorageKey);
    if (stored === null) return empty;
    const parsed = JSON.parse(stored) as {
      readonly version?: unknown;
      readonly game?: unknown;
      readonly setup?: unknown;
      readonly playlistId?: unknown;
      readonly remoteGameId?: unknown;
    };
    if (parsed.version !== 1) return empty;
    return {
      version: 1,
      game:
        typeof parsed.game === "object" && parsed.game !== null ? (parsed.game as GameState) : null,
      setup:
        typeof parsed.setup === "object" && parsed.setup !== null
          ? (parsed.setup as SetupWizardSessionState)
          : null,
      playlistId: typeof parsed.playlistId === "string" ? parsed.playlistId : defaultPlaylistId,
      remoteGameId: typeof parsed.remoteGameId === "string" ? parsed.remoteGameId : null,
    };
  } catch {
    return empty;
  }
};

const hasSetupProgress = ({ step, selectedPlayerIds, setup }: SetupWizardSessionState) =>
  step !== "players" || setup !== null || selectedPlayerIds.some((playerId) => playerId !== "");

const isSecretEvent = (type: string, payload: Record<string, unknown>) =>
  payload.secret === true ||
  type === "setup.role-drawn" ||
  type.includes("shot") ||
  type.includes("checked");

export const App = () => {
  const initialSession = useRef(loadGameSession()).current;
  const [view, setView] = useState<"game" | "players">("game");
  const [game, setGame] = useState<GameState | null>(initialSession.game);
  const [setupSession, setSetupSession] = useState<SetupWizardSessionState | null>(
    initialSession.setup,
  );
  const [setupInstanceKey, setSetupInstanceKey] = useState(0);
  const [players, setPlayers] = useState<readonly PlayerProfile[]>([]);
  const [playersError, setPlayersError] = useState(false);
  const [playlistId, setPlaylistId] = useState(initialSession.playlistId);
  const [remoteGameId, setRemoteGameId] = useState(initialSession.remoteGameId);
  const [musicState, setMusicState] = useState<YouTubePlaybackState>("idle");
  const [log, setLog] = useState<LocalLogEntry[]>([]);
  const [persistenceState, setPersistenceState] = useState<"connecting" | "saved" | "offline">(
    "connecting",
  );
  const gameIdRef = useRef<string | null>(initialSession.remoteGameId);
  const pendingRef = useRef<PendingRemoteEvent[]>([]);
  const pendingResultsRef = useRef<FinalGameResults | null>(null);
  const savedResultGameIdsRef = useRef(new Set<string>());
  const musicRef = useRef<YouTubePlayerHandle>(null);
  const sequenceRef = useRef(0);
  const phaseRef = useRef(initialSession.game?.phase ?? "setup-players");
  const playerRequestRef = useRef(0);

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

  useEffect(() => {
    void refreshPlayers();
  }, [refreshPlayers]);

  useEffect(() => {
    if (game === null && setupSession === null && playlistId === defaultPlaylistId) {
      window.sessionStorage.removeItem(gameSessionStorageKey);
      return;
    }
    window.sessionStorage.setItem(
      gameSessionStorageKey,
      JSON.stringify({ version: 1, game, setup: setupSession, playlistId, remoteGameId }),
    );
  }, [game, playlistId, remoteGameId, setupSession]);

  const persistResults = useCallback(
    async (gameId: string, results: FinalGameResults) => {
      if (savedResultGameIdsRef.current.has(gameId)) return;
      savedResultGameIdsRef.current.add(gameId);
      setPersistenceState("connecting");
      try {
        await saveGameResults(gameId, results);
        pendingResultsRef.current = null;
        await refreshPlayers();
        setPersistenceState("saved");
      } catch {
        savedResultGameIdsRef.current.delete(gameId);
        pendingResultsRef.current = results;
        setPersistenceState("offline");
      }
    },
    [refreshPlayers],
  );

  useEffect(() => {
    if (remoteGameId !== null) {
      gameIdRef.current = remoteGameId;
      setPersistenceState("saved");
      return undefined;
    }
    let active = true;
    gameIdRef.current = null;
    void createRemoteGame("Mafia table")
      .then(async (gameId) => {
        if (!active) return;
        gameIdRef.current = gameId;
        const pending = pendingRef.current.splice(0);
        for (const event of pending) {
          await appendRemoteEvent(gameId, event);
        }
        const pendingResults = pendingResultsRef.current;
        if (pendingResults === null) {
          setPersistenceState("saved");
        } else {
          await persistResults(gameId, pendingResults);
        }
        if (active) setRemoteGameId(gameId);
      })
      .catch(() => {
        if (active) setPersistenceState("offline");
      });
    return () => {
      active = false;
    };
  }, [persistResults, remoteGameId]);

  const logEvent = useCallback((type: string, payload: Record<string, unknown>) => {
    sequenceRef.current += 1;
    const phase = phaseRef.current;
    const idempotencyKey = createRandomId();
    const entry: LocalLogEntry = {
      id: idempotencyKey,
      sequence: sequenceRef.current,
      type,
      phase,
      payload,
      createdAt: new Date(),
    };
    setLog((current) => [...current, entry]);

    const seat = typeof payload.seat === "number" ? payload.seat : undefined;
    const remote: PendingRemoteEvent = {
      idempotencyKey,
      type,
      phase,
      ...(seat === undefined ? {} : { seat }),
      payload,
      secret: isSecretEvent(type, payload),
    };
    const gameId = gameIdRef.current;
    if (gameId === null) {
      pendingRef.current.push(remote);
      return;
    }
    setPersistenceState("connecting");
    void appendRemoteEvent(gameId, remote)
      .then(() => setPersistenceState("saved"))
      .catch(() => setPersistenceState("offline"));
  }, []);

  const changeGame = (next: GameState) => {
    phaseRef.current = next.phase;
    setGame(next);
    const results = buildFinalGameResults(next, new Date());
    if (results === null) return;
    const gameId = gameIdRef.current;
    if (gameId === null) {
      pendingResultsRef.current = results;
    } else {
      void persistResults(gameId, results);
    }
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

  const handleSetupSessionChange = useCallback((next: SetupWizardSessionState) => {
    setSetupSession(hasSetupProgress(next) ? next : null);
  }, []);

  const clearGameState = () => {
    if (!window.confirm("Clear the current game from this browser session?")) return;
    window.sessionStorage.removeItem(gameSessionStorageKey);
    setGame(null);
    setSetupSession(null);
    setPlaylistId(defaultPlaylistId);
    gameIdRef.current = null;
    setRemoteGameId(null);
    setSetupInstanceKey((key) => key + 1);
    setView("game");
    setLog([]);
    sequenceRef.current = 0;
    phaseRef.current = "setup-players";
    pendingRef.current = [];
    pendingResultsRef.current = null;
    savedResultGameIdsRef.current.clear();
  };

  return (
    <div className="app-shell">
      <nav className="app-navigation" aria-label="Application sections">
        <button type="button" aria-pressed={view === "game"} onClick={() => setView("game")}>
          {game === null ? "Game setup" : "Live game"}
        </button>
        <button type="button" aria-pressed={view === "players"} onClick={() => setView("players")}>
          Players &amp; statistics
        </button>
        {game === null && setupSession === null ? null : (
          <button type="button" className="clear-game-state" onClick={clearGameState}>
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
          <PlayersScreen players={players} onCreate={createProfile} onUpdate={updateProfile} />
        </>
      ) : game === null ? (
        <SetupWizard
          key={setupInstanceKey}
          players={players}
          initialSessionState={setupSession}
          onSessionStateChange={handleSetupSessionChange}
          musicPlaying={musicState === "playing"}
          musicStatus={musicLabel[musicState]}
          playlistId={playlistId}
          onPlaylistIdChange={setPlaylistId}
          onStartMusic={() => {
            logEvent("music.fade-in-requested", { playlistId });
            void musicRef.current?.fadeIn();
          }}
          onQuickStopMusic={() => {
            logEvent("music.quick-fade-out-requested", {});
            void musicRef.current?.quickFadeOut();
          }}
          onSlowStopMusic={() => {
            logEvent("music.slow-fade-out-requested", {});
            void musicRef.current?.slowFadeOut();
          }}
          onEvent={logEvent}
          onComplete={(next) => {
            phaseRef.current = next.phase;
            setSetupSession(null);
            setGame(next);
          }}
        />
      ) : (
        <GameScreen game={game} onGameChange={changeGame} onEvent={logEvent} />
      )}

      {view === "players" ? null : (
        <div className={game === null ? "youtube-dock" : "youtube-dock is-compact"}>
          <YouTubePlaylistPlayer
            ref={musicRef}
            playlistId={playlistId}
            queue={noQueuedVideos}
            onStateChange={handleMusicState}
          />
          {game === null ? null : (
            <LiveMusicControls
              isPlaying={musicState === "playing"}
              onFadeIn={() => {
                logEvent("music.fade-in-requested", { playlistId });
                void musicRef.current?.fadeIn();
              }}
              onQuickFadeOut={() => {
                logEvent("music.quick-fade-out-requested", {});
                void musicRef.current?.quickFadeOut();
              }}
              onSlowFadeOut={() => {
                logEvent("music.slow-fade-out-requested", {});
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
                    {entry.phase} · {entry.createdAt.toLocaleTimeString()}
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

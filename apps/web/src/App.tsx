import { useCallback, useEffect, useRef, useState } from "react";
import type { GameState } from "@mafia/game-domain";
import { appendRemoteEvent, createRemoteGame } from "./api/client.js";
import { GameScreen } from "./features/game/GameScreen.js";
import { LiveMusicControls } from "./features/music/LiveMusicControls.js";
import {
  YouTubePlaylistPlayer,
  type YouTubePlaybackState,
  type YouTubePlayerHandle,
} from "./features/music/YouTubePlaylistPlayer.js";
import { SetupWizard } from "./features/setup/SetupWizard.js";
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

const isSecretEvent = (type: string, payload: Record<string, unknown>) =>
  payload.secret === true ||
  type === "setup.role-drawn" ||
  type.includes("shot") ||
  type.includes("checked");

export const App = () => {
  const [game, setGame] = useState<GameState | null>(null);
  const [playlistId, setPlaylistId] = useState(import.meta.env.VITE_YOUTUBE_PLAYLIST_ID ?? "");
  const [playbackQueue, setPlaybackQueue] = useState<readonly string[]>([]);
  const [musicState, setMusicState] = useState<YouTubePlaybackState>("idle");
  const [log, setLog] = useState<LocalLogEntry[]>([]);
  const [persistenceState, setPersistenceState] = useState<"connecting" | "saved" | "offline">(
    "connecting",
  );
  const gameIdRef = useRef<string | null>(null);
  const pendingRef = useRef<PendingRemoteEvent[]>([]);
  const musicRef = useRef<YouTubePlayerHandle>(null);
  const sequenceRef = useRef(0);
  const phaseRef = useRef("setup-players");

  useEffect(() => {
    let active = true;
    void createRemoteGame("Mafia table")
      .then(async (gameId) => {
        if (!active) return;
        gameIdRef.current = gameId;
        const pending = pendingRef.current.splice(0);
        for (const event of pending) {
          await appendRemoteEvent(gameId, event);
        }
        setPersistenceState("saved");
      })
      .catch(() => {
        if (active) setPersistenceState("offline");
      });
    return () => {
      active = false;
    };
  }, []);

  const logEvent = useCallback((type: string, payload: Record<string, unknown>) => {
    sequenceRef.current += 1;
    const phase = phaseRef.current;
    const idempotencyKey = crypto.randomUUID();
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

  return (
    <div className="app-shell">
      <div className="save-indicator" data-status={persistenceState}>
        <span />{" "}
        {persistenceState === "saved"
          ? "Saved"
          : persistenceState === "offline"
            ? "Local only"
            : "Saving"}
      </div>

      {game === null ? (
        <SetupWizard
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
          onQueueChange={setPlaybackQueue}
          onEvent={logEvent}
          onComplete={(next) => {
            phaseRef.current = next.phase;
            setGame(next);
          }}
        />
      ) : (
        <GameScreen game={game} onGameChange={changeGame} onEvent={logEvent} />
      )}

      <div className={game === null ? "youtube-dock" : "youtube-dock is-compact"}>
        <YouTubePlaylistPlayer
          ref={musicRef}
          playlistId={playlistId}
          queue={playbackQueue}
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
    </div>
  );
};

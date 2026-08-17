import { useMemo, useState } from "react";
import {
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createSetup,
  drawRoleForSeat,
  setMusicState,
} from "@mafia/game-domain";
import type { GameState, PlayerInput, SetupState } from "@mafia/game-domain";
import { normalizeYouTubeVideoId } from "../music/youtube-id.js";
import { GameTable } from "../table/GameTable.js";

interface SetupWizardProps {
  readonly musicPlaying: boolean;
  readonly musicStatus: string;
  readonly playlistId: string;
  readonly onPlaylistIdChange: (playlistId: string) => void;
  readonly onStartMusic: () => void;
  readonly onQuickStopMusic: () => void;
  readonly onSlowStopMusic: () => void;
  readonly onQueueChange: (queue: readonly string[]) => void;
  readonly onComplete: (game: GameState) => void;
  readonly onEvent?: (type: string, payload: Record<string, unknown>) => void;
}

type WizardStep = "players" | "music" | "roles";

export const SetupWizard = ({
  musicPlaying,
  musicStatus,
  playlistId,
  onPlaylistIdChange,
  onStartMusic,
  onQuickStopMusic,
  onSlowStopMusic,
  onQueueChange,
  onComplete,
  onEvent = () => undefined,
}: SetupWizardProps) => {
  const [step, setStep] = useState<WizardStep>("players");
  const [names, setNames] = useState(() => Array.from({ length: 10 }, () => ""));
  const [setup, setSetup] = useState<SetupState | null>(null);

  const [queueInput, setQueueInput] = useState("");
  const [queue, setQueue] = useState<string[]>([]);
  const [queueError, setQueueError] = useState<string | null>(null);

  const players = useMemo<PlayerInput[]>(
    () =>
      names.map((name, index) => ({
        id: `seat-${index + 1}-${name
          .trim()
          .toLowerCase()
          .replaceAll(/[^a-z0-9]+/g, "-")}`,
        name: name.trim(),
        seat: index + 1,
      })),
    [names],
  );
  const playersReady =
    players.every(({ name }) => name.length > 0) &&
    new Set(players.map(({ name }) => name.toLocaleLowerCase()).values()).size === 10;

  const continueToMusic = () => {
    const nextSetup = createSetup(players);
    setSetup(nextSetup);
    setStep("music");
    onEvent("setup.players-selected", {
      players: players.map(({ id, name, seat }) => ({ id, name, seat })),
    });
  };

  const continueToRoles = () => {
    if (setup === null || !musicPlaying) {
      return;
    }
    setSetup(beginRoleDraw(setMusicState(setup, "playing"), Math.random));
    setStep("roles");
    onEvent("setup.role-draw-started", {});
  };

  const drawRole = (seat: number) => {
    if (setup === null || setup.assignments[seat] !== undefined) {
      return;
    }
    const next = drawRoleForSeat(setup, seat);
    setSetup(next);
    onEvent("setup.role-drawn", { seat, role: next.assignments[seat], secret: true });
  };

  const finish = () => {
    if (setup === null) {
      return;
    }
    const game = createGame(completeRoleDraw(setup));
    onEvent("setup.completed", { phase: game.phase });
    onComplete(game);
  };

  return (
    <main className="setup-shell">
      <div className="wizard-progress" aria-label="Setup progress">
        {[
          ["players", "1 · Players"],
          ["music", "2 · Music"],
          ["roles", "3 · Roles"],
        ].map(([value, label]) => (
          <span key={value} className={step === value ? "is-active" : ""}>
            {label}
          </span>
        ))}
      </div>

      {step === "players" ? (
        <section className="wizard-card">
          <p className="eyebrow">Setup · Step 1</p>
          <h1>Select 10 players</h1>
          <p className="lead">The list order becomes seats 1–10 around the table.</p>
          <div className="player-input-grid">
            {names.map((name, index) => (
              <label key={index}>
                <span>Seat {index + 1}</span>
                <input
                  aria-label={`Seat ${index + 1} player`}
                  value={name}
                  autoComplete="off"
                  placeholder={`Player ${index + 1}`}
                  onChange={(event) => {
                    const next = [...names];
                    next[index] = event.target.value;
                    setNames(next);
                  }}
                />
              </label>
            ))}
          </div>
          <button
            className="primary-action"
            type="button"
            disabled={!playersReady}
            onClick={continueToMusic}
          >
            Continue to music
          </button>
        </section>
      ) : null}

      {step === "music" ? (
        <section className="wizard-card music-step">
          <p className="eyebrow">Setup · Step 2</p>
          <h1>Start table music</h1>
          <p className="lead">Playback must be confirmed before roles can be drawn.</p>
          <div className={`music-status ${musicPlaying ? "is-playing" : ""}`}>
            <span className="status-dot" />
            <strong>{musicStatus}</strong>
          </div>
          <label className="wide-field">
            <span>YouTube playlist ID</span>
            <input
              value={playlistId}
              placeholder="Paste a playlist ID"
              onChange={(event) => onPlaylistIdChange(event.target.value)}
            />
          </label>
          <div className="music-actions">
            <button
              type="button"
              className="primary-action"
              disabled={playlistId.trim().length === 0 && queue.length === 0}
              onClick={onStartMusic}
            >
              Start · fade in
            </button>
            <button type="button" disabled={!musicPlaying} onClick={onQuickStopMusic}>
              Quick fade out
            </button>
            <button type="button" disabled={!musicPlaying} onClick={onSlowStopMusic}>
              Slow fade out
            </button>
          </div>
          <div className="queue-editor">
            <h2>Quick queue</h2>
            <div className="queue-entry">
              <input
                aria-label="YouTube video URL or ID"
                value={queueInput}
                placeholder="YouTube video URL or ID"
                onChange={(event) => {
                  setQueueInput(event.target.value);
                  setQueueError(null);
                }}
              />
              <button
                type="button"
                disabled={queueInput.trim().length === 0}
                onClick={() => {
                  const videoId = normalizeYouTubeVideoId(queueInput);
                  if (videoId === null) {
                    setQueueError("Enter a valid YouTube video URL or 11-character ID.");
                    return;
                  }
                  const next = [...queue, videoId];
                  setQueue(next);
                  onQueueChange(next);
                  onEvent("music.queue-item-added", { item: videoId });
                  setQueueInput("");
                }}
              >
                Add
              </button>
            </div>
            {queueError === null ? null : <p className="queue-error">{queueError}</p>}
            {queue.length === 0 ? <p className="muted">Playlist order will be used.</p> : null}
            <ol>
              {queue.map((item, index) => (
                <li key={`${item}-${index}`}>
                  <span>{item}</span>
                  <button
                    type="button"
                    onClick={() => {
                      const next = queue.filter((_, itemIndex) => itemIndex !== index);
                      setQueue(next);
                      onQueueChange(next);
                      onEvent("music.queue-item-removed", { item, index });
                    }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ol>
          </div>
          <button
            className="primary-action"
            type="button"
            disabled={!musicPlaying}
            onClick={continueToRoles}
          >
            Continue to role draw
          </button>
        </section>
      ) : null}

      {step === "roles" && setup !== null ? (
        <section className="role-draw-step">
          <p className="eyebrow">Setup · Step 3</p>
          <h1>Draw roles at the table</h1>
          <p className="lead">Tap each player once to draw from the shuffled role deck.</p>
          <p className="roles-remaining">Roles remaining: {setup.remainingRoles.length}</p>
          <GameTable
            seats={setup.players.map((player) => ({
              seat: player.seat,
              name: player.name,
              role: setup.assignments[player.seat],
            }))}
            seatActionLabel={(seat) =>
              seat.role === undefined ? `Draw role for ${seat.name}` : `${seat.name}: ${seat.role}`
            }
            onSeatClick={drawRole}
            center={
              setup.remainingRoles.length === 0 ? (
                <button type="button" className="table-primary" onClick={finish}>
                  Begin Mafia negotiation
                </button>
              ) : (
                <span className="table-prompt">Tap a player</span>
              )
            }
          />
        </section>
      ) : null}
    </main>
  );
};

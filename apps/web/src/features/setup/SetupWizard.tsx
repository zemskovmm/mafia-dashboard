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
import type { PlayerProfile } from "../../api/client.js";
import { AccountPlaylistPicker } from "../music/AccountPlaylistPicker.js";
import { GameTable } from "../table/GameTable.js";

interface SetupWizardProps {
  readonly players: readonly PlayerProfile[];
  readonly musicPlaying: boolean;
  readonly musicStatus: string;
  readonly playlistId: string;
  readonly onPlaylistIdChange: (playlistId: string) => void;
  readonly onStartMusic: () => void;
  readonly onQuickStopMusic: () => void;
  readonly onSlowStopMusic: () => void;
  readonly onComplete: (game: GameState) => void;
  readonly onEvent?: (type: string, payload: Record<string, unknown>) => void;
}

type WizardStep = "players" | "music" | "roles";

export const SetupWizard = ({
  players: availablePlayers,
  musicPlaying,
  musicStatus,
  playlistId,
  onPlaylistIdChange,
  onStartMusic,
  onQuickStopMusic,
  onSlowStopMusic,
  onComplete,
  onEvent = () => undefined,
}: SetupWizardProps) => {
  const [step, setStep] = useState<WizardStep>("players");
  const [selectedPlayerIds, setSelectedPlayerIds] = useState(() =>
    Array.from({ length: 10 }, () => ""),
  );
  const [setup, setSetup] = useState<SetupState | null>(null);

  const players = useMemo<PlayerInput[]>(
    () =>
      selectedPlayerIds.flatMap((playerId, index) => {
        const player = availablePlayers.find(({ id }) => id === playerId);
        return player === undefined
          ? []
          : [{ id: player.id, name: player.nickname, seat: index + 1 }];
      }),
    [availablePlayers, selectedPlayerIds],
  );
  const playersReady =
    players.length === 10 && new Set(selectedPlayerIds.filter(Boolean)).size === 10;

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
          <p className="lead">
            Choose saved nicknames. The list order becomes seats 1–10 around the table.
          </p>
          {availablePlayers.length < 10 ? (
            <p className="roster-guidance">
              Add at least 10 players in Players &amp; statistics before continuing.
            </p>
          ) : null}
          <div className="player-input-grid">
            {selectedPlayerIds.map((playerId, index) => (
              <label key={index}>
                <span>Seat {index + 1}</span>
                <select
                  aria-label={`Seat ${index + 1} player`}
                  value={playerId}
                  onChange={(event) => {
                    const next = [...selectedPlayerIds];
                    next[index] = event.target.value;
                    setSelectedPlayerIds(next);
                  }}
                >
                  <option value="">Choose a nickname</option>
                  {availablePlayers.map((player) => (
                    <option
                      key={player.id}
                      value={player.id}
                      disabled={selectedPlayerIds.some(
                        (selectedId, selectedIndex) =>
                          selectedIndex !== index && selectedId === player.id,
                      )}
                    >
                      {player.nickname}
                    </option>
                  ))}
                </select>
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
          <AccountPlaylistPicker playlistId={playlistId} onPlaylistIdChange={onPlaylistIdChange} />
          <div className="music-actions">
            <button
              type="button"
              className="primary-action"
              disabled={playlistId.trim().length === 0}
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

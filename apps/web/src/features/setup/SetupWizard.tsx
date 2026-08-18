import { useEffect, useMemo, useState } from "react";
import {
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createSetup,
  drawRoleForSeat,
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
  readonly onComplete: (game: GameState, hostPlayerId: string, hostName: string) => void;
  readonly onEvent?: (type: string, payload: Record<string, unknown>) => void;
  readonly initialSessionState?: SetupWizardSessionState | null;
  readonly onSessionStateChange?: (state: SetupWizardSessionState) => void;
  readonly showDevelopmentTools?: boolean;
  readonly onPopulateDevelopmentPlayers?: () => Promise<readonly PlayerProfile[]>;
}

type WizardStep = "players" | "music" | "roles";

export interface SetupWizardSessionState {
  readonly step: WizardStep;
  readonly hostPlayerId?: string;
  readonly selectedPlayerIds: readonly string[];
  readonly setup: SetupState | null;
}

const shuffled = <Value,>(values: readonly Value[]): Value[] => {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
};

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
  initialSessionState = null,
  onSessionStateChange,
  showDevelopmentTools = false,
  onPopulateDevelopmentPlayers,
}: SetupWizardProps) => {
  const [step, setStep] = useState<WizardStep>(initialSessionState?.step ?? "players");
  const [selectedPlayerIds, setSelectedPlayerIds] = useState(() =>
    initialSessionState?.selectedPlayerIds.length === 10
      ? [...initialSessionState.selectedPlayerIds]
      : Array.from({ length: 10 }, () => ""),
  );
  const [hostPlayerId, setHostPlayerId] = useState(initialSessionState?.hostPlayerId ?? "");
  const [setup, setSetup] = useState<SetupState | null>(initialSessionState?.setup ?? null);
  const [playerSearch, setPlayerSearch] = useState("");
  const [developmentPlayers, setDevelopmentPlayers] = useState<readonly PlayerProfile[]>([]);
  const [populatingPlayers, setPopulatingPlayers] = useState(false);
  const [developmentError, setDevelopmentError] = useState(false);

  const selectablePlayers = useMemo(
    () => [
      ...availablePlayers,
      ...developmentPlayers.filter(
        ({ id }) => !availablePlayers.some((available) => available.id === id),
      ),
    ],
    [availablePlayers, developmentPlayers],
  );

  useEffect(() => {
    onSessionStateChange?.({ step, hostPlayerId, selectedPlayerIds, setup });
  }, [hostPlayerId, onSessionStateChange, selectedPlayerIds, setup, step]);

  useEffect(() => {
    if (step === "players" || selectablePlayers.length === 0) return;
    const availableIds = new Set(selectablePlayers.map(({ id }) => id));
    const restoredIds = [hostPlayerId, ...selectedPlayerIds];
    const valid =
      restoredIds.length === 11 &&
      restoredIds.every((playerId) => playerId !== "" && availableIds.has(playerId)) &&
      new Set(restoredIds).size === 11;
    if (valid) return;
    setStep("players");
    setHostPlayerId("");
    setSelectedPlayerIds(
      selectedPlayerIds.map((playerId) => (availableIds.has(playerId) ? playerId : "")),
    );
    setSetup(null);
  }, [hostPlayerId, selectablePlayers, selectedPlayerIds, step]);

  const players = useMemo<PlayerInput[]>(
    () =>
      selectedPlayerIds.flatMap((playerId, index) => {
        const player = selectablePlayers.find(({ id }) => id === playerId);
        return player === undefined
          ? []
          : [{ id: player.id, name: player.nickname, seat: index + 1 }];
      }),
    [selectablePlayers, selectedPlayerIds],
  );
  const hostPlayer = selectablePlayers.find(({ id }) => id === hostPlayerId);
  const playersReady =
    hostPlayer !== undefined &&
    players.length === 10 &&
    new Set([hostPlayerId, ...selectedPlayerIds.filter(Boolean)]).size === 11;
  const normalizedPlayerSearch = playerSearch.trim().toLocaleLowerCase();
  const matchingPlayers = useMemo(
    () =>
      normalizedPlayerSearch.length === 0
        ? selectablePlayers
        : selectablePlayers.filter(({ nickname }) =>
            nickname.toLocaleLowerCase().includes(normalizedPlayerSearch),
          ),
    [normalizedPlayerSearch, selectablePlayers],
  );

  const publishSessionState = (nextStep: WizardStep, nextSetup: SetupState | null) => {
    onSessionStateChange?.({
      step: nextStep,
      hostPlayerId,
      selectedPlayerIds,
      setup: nextSetup,
    });
  };

  const continueToMusic = () => {
    const nextSetup = createSetup(players);
    setSetup(nextSetup);
    setStep("music");
    publishSessionState("music", nextSetup);
    onEvent("setup.players-selected", {
      hostPlayerId,
      players: players.map(({ id, name, seat }) => ({ id, name, seat })),
    });
  };

  const continueToRoles = () => {
    if (setup === null || !musicPlaying) {
      return;
    }
    const nextSetup = beginRoleDraw(setup, Math.random);
    setSetup(nextSetup);
    setStep("roles");
    publishSessionState("roles", nextSetup);
    onEvent("setup.role-draw-started", {});
  };

  const drawRole = (seat: number) => {
    if (setup === null || setup.assignments[seat] !== undefined) {
      return;
    }
    const next = drawRoleForSeat(setup, seat);
    setSetup(next);
    publishSessionState("roles", next);
    onEvent("setup.role-drawn", { seat, role: next.assignments[seat], secret: true });
  };

  const finish = () => {
    if (setup === null || hostPlayer === undefined) {
      return;
    }
    const game = createGame(completeRoleDraw(setup));
    onEvent("setup.completed", { phase: game.phase });
    onComplete(game, hostPlayerId, hostPlayer.nickname);
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
          <h1>Select 10 players + host</h1>
          <p className="lead">
            Choose a saved host and ten different saved players. The player order becomes seats 1–10
            around the table.
          </p>
          {selectablePlayers.length < 11 ? (
            <p className="roster-guidance">
              Add at least 11 players in Players &amp; statistics before continuing.
            </p>
          ) : null}
          {showDevelopmentTools && onPopulateDevelopmentPlayers !== undefined ? (
            <div className="development-player-tools">
              <strong>Development only</strong>
              <button
                type="button"
                disabled={populatingPlayers}
                onClick={() => {
                  setDevelopmentError(false);
                  setPopulatingPlayers(true);
                  void onPopulateDevelopmentPlayers()
                    .then((generated) => {
                      if (generated.length < 11)
                        throw new Error("A host and ten players were not generated");
                      const selected = generated.slice(0, 11);
                      setDevelopmentPlayers(selected);
                      setHostPlayerId(selected[0]!.id);
                      setSelectedPlayerIds(selected.slice(1).map(({ id }) => id));
                      setPlayerSearch("");
                    })
                    .catch(() => setDevelopmentError(true))
                    .finally(() => setPopulatingPlayers(false));
                }}
              >
                {populatingPlayers
                  ? "Development only · Generating players…"
                  : "Development only · Generate and select host + 10 random players"}
              </button>
              {developmentError ? (
                <p role="alert">Development players could not be generated. Please try again.</p>
              ) : null}
            </div>
          ) : null}
          <label className="player-search-field">
            <span>Search saved players</span>
            <input
              type="search"
              value={playerSearch}
              placeholder="Search by nickname"
              onChange={(event) => setPlayerSearch(event.currentTarget.value)}
            />
          </label>
          <label className="host-player-field">
            <span>Host</span>
            <select
              aria-label="Host player"
              value={hostPlayerId}
              onChange={(event) => setHostPlayerId(event.currentTarget.value)}
            >
              <option value="">Choose the host</option>
              {(hostPlayerId === "" || matchingPlayers.some(({ id }) => id === hostPlayerId)
                ? matchingPlayers
                : [
                    selectablePlayers.find(({ id }) => id === hostPlayerId),
                    ...matchingPlayers,
                  ].filter((player): player is PlayerProfile => player !== undefined)
              ).map((player) => (
                <option
                  key={player.id}
                  value={player.id}
                  disabled={selectedPlayerIds.includes(player.id)}
                >
                  {player.nickname}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={
              hostPlayerId === ""
                ? selectablePlayers.length < 11
                : selectablePlayers.filter(({ id }) => id !== hostPlayerId).length < 10
            }
            onClick={() => {
              const eligiblePlayers = selectablePlayers.filter(({ id }) => id !== hostPlayerId);
              setSelectedPlayerIds(
                shuffled(eligiblePlayers)
                  .slice(0, 10)
                  .map(({ id }) => id),
              );
              setPlayerSearch("");
              setSetup(null);
            }}
          >
            Randomly fill 10 seats
          </button>
          <div className="player-input-grid">
            {selectedPlayerIds.map((playerId, index) => {
              const selectedPlayer = selectablePlayers.find(({ id }) => id === playerId);
              const choices =
                selectedPlayer === undefined || matchingPlayers.some(({ id }) => id === playerId)
                  ? matchingPlayers
                  : [selectedPlayer, ...matchingPlayers];
              return (
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
                    {choices.map((player) => (
                      <option
                        key={player.id}
                        value={player.id}
                        disabled={
                          selectedPlayerIds.some(
                            (selectedId, selectedIndex) =>
                              selectedIndex !== index && selectedId === player.id,
                          ) || player.id === hostPlayerId
                        }
                      >
                        {player.nickname}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
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
            hostName={selectablePlayers.find(({ id }) => id === hostPlayerId)?.nickname ?? "Host"}
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

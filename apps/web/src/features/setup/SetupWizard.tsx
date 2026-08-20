import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
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
  readonly musicSource: "youtube" | "local";
  readonly onMusicSourceChange: (source: "youtube" | "local") => void;
  readonly volumePresets?: readonly [number, number];
  readonly onVolumePresetsChange?: (presets: readonly [number, number]) => void;
  readonly onStartMusic: () => void;
  readonly onQuickStopMusic: () => void;
  readonly onSlowStopMusic: () => void;
  readonly onComplete: (game: GameState, hostPlayerId: string, hostName: string) => void;
  readonly onEvent?: (type: string, payload: Record<string, unknown>) => void;
  readonly initialSessionState?: SetupWizardSessionState | null;
  readonly onSessionStateChange?: (state: SetupWizardSessionState) => void;
  readonly showDevelopmentTools?: boolean;
  readonly onPopulateDevelopmentPlayers?: () => Promise<readonly PlayerProfile[]>;
  readonly randomFillRequest?: number;
  readonly privacyHidden?: boolean;
  readonly fullscreenTouchPicker?: boolean;
}

type WizardStep = "players" | "music" | "roles";

export interface SetupWizardSessionState {
  readonly step: WizardStep | "roles";
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

interface PlayerComboboxProps {
  readonly id: string;
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly players: readonly PlayerProfile[];
  readonly unavailablePlayerIds: readonly string[];
  readonly onChange: (playerId: string) => void;
  readonly fullscreenTouchPicker: boolean;
}

const PlayerCombobox = ({
  id,
  label,
  placeholder,
  value,
  players,
  unavailablePlayerIds,
  onChange,
  fullscreenTouchPicker,
}: PlayerComboboxProps) => {
  const selectedPlayer = players.find((player) => player.id === value);
  const [query, setQuery] = useState(selectedPlayer?.nickname ?? "");
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const normalizedQuery = fullscreenTouchPicker && open ? "" : query.trim().toLocaleLowerCase();
  const unavailable = new Set(unavailablePlayerIds);
  const matchingPlayers = players.filter(
    (player) =>
      (player.id === value || !unavailable.has(player.id)) &&
      (normalizedQuery.length === 0 ||
        player.nickname.toLocaleLowerCase().includes(normalizedQuery)),
  );
  const listboxId = `${id}-suggestions`;

  useEffect(() => {
    if (!open) setQuery(selectedPlayer?.nickname ?? "");
  }, [open, selectedPlayer?.nickname]);

  const choosePlayer = (player: PlayerProfile) => {
    onChange(player.id);
    setQuery(player.nickname);
    setOpen(false);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setHighlightedIndex((current) => {
        const offset = event.key === "ArrowDown" ? 1 : -1;
        return (current + offset + matchingPlayers.length) % Math.max(matchingPlayers.length, 1);
      });
    } else if (event.key === "Enter" && open && matchingPlayers[highlightedIndex] !== undefined) {
      event.preventDefault();
      choosePlayer(matchingPlayers[highlightedIndex]!);
    } else if (event.key === "Escape") {
      setOpen(false);
      setQuery(selectedPlayer?.nickname ?? "");
    }
  };

  return (
    <div
      className="player-combobox"
      tabIndex={fullscreenTouchPicker ? 0 : undefined}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setOpen(false);
        setQuery(selectedPlayer?.nickname ?? "");
      }}
    >
      <label htmlFor={id}>{label}</label>
      <div className="player-combobox-control">
        <input
          id={id}
          type="search"
          role="combobox"
          aria-label={`${label} player`}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={open}
          aria-activedescendant={
            open && matchingPlayers[highlightedIndex] !== undefined
              ? `${id}-option-${matchingPlayers[highlightedIndex]!.id}`
              : undefined
          }
          autoComplete="off"
          inputMode={fullscreenTouchPicker ? "none" : "search"}
          readOnly={fullscreenTouchPicker}
          tabIndex={fullscreenTouchPicker ? -1 : undefined}
          value={query}
          placeholder={placeholder}
          onFocus={(event) => {
            event.currentTarget.select();
            setHighlightedIndex(0);
            setOpen(true);
          }}
          onPointerDown={(event) => {
            if (!fullscreenTouchPicker) return;
            event.preventDefault();
            event.currentTarget.closest<HTMLElement>(".player-combobox")?.focus();
            setHighlightedIndex(0);
            setOpen(true);
          }}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setHighlightedIndex(0);
            setOpen(true);
            if (value !== "") onChange("");
          }}
          onKeyDown={handleKeyDown}
        />
        <span className="player-combobox-chevron" aria-hidden="true">
          ⌄
        </span>
      </div>
      {open ? (
        <div
          id={listboxId}
          className="player-combobox-list"
          role="listbox"
          aria-label={`${label} suggestions`}
        >
          {matchingPlayers.length === 0 ? (
            <p>No matching players</p>
          ) : (
            matchingPlayers.map((player) => (
              <button
                id={`${id}-option-${player.id}`}
                key={player.id}
                type="button"
                role="option"
                aria-selected={player.id === value}
                className={
                  player.id === matchingPlayers[highlightedIndex]?.id ? "is-highlighted" : ""
                }
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choosePlayer(player)}
              >
                {player.nickname}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
};

export const SetupWizard = ({
  players: availablePlayers,
  musicPlaying,
  musicStatus,
  playlistId,
  onPlaylistIdChange,
  musicSource,
  onMusicSourceChange,
  volumePresets = [50, 80],
  onVolumePresetsChange = () => undefined,
  onComplete,
  onEvent = () => undefined,
  initialSessionState = null,
  onSessionStateChange,
  showDevelopmentTools = false,
  onPopulateDevelopmentPlayers,
  randomFillRequest = 0,
  privacyHidden = false,
  fullscreenTouchPicker = false,
}: SetupWizardProps) => {
  const [step, setStep] = useState<WizardStep>(
    initialSessionState?.step === "roles" && initialSessionState.setup?.step !== "role-draw"
      ? "players"
      : (initialSessionState?.step ?? "players"),
  );
  const [selectedPlayerIds, setSelectedPlayerIds] = useState(() =>
    initialSessionState?.selectedPlayerIds.length === 10
      ? [...initialSessionState.selectedPlayerIds]
      : Array.from({ length: 10 }, () => ""),
  );
  const [hostPlayerId, setHostPlayerId] = useState(initialSessionState?.hostPlayerId ?? "");
  const [setup, setSetup] = useState<SetupState | null>(initialSessionState?.setup ?? null);
  const [developmentPlayers, setDevelopmentPlayers] = useState<readonly PlayerProfile[]>([]);
  const [populatingPlayers, setPopulatingPlayers] = useState(false);
  const [developmentError, setDevelopmentError] = useState(false);
  const handledRandomFillRequest = useRef(randomFillRequest);

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

  const publishSessionState = (nextStep: WizardStep, nextSetup: SetupState | null) => {
    onSessionStateChange?.({
      step: nextStep,
      hostPlayerId,
      selectedPlayerIds,
      setup: nextSetup,
    });
  };

  const randomlyFillSeats = useCallback(() => {
    const eligiblePlayers = selectablePlayers.filter(({ id }) => id !== hostPlayerId);
    if ((hostPlayerId === "" && selectablePlayers.length < 11) || eligiblePlayers.length < 10)
      return;
    setSelectedPlayerIds(
      shuffled(eligiblePlayers)
        .slice(0, 10)
        .map(({ id }) => id),
    );
    setSetup(null);
  }, [hostPlayerId, selectablePlayers]);

  useEffect(() => {
    if (handledRandomFillRequest.current === randomFillRequest) return;
    handledRandomFillRequest.current = randomFillRequest;
    if (step === "players") randomlyFillSeats();
  }, [randomFillRequest, randomlyFillSeats, step]);

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

  const startRoleDraw = () => {
    if (!playersReady || hostPlayer === undefined) return;
    if (step === "players") {
      onEvent("setup.players-selected", {
        hostPlayerId,
        players: players.map(({ id, name, seat }) => ({ id, name, seat })),
      });
    }
    const nextSetup = beginRoleDraw(setup ?? createSetup(players), Math.random);
    setSetup(nextSetup);
    setStep("roles");
    publishSessionState("roles", nextSetup);
    onEvent("setup.role-draw-started", {});
  };

  const drawRole = (seat: number) => {
    if (setup === null || setup.assignments[seat] !== undefined) return;
    const nextSetup = drawRoleForSeat(setup, seat);
    setSetup(nextSetup);
    publishSessionState("roles", nextSetup);
    onEvent("setup.role-drawn", {
      seat,
      role: nextSetup.assignments[seat],
      secret: true,
    });
  };

  const finishRoleDraw = () => {
    if (setup === null || hostPlayer === undefined) return;
    const game = createGame(completeRoleDraw(setup));
    onEvent("setup.completed", { phase: game.phase });
    onComplete(game, hostPlayerId, hostPlayer.nickname);
  };

  if (step === "roles" && setup !== null) {
    return (
      <main className="game-shell role-draw-screen">
        <header className="game-header">
          <div>
            <p className="eyebrow">First game stage · Host view</p>
            <h1>Role giveaway</h1>
          </div>
          <div className="phase-banner">Draw roles · {setup.remainingRoles.length} remaining</div>
        </header>
        <div className="live-layout">
          <section className="table-workspace">
            <GameTable
              hostName={hostPlayer?.nickname ?? "Host"}
              privacyHidden={privacyHidden}
              seats={setup.players.map((player) => ({
                seat: player.seat,
                name: player.name,
                role: setup.assignments[player.seat],
              }))}
              seatActionLabel={(seat) =>
                seat.role === undefined
                  ? `Draw role for ${seat.name}`
                  : `${seat.name}: ${seat.role}`
              }
              onSeatClick={drawRole}
              center={
                setup.remainingRoles.length === 0 ? (
                  <button type="button" className="table-primary" onClick={finishRoleDraw}>
                    Begin Mafia negotiation
                  </button>
                ) : (
                  <span className="table-prompt">Tap a player to reveal their role</span>
                )
              }
            />
          </section>
        </div>
      </main>
    );
  }

  return (
    <main
      className={`setup-shell${
        step === "players" ? " is-player-setup" : step === "music" ? " is-music-setup" : ""
      }`}
    >
      {step === "players" ? (
        <section className="wizard-card player-setup-card">
          <p className="eyebrow">Game setup</p>
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
          <PlayerCombobox
            id="host-player"
            label="Host"
            placeholder="Choose or search the host"
            value={hostPlayerId}
            players={selectablePlayers}
            unavailablePlayerIds={selectedPlayerIds.filter(Boolean)}
            onChange={setHostPlayerId}
            fullscreenTouchPicker={fullscreenTouchPicker}
          />
          <div className="player-input-grid">
            {selectedPlayerIds.map((playerId, index) => (
              <PlayerCombobox
                id={`seat-${index + 1}-player`}
                key={index}
                label={`Seat ${index + 1}`}
                placeholder="Choose or search a nickname"
                value={playerId}
                players={selectablePlayers}
                unavailablePlayerIds={[
                  hostPlayerId,
                  ...selectedPlayerIds.filter(
                    (selectedId, selectedIndex) => selectedIndex !== index && selectedId !== "",
                  ),
                ].filter(Boolean)}
                onChange={(nextPlayerId) => {
                  const next = [...selectedPlayerIds];
                  next[index] = nextPlayerId;
                  setSelectedPlayerIds(next);
                }}
                fullscreenTouchPicker={fullscreenTouchPicker}
              />
            ))}
          </div>
          <div className="setup-completion-actions">
            <button
              className="primary-action"
              type="button"
              disabled={!playersReady}
              onClick={startRoleDraw}
            >
              Start game
            </button>
            <button type="button" disabled={!playersReady} onClick={continueToMusic}>
              Set up music · Optional
            </button>
          </div>
        </section>
      ) : null}

      {step === "music" ? (
        <section className="wizard-card music-step">
          <p className="eyebrow">Game setup</p>
          <h1>Table music · Optional</h1>
          <p className="lead">Start table music now, or begin the game without playback.</p>
          <div className={`music-status ${musicPlaying ? "is-playing" : ""}`}>
            <span className="status-dot" />
            <strong>{musicStatus}</strong>
          </div>
          <fieldset className="volume-mode-setup">
            <legend>Volume modes</legend>
            {volumePresets.map((volume, index) => (
              <label key={index}>
                <span>{index === 0 ? "Low" : "High"}</span>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={volume}
                  onChange={(event) => {
                    const nextValue = Math.min(100, Math.max(1, Number(event.target.value) || 1));
                    onVolumePresetsChange(
                      index === 0 ? [nextValue, volumePresets[1]] : [volumePresets[0], nextValue],
                    );
                  }}
                />
              </label>
            ))}
          </fieldset>
          <div className="music-source-picker" aria-label="Music source">
            <button
              type="button"
              aria-pressed={musicSource === "local"}
              onClick={() => onMusicSourceChange("local")}
            >
              Local waveform DJ
            </button>
            <button
              type="button"
              aria-pressed={musicSource === "youtube"}
              onClick={() => onMusicSourceChange("youtube")}
            >
              YouTube Music
            </button>
          </div>
          {musicSource === "youtube" ? (
            <AccountPlaylistPicker
              playlistId={playlistId}
              onPlaylistIdChange={onPlaylistIdChange}
            />
          ) : (
            <p className="local-dj-guidance">
              The player below uses uploaded audio for real oscillograms, start-point seeking, and
              crossfades. Upload at least two tracks, then set the current and next cue points.
            </p>
          )}
          <div className="setup-completion-actions">
            <button
              className="primary-action"
              type="button"
              disabled={!playersReady}
              onClick={startRoleDraw}
            >
              Start game
            </button>
            <button
              type="button"
              onClick={() => {
                setStep("players");
                setSetup(null);
                publishSessionState("players", null);
              }}
            >
              Back to players
            </button>
          </div>
        </section>
      ) : null}
    </main>
  );
};

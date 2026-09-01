import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  assignRoleForSeat,
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createSetup,
  drawRoleForSeat,
  rerollRoleForSeat,
} from "@mafia/game-domain";
import type { GameState, PlayerInput, Role, SetupState } from "@mafia/game-domain";
import type { PlayerProfile } from "../../api/client.js";
import { useMessages } from "../../i18n/I18nProvider.js";
import { gameMessages, type GameMessageKey } from "../../i18n/messages/game.js";
import { reportError } from "../console/error-console.js";
import { GameTable } from "../table/GameTable.js";

interface SetupWizardProps {
  readonly players: readonly PlayerProfile[];
  readonly bestMoveEnabled?: boolean;
  readonly onComplete: (game: GameState, hostPlayerId: string, hostName: string) => void;
  readonly onStartGame?: () => void;
  readonly onEvent?: (type: string, payload: Record<string, unknown>) => void;
  readonly initialSessionState?: SetupWizardSessionState | null;
  readonly onSessionStateChange?: (state: SetupWizardSessionState) => void;
  readonly showDevelopmentTools?: boolean;
  readonly onPopulateDevelopmentPlayers?: () => Promise<readonly PlayerProfile[]>;
  readonly onOpenAvailablePlayers?: () => void;
  readonly privacyHidden?: boolean;
}

type WizardStep = "players" | "roles";

const roleMessageKeys: Record<Role, GameMessageKey> = {
  citizen: "role.citizen",
  don: "role.don",
  mafia: "role.mafia",
  sheriff: "role.sheriff",
};

export interface SetupWizardSessionState {
  /** "music" is retained only to restore snapshots created before music setup moved to Dev. */
  readonly step: WizardStep | "music";
  readonly hostPlayerId?: string;
  readonly selectedPlayerIds: readonly string[];
  readonly setup: SetupState | null;
}

const shuffled = <Value,>(
  values: readonly Value[],
  random: () => number = Math.random,
): Value[] => {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
};

const randomPlayersBySelectionPriority = (
  players: readonly PlayerProfile[],
  random: () => number = Math.random,
): PlayerProfile[] => {
  const ranked = [...players].sort(
    (left, right) =>
      right.statistics.hostedGames - left.statistics.hostedGames ||
      left.statistics.gamesPlayed - right.statistics.gamesPlayed ||
      right.statistics.wins - left.statistics.wins,
  );
  const groups: PlayerProfile[][] = [];
  for (const player of ranked) {
    const previous = groups.at(-1)?.[0];
    if (
      previous === undefined ||
      previous.statistics.hostedGames !== player.statistics.hostedGames ||
      previous.statistics.gamesPlayed !== player.statistics.gamesPlayed ||
      previous.statistics.wins !== player.statistics.wins
    ) {
      groups.push([player]);
    } else {
      groups.at(-1)!.push(player);
    }
  }
  return groups.flatMap((group) => shuffled(group, random));
};

interface PlayerComboboxProps {
  readonly id: string;
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly players: readonly PlayerProfile[];
  readonly unavailablePlayerIds: readonly string[];
  readonly onChange: (playerId: string) => void;
}

const PlayerCombobox = ({
  id,
  label,
  placeholder,
  value,
  players,
  unavailablePlayerIds,
  onChange,
}: PlayerComboboxProps) => {
  const { t } = useMessages(gameMessages);
  const selectedPlayer = players.find((player) => player.id === value);
  const [query, setQuery] = useState(selectedPlayer?.nickname ?? "");
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const normalizedQuery = query.trim().toLocaleLowerCase();
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
          aria-label={`${label} ${t("setup.player")}`}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={open}
          aria-activedescendant={
            open && matchingPlayers[highlightedIndex] !== undefined
              ? `${id}-option-${matchingPlayers[highlightedIndex]!.id}`
              : undefined
          }
          autoComplete="off"
          value={query}
          placeholder={placeholder}
          onFocus={(event) => {
            event.currentTarget.select();
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
        {value === "" ? null : (
          <button
            type="button"
            className="player-combobox-clear"
            aria-label={t("setup.clear", { label })}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={() => {
              onChange("");
              setQuery("");
              setOpen(false);
            }}
          >
            ×
          </button>
        )}
        <span className="player-combobox-chevron" aria-hidden="true">
          <svg viewBox="0 0 16 10">
            <path d="m2 2 6 6 6-6" />
          </svg>
        </span>
      </div>
      {open ? (
        <div
          id={listboxId}
          className="player-combobox-list"
          role="listbox"
          aria-label={t("setup.suggestions", { label })}
        >
          {matchingPlayers.length === 0 ? (
            <p>{t("setup.noMatchingPlayers")}</p>
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
  bestMoveEnabled = true,
  onComplete,
  onStartGame = () => undefined,
  onEvent = () => undefined,
  initialSessionState = null,
  onSessionStateChange,
  showDevelopmentTools = false,
  onPopulateDevelopmentPlayers,
  onOpenAvailablePlayers,
  privacyHidden = false,
}: SetupWizardProps) => {
  const { t } = useMessages(gameMessages);
  const [step, setStep] = useState<WizardStep>(
    initialSessionState?.step === "roles" && initialSessionState.setup?.step !== "role-draw"
      ? "players"
      : initialSessionState?.step === "roles"
        ? "roles"
        : "players",
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
  const [manualRoleSeat, setManualRoleSeat] = useState<number | null>(null);
  const roleTapState = useRef<{ seat: number; count: number; at: number } | null>(null);

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
    const availableIds = new Set(selectablePlayers.map(({ id }) => id));
    const nextHostPlayerId =
      hostPlayerId === "" || availableIds.has(hostPlayerId) ? hostPlayerId : "";
    const nextSelectedPlayerIds = selectedPlayerIds.map((playerId) =>
      playerId === "" || availableIds.has(playerId) ? playerId : "",
    );
    const restoredIds = [nextHostPlayerId, ...nextSelectedPlayerIds];
    const valid =
      restoredIds.length === 11 &&
      restoredIds.every((playerId) => playerId !== "" && availableIds.has(playerId)) &&
      new Set(restoredIds).size === 11;
    const selectionChanged =
      nextHostPlayerId !== hostPlayerId ||
      nextSelectedPlayerIds.some((playerId, index) => playerId !== selectedPlayerIds[index]);
    if (step !== "players" && !valid) setStep("players");
    if (!valid || selectionChanged) {
      if (nextHostPlayerId !== hostPlayerId) setHostPlayerId(nextHostPlayerId);
      if (selectionChanged) setSelectedPlayerIds(nextSelectedPlayerIds);
      setSetup(null);
    }
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
    const selectedPlayers = randomPlayersBySelectionPriority(eligiblePlayers).slice(0, 10);
    setSelectedPlayerIds(shuffled(selectedPlayers).map(({ id }) => id));
    setSetup(null);
  }, [hostPlayerId, selectablePlayers]);

  const startRoleDraw = () => {
    if (!playersReady || hostPlayer === undefined) return;
    onStartGame();
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
    setManualRoleSeat(null);
    const nextSetup = drawRoleForSeat(setup, seat);
    setSetup(nextSetup);
    publishSessionState("roles", nextSetup);
    onEvent("setup.role-drawn", {
      seat,
      role: nextSetup.assignments[seat],
      secret: true,
    });
  };

  const handleRoleCardTap = (seat: number) => {
    if (setup === null) return;
    setManualRoleSeat(null);
    if (setup.assignments[seat] === undefined) {
      roleTapState.current = null;
      drawRole(seat);
      return;
    }
    if (setup.remainingRoles.length === 0) return;
    const now = Date.now();
    const previous = roleTapState.current;
    const count = previous?.seat === seat && now - previous.at <= 800 ? previous.count + 1 : 1;
    roleTapState.current = { seat, count, at: now };
    if (count < 3) return;
    roleTapState.current = null;
    const nextSetup = rerollRoleForSeat(setup, seat, Math.random);
    setSetup(nextSetup);
    publishSessionState("roles", nextSetup);
    onEvent("setup.role-rerolled", {
      seat,
      role: nextSetup.assignments[seat],
      secret: true,
    });
  };

  const selectManualRole = (role: Role) => {
    if (setup === null || manualRoleSeat === null || setup.remainingRoles.length === 0) return;
    const nextSetup = assignRoleForSeat(setup, manualRoleSeat, role);
    setSetup(nextSetup);
    setManualRoleSeat(null);
    publishSessionState("roles", nextSetup);
    onEvent("setup.role-assigned", { seat: manualRoleSeat, role, secret: true });
  };

  const finishRoleDraw = () => {
    if (setup === null || hostPlayer === undefined) return;
    const game = createGame(completeRoleDraw(setup), { bestMoveEnabled });
    onEvent("setup.completed", { phase: game.phase });
    onComplete(game, hostPlayerId, hostPlayer.nickname);
  };

  if (step === "roles" && setup !== null) {
    return (
      <main className="game-shell role-draw-screen">
        <header className="game-header">
          <div>
            <p className="eyebrow">{t("setup.firstStage")}</p>
            <h1>{t("setup.roleDraw")}</h1>
          </div>
          <div className="phase-banner">
            {t("setup.drawRolesRemaining", { count: setup.remainingRoles.length })}
          </div>
        </header>
        <div className="live-layout">
          <section className="table-workspace">
            <GameTable
              hostName={hostPlayer?.nickname ?? t("setup.unknownHost")}
              privacyHidden={privacyHidden}
              seats={setup.players.map((player) => ({
                seat: player.seat,
                name: player.name,
                role: setup.assignments[player.seat],
              }))}
              seatActionLabel={(seat) =>
                seat.role === undefined
                  ? t("setup.drawRole", { name: seat.name })
                  : t(
                      setup.remainingRoles.length > 0
                        ? "setup.roleDrawCardReroll"
                        : "setup.roleDrawCard",
                      { name: seat.name, role: t(roleMessageKeys[seat.role]) },
                    )
              }
              onSeatClick={handleRoleCardTap}
              onSeatSwipe={(seat) => {
                if (setup.remainingRoles.length > 0) setManualRoleSeat(seat);
              }}
              center={
                manualRoleSeat !== null && setup.remainingRoles.length > 0 ? (
                  <div
                    className="manual-role-menu"
                    role="dialog"
                    aria-label={t("setup.chooseRole")}
                  >
                    <span className="table-prompt">
                      {t("setup.chooseRoleForSeat", { seat: manualRoleSeat })}
                    </span>
                    <div>
                      {[...new Set(setup.remainingRoles)].map((role) => (
                        <button
                          type="button"
                          key={role}
                          aria-label={t("setup.assignRole", {
                            role: t(roleMessageKeys[role]),
                            seat: manualRoleSeat,
                          })}
                          onClick={() => selectManualRole(role)}
                        >
                          {t(roleMessageKeys[role])} ×
                          {setup.remainingRoles.filter((candidate) => candidate === role).length}
                        </button>
                      ))}
                    </div>
                    <button type="button" onClick={() => setManualRoleSeat(null)}>
                      {t("setup.cancel")}
                    </button>
                  </div>
                ) : setup.remainingRoles.length === 0 ? (
                  <div className="table-check-center">
                    <span className="table-prompt">{t("setup.roleGiveaway")}</span>
                    <strong>{t("setup.allRolesAssigned")}</strong>
                  </div>
                ) : (
                  <span className="table-prompt">{t("setup.tapRevealRole")}</span>
                )
              }
              advance={
                <button
                  type="button"
                  disabled={setup.remainingRoles.length > 0 || hostPlayer === undefined}
                  onClick={finishRoleDraw}
                >
                  {t("setup.startPlanning")}
                </button>
              }
            />
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className={`setup-shell${step === "players" ? " is-player-setup" : ""}`}>
      {step === "players" ? (
        <section className="wizard-card player-setup-card">
          <p className="eyebrow">{t("setup.gameSetup")}</p>
          <h1>{t("setup.selectPlayers")}</h1>
          <p className="lead">{t("setup.selectPlayersLead")}</p>
          {selectablePlayers.length < 11 ? (
            <p className="player-guidance">{t("setup.playerGuidance")}</p>
          ) : null}
          {showDevelopmentTools && onPopulateDevelopmentPlayers !== undefined ? (
            <div className="development-player-tools">
              <strong>{t("setup.devOnly")}</strong>
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
                    .catch((error: unknown) => {
                      reportError(error, { source: "api", context: "development-players.select" });
                      setDevelopmentError(true);
                    })
                    .finally(() => setPopulatingPlayers(false));
                }}
              >
                {populatingPlayers ? t("setup.devGenerating") : t("setup.devGenerate")}
              </button>
              {developmentError ? <p role="alert">{t("setup.devError")}</p> : null}
            </div>
          ) : null}
          <PlayerCombobox
            id="host-player"
            label={t("setup.host")}
            placeholder={t("setup.searchHost")}
            value={hostPlayerId}
            players={selectablePlayers}
            unavailablePlayerIds={selectedPlayerIds.filter(Boolean)}
            onChange={setHostPlayerId}
          />
          <div className="player-input-grid">
            {selectedPlayerIds.map((playerId, index) => (
              <PlayerCombobox
                id={`seat-${index + 1}-player`}
                key={index}
                label={t("setup.seat", { seat: index + 1 })}
                placeholder={t("setup.searchNickname")}
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
              />
            ))}
          </div>
          <div
            className="player-setup-actions"
            role="group"
            aria-label={t("setup.playerSetupActions")}
          >
            {onOpenAvailablePlayers === undefined ? null : (
              <button type="button" onClick={onOpenAvailablePlayers}>
                {t("setup.selectAvailable")}
              </button>
            )}
            <button
              type="button"
              className="primary-action"
              disabled={selectablePlayers.length < 11}
              onClick={randomlyFillSeats}
            >
              {t("setup.assignPlayers")}
            </button>
            <button
              className="primary-action"
              type="button"
              disabled={!playersReady}
              onClick={startRoleDraw}
            >
              {t("setup.startGame")}
            </button>
          </div>
        </section>
      ) : null}
    </main>
  );
};

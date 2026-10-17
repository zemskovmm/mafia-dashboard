import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  assignRoleForSeat,
  beginRoleDraw,
  CASPER_NAME,
  CASPER_PLAYER_ID,
  CASPER_SEAT,
  clearRoleForSeat,
  completeRoleDraw,
  createGame,
  createSetup,
  drawRoleForSeat,
  isCasperPlayer,
  rerollRoleForSeat,
} from "@mafia/game-domain";
import type { GameState, PlayerInput, Role, SetupState } from "@mafia/game-domain";
import type { PlayerProfile } from "../../api/client.js";
import { useMessages } from "../../i18n/I18nProvider.js";
import { gameMessages, type GameMessageKey } from "../../i18n/messages/game.js";
import { setupMessages } from "../../i18n/messages/setup.js";
import "./SetupWizard.css";
import { reportError } from "../console/error-console.js";
import { GameTable } from "../table/GameTable.js";
import { LiquidCardGlass } from "../theme/LiquidCardGlass.js";

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
  readonly onRoleDrawBackActionChange?: (action: (() => void) | null) => void;
  /** Creation is in flight; role changes must not outrun the server GUID. */
  readonly persistencePending?: boolean;
  readonly playersLoading?: boolean;
  /** Separate game metadata; never part of the canonical setup/game snapshot. */
  readonly tournamentControl?: ReactNode;
  readonly tournamentValid?: boolean;
  readonly tournamentSelected?: boolean;
}

type WizardStep = "players" | "roles";

export type SetupClubDeviation = "casper" | "best-move-disabled" | "role-reroll";

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
  readonly bestMoveEnabled?: boolean;
  readonly clubDeviationsAcknowledged?: readonly SetupClubDeviation[];
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

const roleDrawMatchesPlayers = (setup: SetupState, players: readonly PlayerInput[]) =>
  setup.step === "role-draw" &&
  setup.players.length === players.length &&
  setup.players.every(
    (player, index) => player.id === players[index]?.id && player.seat === players[index]?.seat,
  );

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
          autoComplete="off"
          value={query}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setOpen(true);
          }}
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
  onRoleDrawBackActionChange,
  persistencePending = false,
  playersLoading = false,
  tournamentControl,
  tournamentValid = true,
}: SetupWizardProps) => {
  const { t } = useMessages(gameMessages);
  const { t: setupT } = useMessages(setupMessages);
  const gameBestMoveEnabled = initialSessionState?.bestMoveEnabled ?? bestMoveEnabled;
  // Retain historical metadata without creating or requiring acknowledgements.
  const acknowledgedDeviations = initialSessionState?.clubDeviationsAcknowledged;

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
  const includeCasper = selectedPlayerIds[CASPER_SEAT - 1] === CASPER_PLAYER_ID;
  const humanSeatCount = includeCasper ? 9 : 10;

  const sessionOptions = useMemo(
    () => ({
      bestMoveEnabled: gameBestMoveEnabled,
      ...(acknowledgedDeviations !== undefined
        ? { clubDeviationsAcknowledged: acknowledgedDeviations }
        : {}),
    }),
    [acknowledgedDeviations, gameBestMoveEnabled],
  );

  const [hostPlayerId, setHostPlayerId] = useState(initialSessionState?.hostPlayerId ?? "");
  const [setup, setSetup] = useState<SetupState | null>(initialSessionState?.setup ?? null);
  const [developmentPlayers, setDevelopmentPlayers] = useState<readonly PlayerProfile[]>([]);
  const [populatingPlayers, setPopulatingPlayers] = useState(false);
  const [developmentError, setDevelopmentError] = useState(false);
  const [manualRoleSeat, setManualRoleSeat] = useState<number | null>(null);
  const roleTapState = useRef<{ seat: number; count: number; at: number } | null>(null);
  const seatGridRef = useRef<HTMLDivElement>(null);
  const seatDragRef = useRef<{
    pointerId: number;
    source: number;
    selection: readonly string[];
    host: string;
  } | null>(null);
  const [seatDrag, setSeatDrag] = useState<{ source: number; target: number | null } | null>(null);

  const discardDeal = useCallback(() => {
    setSetup(null);
    setManualRoleSeat(null);
    roleTapState.current = null;
  }, []);

  const cancelSeatDrag = () => {
    seatDragRef.current = null;
    setSeatDrag(null);
  };

  useEffect(() => {
    cancelSeatDrag();
  }, [selectedPlayerIds, hostPlayerId, step, playersLoading]);

  const seatAtPointer = (event: ReactPointerEvent<HTMLElement>) => {
    const card = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-setup-seat]");
    if (!card || !seatGridRef.current?.contains(card)) return null;
    const index = Number(card.dataset.setupSeat) - 1;
    return Number.isInteger(index) &&
      index >= 0 &&
      index < 10 &&
      selectedPlayerIds[index] !== CASPER_PLAYER_ID
      ? index
      : null;
  };

  const beginSeatDrag = (event: ReactPointerEvent<HTMLElement>, source: number) => {
    if (
      !event.isPrimary ||
      event.button !== 0 ||
      seatDragRef.current ||
      playersLoading ||
      !selectedPlayerIds[source] ||
      selectedPlayerIds[source] === CASPER_PLAYER_ID
    )
      return;
    event.preventDefault();
    seatDragRef.current = {
      pointerId: event.pointerId,
      source,
      selection: selectedPlayerIds,
      host: hostPlayerId,
    };
    setSeatDrag({ source, target: null });
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const moveSeatDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = seatDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const scroller = seatGridRef.current?.closest<HTMLElement>(".player-setup-card");
    if (scroller && scroller.scrollHeight > scroller.clientHeight) {
      const bounds = scroller.getBoundingClientRect();
      if (event.clientY < bounds.top + 40) scroller.scrollTop -= 16;
      else if (event.clientY > bounds.bottom - 40) scroller.scrollTop += 16;
    }
    const target = seatAtPointer(event);
    setSeatDrag({ source: drag.source, target: target === drag.source ? null : target });
  };

  const finishSeatDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = seatDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const target = seatAtPointer(event);
    cancelSeatDrag();
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (
      target === null ||
      target === drag.source ||
      drag.selection !== selectedPlayerIds ||
      drag.host !== hostPlayerId ||
      step !== "players" ||
      playersLoading
    )
      return;
    const next = [...selectedPlayerIds];
    [next[drag.source], next[target]] = [next[target]!, next[drag.source]!];
    setSelectedPlayerIds(next);
    discardDeal();
  };

  const selectablePlayers = useMemo(
    () => [
      ...availablePlayers.filter((player) => !isCasperPlayer(player)),
      ...developmentPlayers.filter(
        (player) =>
          !isCasperPlayer(player) &&
          !availablePlayers.some((available) => available.id === player.id),
      ),
    ],
    [availablePlayers, developmentPlayers],
  );

  useEffect(() => {
    onSessionStateChange?.({ step, hostPlayerId, selectedPlayerIds, setup, ...sessionOptions });
  }, [hostPlayerId, onSessionStateChange, selectedPlayerIds, setup, step, sessionOptions]);

  useEffect(() => {
    if (playersLoading) return;
    const availableIds = new Set(selectablePlayers.map(({ id }) => id));
    const nextHostPlayerId =
      hostPlayerId === "" || availableIds.has(hostPlayerId) ? hostPlayerId : "";
    const nextSelectedPlayerIds = selectedPlayerIds.map((playerId, index) =>
      playerId === "" ||
      availableIds.has(playerId) ||
      (playerId === CASPER_PLAYER_ID && index === CASPER_SEAT - 1)
        ? playerId
        : "",
    );
    const restoredIds = [nextHostPlayerId, ...nextSelectedPlayerIds];
    const valid =
      restoredIds.length === 11 &&
      restoredIds.every((playerId) => playerId !== "") &&
      new Set(restoredIds).size === 11;
    const selectionChanged =
      nextHostPlayerId !== hostPlayerId ||
      nextSelectedPlayerIds.some((playerId, index) => playerId !== selectedPlayerIds[index]);
    if (step !== "players" && !valid) setStep("players");
    if (!valid || selectionChanged) {
      if (nextHostPlayerId !== hostPlayerId) setHostPlayerId(nextHostPlayerId);
      if (selectionChanged) setSelectedPlayerIds(nextSelectedPlayerIds);
      discardDeal();
    }
  }, [discardDeal, hostPlayerId, playersLoading, selectablePlayers, selectedPlayerIds, step]);

  const players = useMemo<PlayerInput[]>(
    () =>
      selectedPlayerIds.flatMap((playerId, index) => {
        if (playerId === CASPER_PLAYER_ID && index === CASPER_SEAT - 1) {
          return [{ id: CASPER_PLAYER_ID, seat: CASPER_SEAT }];
        }
        const player = selectablePlayers.find(({ id }) => id === playerId);
        return player === undefined ? [] : [{ id: player.id, seat: index + 1 }];
      }),
    [selectablePlayers, selectedPlayerIds],
  );
  const hostPlayer = selectablePlayers.find(({ id }) => id === hostPlayerId);
  const playersReady =
    !playersLoading &&
    hostPlayer !== undefined &&
    players.length === 10 &&
    new Set([hostPlayerId, ...selectedPlayerIds.filter(Boolean)]).size === 11;

  const publishSessionState = useCallback(
    (nextStep: WizardStep, nextSetup: SetupState | null) => {
      onSessionStateChange?.({
        step: nextStep,
        hostPlayerId,
        selectedPlayerIds,
        setup: nextSetup,
        ...sessionOptions,
      });
    },
    [hostPlayerId, onSessionStateChange, selectedPlayerIds, sessionOptions],
  );

  const changeHostPlayer = (nextPlayerId: string) => {
    if (nextPlayerId === hostPlayerId) return;
    setHostPlayerId(nextPlayerId);
    discardDeal();
  };

  const changeSeatPlayer = (index: number, nextPlayerId: string) => {
    if (nextPlayerId === selectedPlayerIds[index]) return;
    const next = [...selectedPlayerIds];
    next[index] = nextPlayerId;
    setSelectedPlayerIds(next);
    discardDeal();
  };

  const randomlyFillSeats = useCallback(() => {
    const eligiblePlayers = selectablePlayers.filter(({ id }) => id !== hostPlayerId);
    if (
      (hostPlayerId === "" && selectablePlayers.length < humanSeatCount + 1) ||
      eligiblePlayers.length < humanSeatCount
    )
      return;
    const selectedPlayers = randomPlayersBySelectionPriority(eligiblePlayers).slice(
      0,
      humanSeatCount,
    );
    setSelectedPlayerIds([
      ...shuffled(selectedPlayers).map(({ id }) => id),
      ...(includeCasper ? [CASPER_PLAYER_ID] : []),
    ]);
    discardDeal();
  }, [discardDeal, hostPlayerId, humanSeatCount, includeCasper, selectablePlayers]);

  const startRoleDraw = () => {
    if (!playersReady || hostPlayer === undefined || !tournamentValid || persistencePending) return;
    const resumeRoleDraw = setup !== null && roleDrawMatchesPlayers(setup, players);
    const nextSetup = resumeRoleDraw
      ? { ...setup, players }
      : beginRoleDraw(createSetup(players), Math.random);
    if (!resumeRoleDraw) {
      onStartGame();
      onEvent("setup.players-selected", {
        hostPlayerId,
        players: players.map(({ id, seat }) => ({ id, seat })),
      });
      onEvent("setup.role-draw-started", {});
    }
    setSetup(nextSetup);
    setStep("roles");
    publishSessionState("roles", nextSetup);
  };

  const drawRole = (seat: number) => {
    if (persistencePending) return;
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
    if (persistencePending) return;
    if (includeCasper && seat === CASPER_SEAT) return;
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
    if (persistencePending) return;
    if (includeCasper && manualRoleSeat === CASPER_SEAT) return;
    if (setup === null || manualRoleSeat === null || setup.remainingRoles.length === 0) return;
    const nextSetup = assignRoleForSeat(setup, manualRoleSeat, role);
    setSetup(nextSetup);
    setManualRoleSeat(null);
    roleTapState.current = null;
    publishSessionState("roles", nextSetup);
    onEvent("setup.role-assigned", { seat: manualRoleSeat, role, secret: true });
  };

  const clearManualRole = () => {
    if (persistencePending || setup === null || manualRoleSeat === null) return;
    if (includeCasper && manualRoleSeat === CASPER_SEAT) return;
    const role = setup.assignments[manualRoleSeat];
    if (role === undefined) return;
    const nextSetup = clearRoleForSeat(setup, manualRoleSeat);
    setSetup(nextSetup);
    setManualRoleSeat(null);
    roleTapState.current = null;
    publishSessionState("roles", nextSetup);
    onEvent("setup.role-cleared", { seat: manualRoleSeat, role, secret: true });
  };

  const finishRoleDraw = () => {
    if (persistencePending) return;
    if (setup === null || hostPlayer === undefined) return;
    const game = createGame(completeRoleDraw(setup), { bestMoveEnabled: gameBestMoveEnabled });
    onEvent("setup.completed", {
      phase: game.phase,
    });
    onComplete(game, hostPlayerId, hostPlayer.nickname);
  };

  const returnToPlayerSelection = useCallback(() => {
    setManualRoleSeat(null);
    roleTapState.current = null;
    setStep("players");
    publishSessionState("players", setup);
  }, [publishSessionState, setup]);

  useEffect(() => {
    if (step !== "roles" || setup === null) {
      onRoleDrawBackActionChange?.(null);
      return;
    }
    onRoleDrawBackActionChange?.(returnToPlayerSelection);
    return () => onRoleDrawBackActionChange?.(null);
  }, [onRoleDrawBackActionChange, returnToPlayerSelection, setup, step]);

  if (step === "roles" && setup !== null) {
    return (
      <main className="game-shell role-draw-screen">
        <header className="game-header">
          <div className="role-draw-heading">
            <button type="button" className="role-draw-back" onClick={returnToPlayerSelection}>
              <span aria-hidden="true">←</span> {t("setup.playerSetup")}
            </button>
            <div>
              <p className="eyebrow">{t("setup.firstStage")}</p>
              <h1>{t("setup.roleDraw")}</h1>
            </div>
          </div>
        </header>
        <div className="live-layout">
          <section className="table-workspace">
            <GameTable
              hostName={hostPlayer?.nickname ?? t("setup.unknownHost")}
              seats={setup.players.map((player) => ({
                seat: player.seat,
                name:
                  player.id === CASPER_PLAYER_ID
                    ? CASPER_NAME
                    : (selectablePlayers.find(({ id }) => id === player.id)?.nickname ??
                      t("player.anonymous")),
                role: setup.assignments[player.seat],
              }))}
              seatActionLabel={(seat) =>
                seat.role === undefined
                  ? t("setup.drawRole", { name: seat.name })
                  : t(
                      setup.remainingRoles.length > 0 &&
                        !(includeCasper && seat.seat === CASPER_SEAT)
                        ? "setup.roleDrawCardReroll"
                        : "setup.roleDrawCard",
                      { name: seat.name, role: t(roleMessageKeys[seat.role]) },
                    )
              }
              onSeatClick={handleRoleCardTap}
              seatActionDisabled={(seat) =>
                persistencePending || (includeCasper && seat.seat === CASPER_SEAT)
              }
              onSeatSwipe={(seat) => {
                if (persistencePending || (includeCasper && seat === CASPER_SEAT)) return;
                roleTapState.current = null;
                setManualRoleSeat((current) => (current === seat ? null : seat));
              }}
              center={
                manualRoleSeat !== null ? (
                  <div
                    className="manual-role-menu"
                    role="dialog"
                    aria-label={t("setup.chooseRole")}
                    data-context-action
                  >
                    <span className="table-prompt">
                      {t("setup.chooseRoleForSeat", { seat: manualRoleSeat })}
                    </span>
                    {setup.assignments[manualRoleSeat] === undefined ? null : (
                      <button
                        type="button"
                        aria-label={setupT("setup.clearRoleForSeat", { seat: manualRoleSeat })}
                        disabled={persistencePending}
                        onClick={clearManualRole}
                      >
                        {setupT("setup.clearRole")}
                      </button>
                    )}
                    <div>
                      {[...new Set(setup.remainingRoles)].map((role) => (
                        <button
                          type="button"
                          key={role}
                          disabled={persistencePending}
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
                  <div className="table-check-center">
                    <span className="table-prompt">{t("setup.tapRevealRole")}</span>
                    <strong>
                      {t("setup.drawRolesRemaining", { count: setup.remainingRoles.length })}
                    </strong>
                  </div>
                )
              }
              advance={
                <button
                  type="button"
                  disabled={
                    persistencePending ||
                    manualRoleSeat !== null ||
                    setup.remainingRoles.length > 0 ||
                    hostPlayer === undefined
                  }
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
          <header className="player-setup-heading">
            <h1>{t("setup.selectPlayers")}</h1>
            <label className="casper-toggle">
              <span>{t("setup.includeCasper")}</span>
              <input
                type="checkbox"
                role="switch"
                checked={includeCasper}
                onChange={(event) =>
                  changeSeatPlayer(
                    CASPER_SEAT - 1,
                    event.currentTarget.checked ? CASPER_PLAYER_ID : "",
                  )
                }
              />
              <span className="casper-switch-track" aria-hidden="true" />
            </label>
          </header>
          {tournamentControl}
          {selectablePlayers.length < humanSeatCount + 1 ? (
            <p className="player-guidance">
              {t("setup.playerGuidance", { count: humanSeatCount + 1 })}
            </p>
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
                      setSelectedPlayerIds((current) =>
                        selected
                          .slice(1)
                          .map(({ id }, index) =>
                            index === CASPER_SEAT - 1 && current[index] === CASPER_PLAYER_ID
                              ? CASPER_PLAYER_ID
                              : id,
                          ),
                      );
                      discardDeal();
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
            onChange={changeHostPlayer}
          />
          <p className="setup-seat-hint">{t("setup.seatHint")}</p>
          <div className="player-input-grid" ref={seatGridRef}>
            {selectedPlayerIds.map((playerId, index) => (
              <div
                key={index}
                data-setup-seat={index + 1}
                data-player-glass="setup"
                className={`setup-seat-card${seatDrag?.source === index ? " is-dragging" : ""}${seatDrag?.target === index ? " is-drop-target" : ""}`}
              >
                <LiquidCardGlass />
                <span className="setup-seat-number" aria-hidden="true">
                  {index + 1}
                </span>
                {includeCasper && index === CASPER_SEAT - 1 ? (
                  <div className="player-combobox">
                    <label htmlFor="casper-player">{t("setup.seat", { seat: CASPER_SEAT })}</label>
                    <input
                      id="casper-player"
                      aria-label={`${t("setup.seat", { seat: CASPER_SEAT })} ${t("setup.player")}`}
                      value={CASPER_NAME}
                      readOnly
                    />
                  </div>
                ) : (
                  <PlayerCombobox
                    id={`seat-${index + 1}-player`}
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
                    onChange={(nextPlayerId) => changeSeatPlayer(index, nextPlayerId)}
                  />
                )}
                <span
                  className="setup-seat-drag-handle"
                  aria-label={t("setup.moveSeat", { seat: index + 1 })}
                  aria-disabled={playersLoading || !playerId || playerId === CASPER_PLAYER_ID}
                  onPointerDown={(event) => beginSeatDrag(event, index)}
                  onPointerMove={moveSeatDrag}
                  onPointerUp={finishSeatDrag}
                  onPointerCancel={(event) => {
                    if (event.pointerId === seatDragRef.current?.pointerId) cancelSeatDrag();
                  }}
                  onLostPointerCapture={(event) => {
                    if (event.pointerId === seatDragRef.current?.pointerId) cancelSeatDrag();
                  }}
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24">
                    <circle cx="8" cy="6" r="1.5" />
                    <circle cx="16" cy="6" r="1.5" />
                    <circle cx="8" cy="12" r="1.5" />
                    <circle cx="16" cy="12" r="1.5" />
                    <circle cx="8" cy="18" r="1.5" />
                    <circle cx="16" cy="18" r="1.5" />
                  </svg>
                </span>
                {seatDrag?.target === index ? (
                  <span className="setup-seat-drop-label">{t("setup.dropToSwap")}</span>
                ) : null}
              </div>
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
              disabled={selectablePlayers.length < humanSeatCount + 1}
              onClick={randomlyFillSeats}
            >
              {t("setup.assignPlayers")}
            </button>
            <button
              className="primary-action"
              type="button"
              disabled={!playersReady || !tournamentValid || persistencePending}
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

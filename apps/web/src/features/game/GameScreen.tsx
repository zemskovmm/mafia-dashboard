import { useState } from "react";
import {
  advanceOpeningPhase,
  completeEliminations,
  completeGoodbyeSpeech,
  completeCurrentTurn,
  getActiveNominations,
  getCurrentTurnDuration,
  isVotingRequired,
  issueFoul,
  setNominationSelection,
} from "@mafia/game-domain";
import type { CanonicalGameEventDraft, GameState } from "@mafia/game-domain";
import { useMessages, type FeatureI18n } from "../../i18n/I18nProvider.js";
import { gameMessages, type GameMessageKey } from "../../i18n/messages/game.js";
import {
  FederationDisciplineControls,
  type DisciplineRequest,
} from "./FederationDisciplineControls.js";
import { hasImmediateRemovalAnnouncement } from "./federation-ui-state.js";
import { FederationBestMoveStage } from "./FederationBestMoveStage.js";
import { RulesBookHost } from "../rules/RulesBookHost.js";
import type { RuleReferenceId } from "../rules/rule-references.js";
import { NightStage } from "../night/NightStage.js";
import { usePlayerDisplayName } from "../players/player-display.js";
import { GameTable } from "../table/GameTable.js";
import { isCriticalState } from "./critical-state.js";
import { isGuessingState } from "./guessing-state.js";
import { VotingStage } from "../voting/VotingStage.js";
import { PlayerExitProvider } from "./PlayerExitProvider.js";
import {
  DEFAULT_PLAYER_EXIT_SETTINGS,
  type PlayerExitSettings,
} from "../effects/player-exit-preferences.js";

interface GameScreenProps {
  readonly game: GameState;
  readonly playerExitSettings?: PlayerExitSettings;
  readonly gameName?: string;
  readonly hostName: string;
  readonly onGameChange: (game: GameState) => void;
  readonly onEvent: (type: string, payload: Record<string, unknown>) => void;
  readonly onAcceptedEvent?: (event: CanonicalGameEventDraft) => GameState | void;
  readonly mode?: "live" | "preview";
  readonly previewSequence?: number;
  readonly onExitPreview?: () => void;
  readonly onResetPreview?: () => void;
  readonly canResetPreview?: boolean;
  readonly privacyHidden: boolean;
  readonly rulesOpen?: boolean;
  readonly onRulesClose?: () => void;
  readonly onFinishGame?: () => void;
  readonly finishGameState?: "ready" | "saving" | "saved" | "queued" | "blocked";
  readonly clubLogo?: string | null;
  readonly clubName?: string;
}

const foulPhases: ReadonlySet<GameState["phase"]> = new Set([
  "day",
  "voting",
  "voting-cancelled",
  "car-crash",
  "car-crash-decision",
  "car-crash-result",
  "car-crash-skipped",
  "goodbye-speech",
]);

const isSkippedCarCrash = (game: GameState): boolean => {
  if (game.phase === "car-crash-skipped") return true;
  if (game.phase !== "car-crash-decision") return false;
  const activeSeats = game.players
    .filter(({ status }) => status === "active")
    .map(({ seat }) => seat);
  const tiedSeats = new Set(game.carCrashSeats ?? []);
  return tiedSeats.size === activeSeats.length && activeSeats.every((seat) => tiedSeats.has(seat));
};

type GameTranslator = FeatureI18n<GameMessageKey>["t"];

const phaseTitle = (game: GameState, t: GameTranslator): string => {
  switch (game.phase) {
    case "mafia-sleep":
      return t("game.mafiaSleep");
    case "don-identification":
      return t("game.donIdentification");
    case "sheriff-identification":
      return t("game.sheriffIdentification");
    case "free-seating":
      return t("game.freeSeating");
    case "mafia-planning":
      return t("game.agreement");
    case "day":
      return game.day === 1 ? t("game.zeroRound") : t("game.day", { day: game.day - 1 });
    case "voting":
    case "voting-cancelled":
      return t("voting.voting");
    case "car-crash":
    case "car-crash-skipped":
      return t("voting.carCrash");
    case "car-crash-decision":
      return isSkippedCarCrash(game) ? t("voting.carCrash") : t("voting.carCrashDecision");
    case "car-crash-result":
      return t("voting.carCrashResult");
    case "goodbye-speech":
      return t("game.goodbyeSpeech");
    case "best-move":
      return t("bestMove.center");
    case "night-mafia":
      return t("night.mafiaShots");
    case "night-mafia-result":
      return t("night.mafiaShots");
    case "night-don":
    case "night-don-result":
      return t("night.donCheck");
    case "night-sheriff":
    case "night-sheriff-result":
      return t("night.sheriffCheck");
    case "night-resolution":
      return t("game.nightComplete");
    case "finished":
      return game.winner === "red" ? t("game.citizensWon") : t("game.mafiaWon");
    case "draw":
      return t("game.drawn");
    case "cancelled":
      return t("game.cancelled");
  }
};

export const GameScreen = ({
  game,
  playerExitSettings = DEFAULT_PLAYER_EXIT_SETTINGS,
  gameName,
  hostName,
  onGameChange,
  onEvent,
  onAcceptedEvent,
  mode = "live",
  previewSequence,
  onExitPreview = () => undefined,
  onResetPreview = () => undefined,
  canResetPreview = true,
  privacyHidden,
  rulesOpen = false,
  onRulesClose = () => undefined,
  onFinishGame = () => undefined,
  finishGameState = "ready",
  clubLogo = null,
  clubName,
}: GameScreenProps) => {
  const { t, formatList } = useMessages(gameMessages);
  const displayName = usePlayerDisplayName();
  const opening = [
    "mafia-planning",
    "mafia-sleep",
    "don-identification",
    "sheriff-identification",
    "free-seating",
  ].includes(game.phase);
  const displayGameName = gameName ?? t("game.table");
  const [disciplineRequest, setDisciplineRequest] = useState<DisciplineRequest | null>(null);
  const [ruleRequest, setRuleRequest] = useState<{ game: GameState; rule: RuleReferenceId } | null>(
    null,
  );
  const gameplayBlocked =
    hasImmediateRemovalAnnouncement(game) ||
    (game.phase === "finished" &&
      !!game.disciplinaryRemovals?.some((r) => r.announcement === "pending"));
  const currentSeat = game.turnOrder[game.currentTurnIndex];
  const currentPlayer = game.players.find(
    ({ seat, status }) => seat === currentSeat && status === "active",
  );
  const isLastDayTurn = game.phase === "day" && game.currentTurnIndex === game.turnOrder.length - 1;
  const votingRequired =
    game.redCardIssuedThisDay !== true &&
    isVotingRequired(game.day, getActiveNominations(game).length);
  const nominationView = (seat: number) => {
    const nomination = game.nominations.find(({ candidateSeat }) => candidateSeat === seat);
    return {
      nominated: nomination !== undefined,
      supportCount: nomination?.supporterSeats?.length ?? 0,
      nominationSelected:
        game.phase === "day" && currentPlayer !== undefined
          ? nomination?.nominatorSeat === currentPlayer.seat ||
            (nomination?.supporterSeats?.includes(currentPlayer.seat) ?? false)
          : undefined,
    };
  };
  const activeCitizens = game.players.filter(
    ({ team, status }) => team === "red" && status === "active",
  ).length;
  const activeMafia = game.players.filter(
    ({ team, status }) => team === "black" && status === "active",
  ).length;
  const foulAvailable =
    mode === "live" && !gameplayBlocked && game.day >= 1 && foulPhases.has(game.phase);
  const penaltiesAvailable =
    mode === "live" &&
    finishGameState !== "blocked" &&
    !["finished", "draw", "cancelled"].includes(game.phase);
  const requestedRule =
    penaltiesAvailable && ruleRequest?.game === game ? ruleRequest.rule : undefined;
  const readerOpen = penaltiesAvailable && (rulesOpen || requestedRule !== undefined);
  const openPenalty = penaltiesAvailable
    ? (seat: number) => {
        if (!game.players.some((p) => p.seat === seat)) return;
        setRuleRequest(null);
        onRulesClose();
        setDisciplineRequest((previous) => ({
          seat,
          action: "removal",
          id: (previous?.id ?? 0) + 1,
          game,
          shortcut: true,
        }));
      }
    : undefined;
  const continueSetup = () => {
    const next = advanceOpeningPhase(game);
    if (onAcceptedEvent !== undefined) {
      onAcceptedEvent({ type: "phase.changed", payload: { to: next.phase } });
    } else {
      onGameChange(next);
      onEvent("phase.changed", { from: game.phase, to: next.phase });
    }
  };

  const finishTurn = () => {
    if (currentSeat === undefined) return;
    if (onAcceptedEvent !== undefined) {
      onAcceptedEvent({ type: "turn.completed", payload: { seat: currentSeat } });
    } else {
      const next = completeCurrentTurn(game);
      onGameChange(next);
      onEvent("turn.completed", { seat: currentSeat });
    }
  };

  const foulPlayer = (seat: number) => {
    if (
      !foulAvailable ||
      !game.players.some((player) => player.seat === seat && player.status === "active")
    )
      return;
    if (game.players.find((p) => p.seat === seat)?.fouls === 3) {
      setDisciplineRequest((previous) => ({
        seat,
        action: "foul",
        id: (previous?.id ?? 0) + 1,
        game,
      }));
      return;
    }
    const next = issueFoul(game, seat);
    const player = next.players.find((candidate) => candidate.seat === seat);
    if (onAcceptedEvent !== undefined && player !== undefined) {
      onAcceptedEvent({
        type: "foul.issued",
        payload: {
          seat,
          foulNumber: player.fouls,
          redCarded: player.status === "red-carded",
          phase: game.phase,
          currentTurnIndex: game.currentTurnIndex,
        },
      });
    } else {
      onGameChange(next);
      onEvent("foul.issued", { seat });
    }
  };

  const toggleNomination = (seat: number) => {
    if (
      mode !== "live" ||
      gameplayBlocked ||
      game.phase !== "day" ||
      !currentPlayer ||
      !game.players.some((player) => player.seat === seat && player.status === "active")
    )
      return;
    const selected = !nominationView(seat).nominationSelected;
    const next = setNominationSelection(game, currentPlayer.seat, seat, selected);
    // Preflight against the displayed turn. Ignored second nominations never enter history.
    if (next === game) return;
    const payload = { nominatorSeat: currentPlayer.seat, candidateSeat: seat, selected };
    if (onAcceptedEvent) onAcceptedEvent({ type: "nomination.selection-set", payload });
    else {
      onGameChange(next);
      onEvent("nomination.selection-set", payload);
    }
  };

  const tableCenter = (() => {
    if (mode === "preview") {
      return (
        <div className="preview-state-center" role="group" aria-label={t("game.previewControls")}>
          <span className="table-prompt">
            {t("game.previewLog", { sequence: previewSequence ?? "—" })}
          </span>
          <button type="button" onClick={onExitPreview}>
            {t("game.exitPreview")}
          </button>
          <button
            type="button"
            className="danger-action"
            disabled={!canResetPreview}
            onClick={onResetPreview}
          >
            {t("game.resetPreview")}
          </button>
        </div>
      );
    }
    if (game.phase === "finished" && game.winner !== null) {
      return (
        <div className={`winner-card winner-${game.winner}`} role="status">
          <span className="table-prompt">{t("game.finished")}</span>
          <strong>{game.winner === "red" ? t("game.citizensWon") : t("game.mafiaWon")}</strong>
          {finishGameState === "queued" || finishGameState === "blocked" ? (
            <span className="finish-game-local">
              {t(finishGameState === "blocked" ? "game.saveStateBlocked" : "game.saveStateLocal")}
            </span>
          ) : null}
        </div>
      );
    }
    if (game.phase === "draw" || game.phase === "cancelled") {
      return (
        <div className="winner-card" role="status">
          <span className="table-prompt">{t("game.finished")}</span>
          <strong>{game.phase === "draw" ? t("game.drawn") : t("game.cancelled")}</strong>
          {finishGameState === "ready" ? null : (
            <span className="finish-game-local">
              {finishGameState === "saving"
                ? t("game.saving")
                : finishGameState === "blocked"
                  ? t("game.saveStateBlocked")
                  : finishGameState === "queued"
                    ? t("game.saveStateLocal")
                    : t("game.safelySaved")}
            </span>
          )}
        </div>
      );
    }
    if (game.phase === "goodbye-speech") {
      const names = formatList(
        (game.goodbyeSeats ?? []).map((seat) => {
          const player = game.players.find((candidate) => candidate.seat === seat);
          return player === undefined ? t("utility.seat", { seat }) : displayName(player);
        }),
      );
      return (
        <div className="table-check-center">
          <span className="table-prompt">{t("game.finalWords")}</span>
          <strong>{names || t("game.finalWords")}</strong>
        </div>
      );
    }
    if (opening) {
      const guide: Partial<Record<GameState["phase"], GameMessageKey>> = {
        "mafia-planning": "game.agreementGuide",
        "mafia-sleep": "game.sleepGuide",
        "don-identification": "game.donGuide",
        "sheriff-identification": "game.sheriffGuide",
        "free-seating": "game.freeSeatingGuide",
      };
      return (
        <div className="table-check-center">
          <strong>{t(guide[game.phase]!)}</strong>
        </div>
      );
    }
    if (game.phase === "day") {
      return (
        <div className="day-center-stack">
          <span className="table-prompt">{t("game.currentSpeaker")}</span>
          <strong>
            {currentPlayer === undefined
              ? t("game.waitingForActivePlayer")
              : displayName(currentPlayer)}
          </strong>
          {currentPlayer ? (
            <small>
              {t(
                getCurrentTurnDuration(game) === 0
                  ? "game.nominationOnly"
                  : getCurrentTurnDuration(game) === 30
                    ? "game.shortTableSpeech"
                    : "game.normalSpeech",
              )}
            </small>
          ) : null}
        </div>
      );
    }
    if (game.phase === "car-crash") {
      return (
        <div className="day-center-stack">
          <span className="table-prompt">{t("game.carCrashSpeech")}</span>
          <strong>
            {currentPlayer === undefined ? t("game.waitingForNominee") : displayName(currentPlayer)}
          </strong>
        </div>
      );
    }
    return <span className="table-prompt">{t("game.waitingForNextAction")}</span>;
  })();

  const tableAdvance = (() => {
    if (mode === "preview") return undefined;
    if (game.phase === "finished" || game.phase === "draw" || game.phase === "cancelled") {
      return (
        <button type="button" disabled={finishGameState !== "ready"} onClick={onFinishGame}>
          {finishGameState === "saving"
            ? t("game.saving")
            : finishGameState === "queued"
              ? t("game.savedOffline")
              : finishGameState === "blocked"
                ? t("game.saveBlocked")
                : finishGameState === "saved"
                  ? t("game.safelySaved")
                  : t("game.finish")}
        </button>
      );
    }
    if (game.phase === "goodbye-speech") {
      return (
        <button
          type="button"
          onClick={() => {
            const next = completeGoodbyeSpeech(game);
            if (onAcceptedEvent !== undefined) {
              onAcceptedEvent({
                type: "phase.changed",
                payload: { to: next.phase },
              });
            } else {
              onGameChange(next);
              onEvent("phase.changed", { from: game.phase, to: next.phase });
            }
          }}
        >
          {game.goodbyeNext === "day"
            ? t("game.beginDay", { day: game.day - 1 })
            : t("game.beginNight")}
        </button>
      );
    }
    if (opening) {
      const action: Partial<Record<GameState["phase"], GameMessageKey>> = {
        "mafia-planning": "game.confirmSleep",
        "mafia-sleep": "game.beginSheriffGreeting",
        "don-identification": "game.beginSheriffGreeting",
        "sheriff-identification": "game.beginZeroRound",
        "free-seating": "game.beginZeroRound",
      };
      return (
        <button type="button" onClick={continueSetup}>
          {t(action[game.phase]!)}
        </button>
      );
    }
    if (game.phase === "day") {
      return (
        <button type="button" disabled={currentPlayer === undefined} onClick={finishTurn}>
          {isLastDayTurn
            ? votingRequired
              ? t(
                  getActiveNominations(game).length === 1
                    ? "game.laterSoleNominee"
                    : "game.beginVoting",
                )
              : t("game.beginNight")
            : t("game.nextPlayer")}
        </button>
      );
    }
    if (game.phase === "car-crash") {
      return (
        <button type="button" disabled={currentPlayer === undefined} onClick={finishTurn}>
          {game.currentTurnIndex >= game.turnOrder.length - 1
            ? t("game.beginRevote")
            : t("game.nextNominee")}
        </button>
      );
    }
    return (
      <button type="button" disabled>
        {t("game.continue")}
      </button>
    );
  })();

  const endgameLabel = isGuessingState(game) ? t("game.guessingGame") : t("game.critical");
  const tableCycle =
    opening || game.phase === "best-move" || game.phase.startsWith("night-") ? "night" : "day";
  const effectivePrivacyHidden = privacyHidden && tableCycle === "day";

  return (
    <PlayerExitProvider
      game={game}
      live={mode === "live"}
      privacyHidden={effectivePrivacyHidden}
      settings={playerExitSettings}
    >
      <RulesBookHost
        open={readerOpen}
        rule={requestedRule}
        onClose={() => {
          setRuleRequest(null);
          onRulesClose();
        }}
      />
      <main
        className={`game-shell phase-${game.phase}${mode === "preview" ? " is-history-preview" : ""} is-table-cycle-${tableCycle}`}
      >
        <header className="game-header">
          {clubLogo === null ? null : (
            <img className="active-club-header-logo" src={clubLogo} alt="" />
          )}
          <div>
            <p className="eyebrow">
              {t("game.live")} · {clubName === undefined ? "" : `${clubName} · `}
              {displayGameName}
            </p>
            <h1>
              {mode === "preview"
                ? `${phaseTitle(game, t)} · ${t("game.preview")}`
                : phaseTitle(game, t)}
            </h1>
          </div>
        </header>

        <div className="live-layout">
          <section className="table-workspace">
            {mode !== "preview" ? (
              <FederationDisciplineControls
                key={game.phase}
                game={game}
                request={
                  penaltiesAvailable && disciplineRequest?.game === game ? disciplineRequest : null
                }
                readerOpen={readerOpen}
                onOpenRule={(rule) => {
                  if (!penaltiesAvailable) return;
                  setRuleRequest({ game, rule });
                }}
                privacyHidden={effectivePrivacyHidden}
                onComplete={() => {
                  setDisciplineRequest(null);
                }}
                onGameChange={(next) => {
                  onGameChange(next);
                  if (game.phase === "voting" && next.phase === "voting") {
                    setDisciplineRequest((current) =>
                      current?.game === game ? { ...current, game: next } : current,
                    );
                  }
                }}
                onEvent={onEvent}
                onAcceptedEvent={
                  onAcceptedEvent &&
                  ((draft) => {
                    const next = onAcceptedEvent(draft);
                    // Only an acknowledged, locally submitted ballot command may
                    // advance the open review's captured context. External changes close it.
                    if (
                      next &&
                      (draft.type === "voting.count-disputed" ||
                        draft.type === "voting.count-ruled" ||
                        draft.type === "vote.corrected")
                    ) {
                      setDisciplineRequest((current) =>
                        current?.game === game ? { ...current, game: next } : current,
                      );
                    }
                  })
                }
              />
            ) : null}
            <div
              className="team-counts"
              aria-label={
                effectivePrivacyHidden
                  ? t("game.activeTeamCountsHidden")
                  : t("game.activeCitizensAndMafia", {
                      citizens: activeCitizens,
                      mafia: activeMafia,
                    })
              }
            >
              <span className="team-count-values">
                <span>
                  {t("game.citizens")} {effectivePrivacyHidden ? "?" : activeCitizens}
                </span>
                <span>
                  {t("game.mafia")} {effectivePrivacyHidden ? "?" : activeMafia}
                </span>
              </span>
              {!effectivePrivacyHidden && isCriticalState(game) ? (
                <span className="critical-state-pill" role="status" aria-label={endgameLabel}>
                  {endgameLabel}
                </span>
              ) : null}
            </div>
            <fieldset className="federation-gameplay-boundary" disabled={gameplayBlocked}>
              {mode === "preview" ? (
                <GameTable
                  animateActive={game.phase === "day" || game.phase === "car-crash"}
                  hostName={hostName}
                  privacyHidden={effectivePrivacyHidden}
                  seats={game.players.map((player) => ({
                    ...player,
                    name: displayName(player),
                    current:
                      player.seat === currentPlayer?.seat ||
                      game.checkResult?.targetSeat === player.seat,
                    fouls: player.fouls,
                    muted: player.mutePending,
                    ...nominationView(player.seat),
                  }))}
                  center={tableCenter}
                  readOnly
                />
              ) : game.phase === "voting" ||
                game.phase === "voting-cancelled" ||
                game.phase === "car-crash-decision" ||
                game.phase === "car-crash-result" ||
                game.phase === "car-crash-skipped" ? (
                <VotingStage
                  onSeatPenalty={openPenalty}
                  game={game}
                  hostName={hostName}
                  privacyHidden={effectivePrivacyHidden}
                  onFoul={foulAvailable ? foulPlayer : undefined}
                  onGameChange={onGameChange}
                  onEvent={onEvent}
                  onAcceptedEvent={onAcceptedEvent}
                  onResolved={(votingGame, seats) => {
                    onGameChange(completeEliminations(votingGame, seats));
                    for (const seat of seats) {
                      onEvent("player.eliminated", { seat, source: "vote" });
                    }
                  }}
                />
              ) : game.phase === "best-move" ? (
                <FederationBestMoveStage
                  onSeatPenalty={openPenalty}
                  game={game}
                  hostName={hostName}
                  onGameChange={onGameChange}
                  onEvent={onEvent}
                  onAcceptedEvent={onAcceptedEvent}
                />
              ) : game.phase.startsWith("night-") ? (
                <NightStage
                  onSeatPenalty={openPenalty}
                  game={game}
                  hostName={hostName}
                  privacyHidden={effectivePrivacyHidden}
                  onGameChange={onGameChange}
                  onEvent={onEvent}
                  onAcceptedEvent={onAcceptedEvent}
                />
              ) : (
                <GameTable
                  onSeatPenalty={openPenalty}
                  onSeatFoul={foulAvailable ? foulPlayer : undefined}
                  animateActive={game.phase === "day" || game.phase === "car-crash"}
                  hostName={hostName}
                  privacyHidden={effectivePrivacyHidden}
                  seats={game.players.map((player) => ({
                    seat: player.seat,
                    name: displayName(player),
                    role: player.role,
                    status: player.status,
                    mafiaShooter:
                      game.phase === "mafia-planning" &&
                      player.status === "active" &&
                      player.team === "black",
                    sheriffHighlight:
                      game.phase === "sheriff-identification" &&
                      player.status === "active" &&
                      player.role === "sheriff",
                    dimmed: game.phase === "mafia-planning" && player.team !== "black",
                    inactive:
                      game.phase === "car-crash" && !game.carCrashSeats?.includes(player.seat),
                    votingHighlight:
                      game.phase === "goodbye-speech" && game.goodbyeSeats?.[0] === player.seat,
                    current:
                      player.seat === currentPlayer?.seat &&
                      player.status === "active" &&
                      (game.phase === "day" || game.phase === "car-crash"),
                    fouls: player.fouls,
                    muted: player.mutePending,
                    ...nominationView(player.seat),
                  }))}
                  seatActionLabel={(seat) =>
                    game.phase === "day" && currentPlayer !== undefined && seat.status === "active"
                      ? t(
                          seat.nominationSelected
                            ? "game.removeSelection"
                            : seat.nominated
                              ? "game.support"
                              : "game.nominate",
                          { name: seat.name },
                        )
                      : t("table.seat", { seat: seat.seat, name: seat.name })
                  }
                  onSeatClick={(seat) => {
                    if (game.phase === "day") toggleNomination(seat);
                  }}
                  center={tableCenter}
                  advance={tableAdvance}
                />
              )}
            </fieldset>
          </section>
        </div>
      </main>
    </PlayerExitProvider>
  );
};

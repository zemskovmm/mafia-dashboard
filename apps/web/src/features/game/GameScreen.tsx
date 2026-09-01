import { useState } from "react";
import {
  advanceSetupPhase,
  completeBestMove,
  completeGoodbyeSpeech,
  completeCurrentTurn,
  beginNight,
  evaluateVictory,
  getActiveNominations,
  isVotingRequired,
  issueFoul,
  markPlayerInactive,
  nominate,
  redCard,
  toggleBestMoveSeat,
} from "@mafia/game-domain";
import type { CanonicalGameEventDraft, GameState } from "@mafia/game-domain";
import { useMessages, type FeatureI18n } from "../../i18n/I18nProvider.js";
import { gameMessages, type GameMessageKey } from "../../i18n/messages/game.js";
import { NightStage } from "../night/NightStage.js";
import { GameTable } from "../table/GameTable.js";
import { isCriticalState } from "./critical-state.js";
import { VotingStage } from "../voting/VotingStage.js";

interface GameScreenProps {
  readonly game: GameState;
  readonly gameName?: string;
  readonly hostName: string;
  readonly onGameChange: (game: GameState) => void;
  readonly onEvent: (type: string, payload: Record<string, unknown>) => void;
  readonly onAcceptedEvent?: (event: CanonicalGameEventDraft) => void;
  readonly mode?: "live" | "preview";
  readonly previewSequence?: number;
  readonly onExitPreview?: () => void;
  readonly onResetPreview?: () => void;
  readonly canResetPreview?: boolean;
  readonly privacyHidden: boolean;
  readonly onFinishGame?: () => void;
  readonly finishGameState?: "ready" | "saving" | "saved" | "queued";
  readonly clubLogo?: string | null;
  readonly clubName?: string;
}

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
    case "mafia-planning":
      return t("game.mafiaPlanningStage");
    case "sheriff-wake":
      return t("game.sheriffWake");
    case "day":
      return t("game.day", { day: game.day });
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
  onFinishGame = () => undefined,
  finishGameState = "ready",
  clubLogo = null,
  clubName,
}: GameScreenProps) => {
  const { t, formatList } = useMessages(gameMessages);
  const displayGameName = gameName ?? t("game.table");
  const [swipedSeat, setSwipedSeat] = useState<number | null>(null);
  const currentSeat = game.turnOrder[game.currentTurnIndex];
  const currentPlayer = game.players.find(
    ({ seat, status }) => seat === currentSeat && status === "active",
  );
  const isLastDayTurn = game.phase === "day" && game.currentTurnIndex === game.turnOrder.length - 1;
  const votingRequired =
    game.redCardIssuedThisDay !== true &&
    isVotingRequired(game.day, getActiveNominations(game).length);
  const currentSpeakerHasNominated = game.nominations.some(
    ({ nominatorSeat }) => nominatorSeat === currentPlayer?.seat,
  );
  const activeCitizens = game.players.filter(
    ({ team, status }) => team === "red" && status === "active",
  ).length;
  const activeMafia = game.players.filter(
    ({ team, status }) => team === "black" && status === "active",
  ).length;
  const swipedPlayer = game.players.find(
    ({ seat, status }) => seat === swipedSeat && status === "active",
  );
  const disciplineAvailable =
    mode === "live" &&
    game.day >= 1 &&
    game.phase !== "mafia-planning" &&
    game.phase !== "sheriff-wake" &&
    game.phase !== "car-crash-result" &&
    game.phase !== "night-resolution" &&
    game.phase !== "finished" &&
    game.phase !== "draw" &&
    game.phase !== "cancelled";
  const revealDisciplineAction = (seat: number) => {
    const player = game.players.find((candidate) => candidate.seat === seat);
    setSwipedSeat((current) =>
      disciplineAvailable && player?.status === "active" && current !== seat ? seat : null,
    );
  };
  const swipeAction =
    disciplineAvailable && swipedPlayer !== undefined ? (
      <>
        <span className="table-swipe-player">{swipedPlayer.name}</span>
        <button
          type="button"
          className="table-swipe-red-card"
          aria-label={t("game.redCard", { name: swipedPlayer.name })}
          onClick={() => {
            setSwipedSeat(null);
            if (onAcceptedEvent !== undefined) {
              onAcceptedEvent({
                type: "player.red-carded",
                payload: {
                  seat: swipedPlayer.seat,
                  phase: game.phase,
                  currentTurnIndex: game.currentTurnIndex,
                },
              });
            } else {
              const next = redCard(game, swipedPlayer.seat);
              onGameChange(next);
              onEvent("player.red-carded", {
                seat: swipedPlayer.seat,
                source: "swipe",
                phase: game.phase,
              });
            }
          }}
        >
          {t("game.redCard", { name: swipedPlayer.name })}
        </button>
        <button
          type="button"
          className="table-swipe-close"
          aria-label={t("game.closeActions", { name: swipedPlayer.name })}
          onClick={() => setSwipedSeat(null)}
        >
          ×
        </button>
      </>
    ) : undefined;

  const continueSetup = () => {
    const next = advanceSetupPhase(game);
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
      if (player?.status === "red-carded") {
        onEvent("player.red-carded", { seat, source: "fourth-foul" });
      }
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
          {finishGameState === "queued" ? (
            <span className="finish-game-local">{t("game.saveStateLocal")}</span>
          ) : null}
        </div>
      );
    }
    if (game.phase === "draw" || game.phase === "cancelled") {
      return (
        <div className="winner-card" role="status">
          <span className="table-prompt">{t("game.finished")}</span>
          <strong>{game.phase === "draw" ? t("game.drawn") : t("game.cancelled")}</strong>
        </div>
      );
    }
    if (game.phase === "best-move" && game.bestMove !== undefined) {
      return (
        <div className="best-move-center">
          <span className="table-prompt">{t("bestMove.center")}</span>
          <strong>{t("bestMove.selected", { count: game.bestMove.selectedSeats.length })}</strong>
        </div>
      );
    }
    if (game.phase === "goodbye-speech") {
      const names = formatList(
        (game.goodbyeSeats ?? []).map(
          (seat) =>
            game.players.find((player) => player.seat === seat)?.name ??
            t("utility.seat", { seat }),
        ),
      );
      return (
        <div className="table-check-center">
          <span className="table-prompt">{t("game.finalWords")}</span>
          <strong>{names || t("game.finalWords")}</strong>
        </div>
      );
    }
    if (game.phase === "mafia-planning") {
      return (
        <div className="table-check-center">
          <span className="table-prompt">{t("game.mafiaPlanning")}</span>
          <strong>{t("game.reviewTargetOrder")}</strong>
        </div>
      );
    }
    if (game.phase === "sheriff-wake") {
      return (
        <div className="table-check-center">
          <span className="table-prompt">{t("game.sheriffWake")}</span>
          <strong>{t("game.wakeSheriff")}</strong>
        </div>
      );
    }
    if (game.phase === "day") {
      return (
        <div className="day-center-stack">
          <span className="table-prompt">{t("game.currentSpeaker")}</span>
          <strong>{currentPlayer?.name ?? t("game.waitingForActivePlayer")}</strong>
        </div>
      );
    }
    if (game.phase === "car-crash") {
      return (
        <div className="day-center-stack">
          <span className="table-prompt">{t("game.carCrashSpeech")}</span>
          <strong>{currentPlayer?.name ?? t("game.waitingForNominee")}</strong>
        </div>
      );
    }
    return <span className="table-prompt">{t("game.waitingForNextAction")}</span>;
  })();

  const tableAdvance = (() => {
    if (mode === "preview") return undefined;
    if (game.phase === "draw" || game.phase === "cancelled") return undefined;
    if (game.phase === "finished") {
      return (
        <button type="button" disabled={finishGameState !== "ready"} onClick={onFinishGame}>
          {finishGameState === "saving"
            ? t("game.saving")
            : finishGameState === "queued"
              ? t("game.savedOffline")
              : finishGameState === "saved"
                ? t("game.safelySaved")
                : t("game.finish")}
        </button>
      );
    }
    if (game.phase === "best-move" && game.bestMove !== undefined) {
      return (
        <button
          type="button"
          disabled={game.bestMove.selectedSeats.length !== 3}
          onClick={() => {
            const next = completeBestMove(game);
            if (onAcceptedEvent !== undefined && game.bestMove !== undefined) {
              onAcceptedEvent({
                type: "best-move.completed",
                payload: {
                  playerSeat: game.bestMove.playerSeat,
                  selectedSeats: game.bestMove.selectedSeats,
                  mafiaHits: next.bestMove?.mafiaHits ?? 0,
                },
              });
            } else {
              onGameChange(next);
              onEvent("best-move.completed", {
                playerSeat: game.bestMove?.playerSeat,
                selectedSeats: game.bestMove?.selectedSeats,
                mafiaHits: next.bestMove?.mafiaHits,
              });
            }
          }}
        >
          {t("bestMove.save")}
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
            ? t("game.beginDay", { day: game.day })
            : t("game.beginNight")}
        </button>
      );
    }
    if (game.phase === "mafia-planning") {
      return (
        <button type="button" onClick={continueSetup}>
          {t("game.continueSheriffWake")}
        </button>
      );
    }
    if (game.phase === "sheriff-wake") {
      return (
        <button type="button" onClick={continueSetup}>
          {t("game.beginDayOne")}
        </button>
      );
    }
    if (game.phase === "day") {
      return (
        <button type="button" disabled={currentPlayer === undefined} onClick={finishTurn}>
          {isLastDayTurn
            ? votingRequired
              ? t("game.beginVoting")
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

  const tableCycle =
    game.phase === "mafia-planning" ||
    game.phase === "sheriff-wake" ||
    game.phase.startsWith("night-")
      ? "night"
      : "day";

  return (
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
            {displayGameName} · {t("game.hostView")}
          </p>
          <h1>
            {mode === "preview"
              ? `${phaseTitle(game, t)} · ${t("game.preview")}`
              : phaseTitle(game, t)}
          </h1>
        </div>
        {game.phase === "mafia-planning" ? (
          <div className="phase-banner night-banner">{t("game.mafiaPlanningBanner")}</div>
        ) : null}
        {game.phase === "sheriff-wake" ? (
          <div className="phase-banner sheriff-banner">{t("game.sheriffWakeBanner")}</div>
        ) : null}
        {game.phase === "day" && currentPlayer !== undefined ? (
          <div className="phase-banner current-turn-copy">
            {isLastDayTurn
              ? votingRequired
                ? t("game.finalTurnVoting", { name: currentPlayer.name })
                : t("game.finalTurnNight", { name: currentPlayer.name })
              : t("game.currentTurn", { name: currentPlayer.name })}
          </div>
        ) : null}
        {game.phase === "car-crash" && currentPlayer !== undefined ? (
          <div className="phase-banner current-turn-copy">
            {t("game.carCrashTurn", { name: currentPlayer.name })}
          </div>
        ) : null}
        {game.phase === "goodbye-speech" ? (
          <div className="phase-banner current-turn-copy">{t("game.finalWordsBeforeNight")}</div>
        ) : null}
        {game.phase === "best-move" ? (
          <div className="phase-banner current-turn-copy">{t("game.nameThreeMafia")}</div>
        ) : null}
      </header>

      <div className="live-layout">
        <section className="table-workspace">
          <div
            className="team-counts"
            aria-label={
              privacyHidden
                ? t("game.activeTeamCountsHidden")
                : t("game.activeCitizensAndMafia", {
                    citizens: activeCitizens,
                    mafia: activeMafia,
                  })
            }
          >
            <span className="team-count-values">
              <span>
                {t("game.citizens")} {privacyHidden ? "?" : activeCitizens}
              </span>
              <span>
                {t("game.mafia")} {privacyHidden ? "?" : activeMafia}
              </span>
            </span>
            {isCriticalState(game) ? (
              <span className="critical-state-pill" role="status" aria-label={t("game.critical")}>
                {t("game.critical")}
              </span>
            ) : null}
          </div>
          {mode === "preview" ? (
            <GameTable
              hostName={hostName}
              privacyHidden={privacyHidden}
              seats={game.players.map((player) => ({
                ...player,
                current:
                  player.seat === currentPlayer?.seat ||
                  game.checkResult?.targetSeat === player.seat,
                fouls: player.fouls,
                muted: player.mutePending,
                nominated: game.nominations.some(
                  ({ candidateSeat }) => candidateSeat === player.seat,
                ),
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
              game={game}
              hostName={hostName}
              privacyHidden={privacyHidden}
              onSeatSwipe={disciplineAvailable ? revealDisciplineAction : undefined}
              swipeAction={swipeAction}
              onFoul={foulPlayer}
              onGameChange={onGameChange}
              onEvent={onEvent}
              onAcceptedEvent={onAcceptedEvent}
              onResolved={(votingGame, seats) => {
                const afterElimination = seats.reduce(
                  (state, seat) => markPlayerInactive(state, seat, "eliminated"),
                  votingGame,
                );
                const winner = evaluateVictory(afterElimination.players);
                const next =
                  winner !== null
                    ? { ...afterElimination, phase: "finished" as const, winner }
                    : seats.length === 0
                      ? beginNight(afterElimination)
                      : {
                          ...afterElimination,
                          phase: "goodbye-speech" as const,
                          goodbyeSeats: seats,
                          goodbyeNext: "night" as const,
                        };
                onGameChange(next);
                for (const seat of seats) {
                  onEvent("player.eliminated", { seat, source: "vote" });
                }
              }}
            />
          ) : game.phase.startsWith("night-") ? (
            <NightStage
              game={game}
              hostName={hostName}
              privacyHidden={privacyHidden}
              onSeatSwipe={disciplineAvailable ? revealDisciplineAction : undefined}
              swipeAction={swipeAction}
              onGameChange={onGameChange}
              onEvent={onEvent}
              onAcceptedEvent={onAcceptedEvent}
            />
          ) : (
            <GameTable
              hostName={hostName}
              privacyHidden={privacyHidden}
              onSeatSwipe={disciplineAvailable ? revealDisciplineAction : undefined}
              swipeAction={swipeAction}
              seats={game.players.map((player) => ({
                seat: player.seat,
                name: player.name,
                role: player.role,
                status: player.status,
                mafiaShooter:
                  game.phase === "mafia-planning" &&
                  player.status === "active" &&
                  player.team === "black",
                sheriffHighlight:
                  game.phase === "sheriff-wake" &&
                  player.status === "active" &&
                  player.role === "sheriff",
                dimmed:
                  (game.phase === "mafia-planning" && player.team !== "black") ||
                  (game.phase === "sheriff-wake" && player.role !== "sheriff"),
                inactive: game.phase === "car-crash" && !game.carCrashSeats?.includes(player.seat),
                votingHighlight:
                  (game.phase === "best-move" && game.bestMove?.playerSeat === player.seat) ||
                  (game.phase === "goodbye-speech" && game.goodbyeSeats?.[0] === player.seat),
                current:
                  (player.seat === currentPlayer?.seat &&
                    player.status === "active" &&
                    (game.phase === "day" || game.phase === "car-crash")) ||
                  (game.phase === "best-move" &&
                    game.bestMove?.selectedSeats.includes(player.seat)),
                fouls: player.fouls,
                muted: player.mutePending,
                nominated: game.nominations.some(
                  ({ candidateSeat }) => candidateSeat === player.seat,
                ),
              }))}
              renderSeatActions={(seat) =>
                (game.phase === "day" || game.phase === "car-crash") && seat.status === "active" ? (
                  <>
                    <button
                      type="button"
                      aria-label={t("game.foul", { name: seat.name })}
                      onClick={() => foulPlayer(seat.seat)}
                    >
                      {t("table.foul")}
                    </button>
                    {game.phase === "day" ? (
                      <button
                        type="button"
                        aria-label={t("game.nominate", { name: seat.name })}
                        disabled={
                          currentPlayer === undefined ||
                          seat.nominated ||
                          currentSpeakerHasNominated
                        }
                        onClick={() => {
                          if (currentPlayer === undefined) return;
                          if (onAcceptedEvent !== undefined) {
                            onAcceptedEvent({
                              type: "player.nominated",
                              payload: {
                                nominatorSeat: currentPlayer.seat,
                                candidateSeat: seat.seat,
                              },
                            });
                          } else {
                            onGameChange(nominate(game, currentPlayer.seat, seat.seat));
                            onEvent("player.nominated", {
                              nominatorSeat: currentPlayer.seat,
                              candidateSeat: seat.seat,
                            });
                          }
                        }}
                      >
                        {t("game.vote")}
                      </button>
                    ) : null}
                  </>
                ) : null
              }
              seatActionLabel={(seat) =>
                game.phase === "best-move"
                  ? seat.status !== "active" || seat.seat === game.bestMove?.playerSeat
                    ? t("table.seat", { seat: seat.seat, name: seat.name })
                    : game.bestMove?.selectedSeats.includes(seat.seat)
                      ? t("bestMove.remove", { name: seat.name })
                      : t("bestMove.add", { name: seat.name })
                  : t("table.seat", { seat: seat.seat, name: seat.name })
              }
              seatActionDisabled={(seat) =>
                game.phase === "best-move" &&
                (seat.status !== "active" || seat.seat === game.bestMove?.playerSeat)
              }
              onSeatClick={(seat) => {
                if (game.phase === "best-move") {
                  const player = game.players.find((candidate) => candidate.seat === seat);
                  if (player?.status !== "active" || seat === game.bestMove?.playerSeat) return;
                  onGameChange(toggleBestMoveSeat(game, seat));
                }
              }}
              center={tableCenter}
              advance={tableAdvance}
            />
          )}
        </section>
      </div>
    </main>
  );
};

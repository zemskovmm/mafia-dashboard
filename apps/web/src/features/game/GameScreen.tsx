import { useState } from "react";
import {
  advanceSetupPhase,
  completeBestMove,
  completeGoodbyeSpeech,
  completeCurrentTurn,
  beginNight,
  evaluateVictory,
  issueFoul,
  markPlayerInactive,
  nominate,
  redCard,
  toggleBestMoveSeat,
} from "@mafia/game-domain";
import type { CanonicalGameEventDraft, GameState } from "@mafia/game-domain";
import { NightStage } from "../night/NightStage.js";
import { GameTable } from "../table/GameTable.js";
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
  readonly privacyHidden: boolean;
  readonly onFinishGame?: () => void;
  readonly finishGameState?: "ready" | "saving" | "saved" | "error";
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

const phaseTitle = (game: GameState): string => {
  switch (game.phase) {
    case "mafia-planning":
      return "Mafia planning stage";
    case "sheriff-wake":
      return "Sheriff wake-up";
    case "day":
      return `Day ${game.day}`;
    case "voting":
      return "Voting";
    case "voting-cancelled":
      return "Voting";
    case "car-crash":
      return "Car crash";
    case "car-crash-decision":
      return isSkippedCarCrash(game) ? "Car crash" : "Car crash decision";
    case "car-crash-result":
      return "Car crash result";
    case "car-crash-skipped":
      return "Car crash";
    case "goodbye-speech":
      return "Goodbye speech";
    case "best-move":
      return "Best move";
    case "night-mafia":
      return "Mafia shots";
    case "night-mafia-result":
      return "Mafia result";
    case "night-don":
      return "Don check";
    case "night-don-result":
      return "Don result";
    case "night-sheriff":
      return "Sheriff check";
    case "night-sheriff-result":
      return "Sheriff result";
    case "night-resolution":
      return "Night complete";
    case "finished":
      return `${game.winner === "red" ? "Citizens" : "Mafia"} won`;
  }
};

export const GameScreen = ({
  game,
  gameName = "Mafia table",
  hostName,
  onGameChange,
  onEvent,
  onAcceptedEvent,
  mode = "live",
  previewSequence,
  onExitPreview = () => undefined,
  onResetPreview = () => undefined,
  privacyHidden,
  onFinishGame = () => undefined,
  finishGameState = "ready",
  clubLogo = null,
  clubName,
}: GameScreenProps) => {
  const [swipedSeat, setSwipedSeat] = useState<number | null>(null);
  const currentSeat = game.turnOrder[game.currentTurnIndex];
  const currentPlayer = game.players.find(
    ({ seat, status }) => seat === currentSeat && status === "active",
  );
  const isLastDayTurn = game.phase === "day" && game.currentTurnIndex === game.turnOrder.length - 1;
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
    game.phase !== "finished";
  const revealDisciplineAction = (seat: number) => {
    const player = game.players.find((candidate) => candidate.seat === seat);
    setSwipedSeat(disciplineAvailable && player?.status === "active" ? seat : null);
  };
  const swipeAction =
    disciplineAvailable && swipedPlayer !== undefined ? (
      <>
        <span className="table-swipe-player">{swipedPlayer.name}</span>
        <button
          type="button"
          className="table-swipe-red-card"
          aria-label={`Red card ${swipedPlayer.name}`}
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
                secret: false,
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
          Red card
        </button>
        <button
          type="button"
          className="table-swipe-close"
          aria-label={`Close actions for ${swipedPlayer.name}`}
          onClick={() => setSwipedSeat(null)}
        >
          ×
        </button>
      </>
    ) : undefined;

  const continueSetup = () => {
    const next = advanceSetupPhase(game);
    if (onAcceptedEvent !== undefined) {
      onAcceptedEvent({ type: "phase.changed", payload: { to: next.phase }, secret: false });
    } else {
      onGameChange(next);
      onEvent("phase.changed", { from: game.phase, to: next.phase });
    }
  };

  const finishTurn = () => {
    if (currentSeat === undefined) return;
    if (onAcceptedEvent !== undefined) {
      onAcceptedEvent({ type: "turn.completed", payload: { seat: currentSeat }, secret: false });
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
        secret: false,
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
        <div className="preview-state-center" role="group" aria-label="Log state preview controls">
          <span className="table-prompt">Preview · Log #{previewSequence ?? "—"}</span>
          <button type="button" onClick={onExitPreview}>
            Exit preview
          </button>
          <button type="button" className="danger-action" onClick={onResetPreview}>
            Reset game to this state
          </button>
        </div>
      );
    }
    if (game.phase === "finished" && game.winner !== null) {
      return (
        <div className={`winner-card winner-${game.winner}`} role="status">
          <span className="table-prompt">Game complete</span>
          <strong>{game.winner === "red" ? "Citizens won" : "Mafia won"}</strong>
          {finishGameState === "error" ? (
            <span className="finish-game-error">Game was not saved. Try again.</span>
          ) : null}
        </div>
      );
    }
    if (game.phase === "best-move" && game.bestMove !== undefined) {
      return (
        <div className="best-move-center">
          <span className="table-prompt">Best move</span>
          <strong>{game.bestMove.selectedSeats.length} of 3 players selected</strong>
        </div>
      );
    }
    if (game.phase === "goodbye-speech") {
      const names = (game.goodbyeSeats ?? [])
        .map((seat) => game.players.find((player) => player.seat === seat)?.name ?? `Seat ${seat}`)
        .join(" and ");
      return (
        <div className="table-check-center">
          <span className="table-prompt">Goodbye speech</span>
          <strong>{names || "Final words"}</strong>
        </div>
      );
    }
    if (game.phase === "mafia-planning") {
      return (
        <div className="table-check-center">
          <span className="table-prompt">Mafia planning</span>
          <strong>Review the target order</strong>
        </div>
      );
    }
    if (game.phase === "sheriff-wake") {
      return (
        <div className="table-check-center">
          <span className="table-prompt">Sheriff wake-up</span>
          <strong>Wake Sheriff · 10 seconds</strong>
        </div>
      );
    }
    if (game.phase === "day") {
      return (
        <div className="day-center-stack">
          <span className="table-prompt">Current speaker</span>
          <strong>{currentPlayer?.name ?? "Waiting for active player"}</strong>
        </div>
      );
    }
    if (game.phase === "car-crash") {
      return (
        <div className="day-center-stack">
          <span className="table-prompt">Car crash speech</span>
          <strong>{currentPlayer?.name ?? "Waiting for nominee"}</strong>
        </div>
      );
    }
    return <span className="table-prompt">Waiting for next action</span>;
  })();

  const tableAdvance = (() => {
    if (mode === "preview") return undefined;
    if (game.phase === "finished") {
      return (
        <button
          type="button"
          disabled={finishGameState === "saving" || finishGameState === "saved"}
          onClick={onFinishGame}
        >
          {finishGameState === "saving"
            ? "Saving game…"
            : finishGameState === "saved"
              ? "Game safely saved"
              : "Finish the game"}
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
                secret: true,
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
          Save Best move
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
                secret: false,
              });
            } else {
              onGameChange(next);
              onEvent("phase.changed", { from: game.phase, to: next.phase });
            }
          }}
        >
          {game.goodbyeNext === "day" ? `Begin day ${game.day}` : "Begin night"}
        </button>
      );
    }
    if (game.phase === "mafia-planning") {
      return (
        <button type="button" onClick={continueSetup}>
          Continue to Sheriff wake-up
        </button>
      );
    }
    if (game.phase === "sheriff-wake") {
      return (
        <button type="button" onClick={continueSetup}>
          Begin day one
        </button>
      );
    }
    if (game.phase === "day") {
      return (
        <button type="button" disabled={currentPlayer === undefined} onClick={finishTurn}>
          {isLastDayTurn
            ? game.nominations.length > 0 && game.redCardIssuedThisDay !== true
              ? "Begin voting"
              : "Begin night"
            : "Next player"}
        </button>
      );
    }
    if (game.phase === "car-crash") {
      return (
        <button type="button" disabled={currentPlayer === undefined} onClick={finishTurn}>
          {game.currentTurnIndex >= game.turnOrder.length - 1 ? "Begin revote" : "Next nominee"}
        </button>
      );
    }
    return (
      <button type="button" disabled>
        Continue
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
            Live game · {clubName === undefined ? "" : `${clubName} · `}
            {gameName} · Host view
          </p>
          <h1>{mode === "preview" ? `${phaseTitle(game)} · Preview` : phaseTitle(game)}</h1>
        </div>
        {game.phase === "mafia-planning" ? (
          <div className="phase-banner night-banner">Mafia planning stage · set target order</div>
        ) : null}
        {game.phase === "sheriff-wake" ? (
          <div className="phase-banner sheriff-banner">Wake Sheriff · 10 seconds</div>
        ) : null}
        {game.phase === "day" && currentPlayer !== undefined ? (
          <div className="phase-banner current-turn-copy">
            {isLastDayTurn
              ? game.nominations.length > 0 && game.redCardIssuedThisDay !== true
                ? `Final turn: ${currentPlayer.name} · Voting next`
                : `Final turn: ${currentPlayer.name} · Night next`
              : `Current turn: ${currentPlayer.name}`}
          </div>
        ) : null}
        {game.phase === "car-crash" && currentPlayer !== undefined ? (
          <div className="phase-banner current-turn-copy">Car crash turn: {currentPlayer.name}</div>
        ) : null}
        {game.phase === "goodbye-speech" ? (
          <div className="phase-banner current-turn-copy">Final words before night</div>
        ) : null}
        {game.phase === "best-move" ? (
          <div className="phase-banner current-turn-copy">Name three potential Mafia players</div>
        ) : null}
      </header>

      <div className="live-layout">
        <section className="table-workspace">
          <div
            className="team-counts"
            aria-label={
              privacyHidden
                ? "Active team counts hidden"
                : `${activeCitizens} active citizens and ${activeMafia} active Mafia`
            }
          >
            <span>Citizens {privacyHidden ? "?" : activeCitizens}</span>
            <span>Mafia {privacyHidden ? "?" : activeMafia}</span>
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
              onSeatSwipe={revealDisciplineAction}
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
              onSeatSwipe={revealDisciplineAction}
              swipeAction={swipeAction}
              onGameChange={onGameChange}
              onEvent={onEvent}
              onAcceptedEvent={onAcceptedEvent}
            />
          ) : (
            <GameTable
              hostName={hostName}
              privacyHidden={privacyHidden}
              onSeatSwipe={revealDisciplineAction}
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
                goodbyeHighlight:
                  (game.phase === "goodbye-speech" && game.goodbyeSeats?.includes(player.seat)) ||
                  (game.phase === "best-move" && game.bestMove?.playerSeat === player.seat),
                votingHighlight:
                  game.goodbyeNext === "day" &&
                  ((game.phase === "best-move" && game.bestMove?.playerSeat === player.seat) ||
                    (game.phase === "goodbye-speech" &&
                      game.goodbyeSeats?.includes(player.seat) === true)),
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
                      aria-label={`Foul ${seat.name}`}
                      onClick={() => foulPlayer(seat.seat)}
                    >
                      Foul
                    </button>
                    {game.phase === "day" ? (
                      <button
                        type="button"
                        aria-label={`Nominate ${seat.name}`}
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
                              secret: false,
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
                        Vote
                      </button>
                    ) : null}
                  </>
                ) : null
              }
              seatActionLabel={(seat) =>
                game.phase === "best-move"
                  ? seat.status !== "active" || seat.seat === game.bestMove?.playerSeat
                    ? `Seat ${seat.seat}: ${seat.name}`
                    : game.bestMove?.selectedSeats.includes(seat.seat)
                      ? `Remove ${seat.name} from Best move`
                      : `Add ${seat.name} to Best move`
                  : `Seat ${seat.seat}: ${seat.name}`
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

import { useRef } from "react";
import {
  advanceSetupPhase,
  completeCurrentTurn,
  beginNight,
  evaluateVictory,
  getCurrentTurnDuration,
  issueFoul,
  markPlayerInactive,
  nominate,
  redCard,
} from "@mafia/game-domain";
import type { GameState } from "@mafia/game-domain";
import { NightStage } from "../night/NightStage.js";
import { GameTable } from "../table/GameTable.js";
import { TimerControls } from "../timer/TimerControls.js";
import type { TimerControlsHandle } from "../timer/TimerControls.js";
import { VotingStage } from "../voting/VotingStage.js";

interface GameScreenProps {
  readonly game: GameState;
  readonly hostName: string;
  readonly onGameChange: (game: GameState) => void;
  readonly onEvent: (type: string, payload: Record<string, unknown>) => void;
  readonly privacyHidden: boolean;
}

const phaseTitle = (game: GameState): string => {
  switch (game.phase) {
    case "mafia-negotiation":
      return "Mafia negotiation";
    case "sheriff-wake":
      return "Sheriff wake-up";
    case "day":
      return `Day ${game.day}`;
    case "voting":
      return "Voting";
    case "car-crash":
      return "Car crash";
    case "car-crash-decision":
      return "Car crash decision";
    case "night-mafia":
      return "Mafia shots";
    case "night-don":
      return "Don check";
    case "night-sheriff":
      return "Sheriff check";
    case "night-resolution":
      return "Night result";
    case "finished":
      return `${game.winner === "red" ? "Citizens" : "Mafia"} win`;
  }
};

export const GameScreen = ({
  game,
  hostName,
  onGameChange,
  onEvent,
  privacyHidden,
}: GameScreenProps) => {
  const timerRef = useRef<TimerControlsHandle>(null);
  const currentSeat = game.turnOrder[game.currentTurnIndex];
  const currentPlayer = game.players.find(
    ({ seat, status }) => seat === currentSeat && status === "active",
  );
  const currentSpeakerHasNominated = game.nominations.some(
    ({ nominatorSeat }) => nominatorSeat === currentPlayer?.seat,
  );

  const continueSetup = () => {
    const next = advanceSetupPhase(game);
    onGameChange(next);
    onEvent("phase.changed", { from: game.phase, to: next.phase });
  };

  const startTurn = () => {
    if (currentPlayer === undefined) {
      return;
    }
    const seconds = getCurrentTurnDuration(game);
    timerRef.current?.start(seconds);
  };

  const finishTurn = () => {
    const next = completeCurrentTurn(game);
    onGameChange(next);
    onEvent("turn.completed", { seat: currentSeat });
  };

  return (
    <main className={`game-shell phase-${game.phase}`}>
      <header className="game-header">
        <div>
          <p className="eyebrow">Live game · Host view</p>
          <h1>{phaseTitle(game)}</h1>
        </div>
        {game.phase === "mafia-negotiation" ? (
          <div className="phase-banner night-banner">Wake Mafia · negotiate target order</div>
        ) : null}
        {game.phase === "sheriff-wake" ? (
          <div className="phase-banner sheriff-banner">Wake Sheriff · 10 seconds</div>
        ) : null}
        {game.phase === "day" && currentPlayer !== undefined ? (
          <div className="phase-banner current-turn-copy">Current turn: {currentPlayer.name}</div>
        ) : null}
        {game.phase === "car-crash" && currentPlayer !== undefined ? (
          <div className="phase-banner current-turn-copy">Car crash turn: {currentPlayer.name}</div>
        ) : null}
      </header>

      <div className="live-layout">
        <section className="table-workspace">
          {game.phase === "voting" || game.phase === "car-crash-decision" ? (
            <VotingStage
              game={game}
              onGameChange={onGameChange}
              onEvent={onEvent}
              onResolved={(votingGame, seats) => {
                const afterElimination = seats.reduce(
                  (state, seat) => markPlayerInactive(state, seat, "eliminated"),
                  votingGame,
                );
                const winner = evaluateVictory(afterElimination.players);
                const next =
                  winner === null
                    ? beginNight(afterElimination)
                    : { ...afterElimination, phase: "finished" as const, winner };
                onGameChange(next);
                for (const seat of seats) {
                  onEvent("player.eliminated", { seat, source: "vote" });
                }
              }}
            />
          ) : game.phase.startsWith("night-") ? (
            <NightStage game={game} onGameChange={onGameChange} onEvent={onEvent} />
          ) : (
            <GameTable
              hostName={hostName}
              privacyHidden={privacyHidden}
              seats={game.players.map((player) => ({
                seat: player.seat,
                name: player.name,
                role: player.role,
                status: player.status,
                current:
                  player.seat === currentPlayer?.seat &&
                  player.status === "active" &&
                  (game.phase === "day" || game.phase === "car-crash"),
                fouls: player.fouls,
                muted: player.mutePending,
                nominated: game.nominations.some(
                  ({ candidateSeat }) => candidateSeat === player.seat,
                ),
              }))}
              renderSeatActions={(seat) =>
                game.phase === "day" && seat.status === "active" ? (
                  <>
                    <button
                      type="button"
                      aria-label={`Foul ${seat.name}`}
                      onClick={() => {
                        onGameChange(issueFoul(game, seat.seat));
                        onEvent("foul.issued", { seat: seat.seat });
                      }}
                    >
                      Foul
                    </button>
                    <button
                      type="button"
                      aria-label={`Red card ${seat.name}`}
                      onClick={() => {
                        onGameChange(redCard(game, seat.seat));
                        onEvent("player.red-carded", { seat: seat.seat });
                      }}
                    >
                      Red
                    </button>
                    <button
                      type="button"
                      aria-label={`Nominate ${seat.name}`}
                      disabled={
                        currentPlayer === undefined ||
                        seat.seat === currentPlayer.seat ||
                        seat.nominated ||
                        currentSpeakerHasNominated
                      }
                      onClick={() => {
                        if (currentPlayer === undefined) return;
                        onGameChange(nominate(game, currentPlayer.seat, seat.seat));
                        onEvent("player.nominated", {
                          nominatorSeat: currentPlayer.seat,
                          candidateSeat: seat.seat,
                        });
                      }}
                    >
                      Vote
                    </button>
                  </>
                ) : null
              }
              center={
                game.phase === "mafia-negotiation" ? (
                  <button type="button" className="table-primary" onClick={continueSetup}>
                    Continue to Sheriff wake-up
                  </button>
                ) : game.phase === "sheriff-wake" ? (
                  <button type="button" className="table-primary" onClick={continueSetup}>
                    Begin day one
                  </button>
                ) : game.phase === "day" && currentPlayer !== undefined ? (
                  <div className="turn-actions">
                    <button type="button" className="table-primary" onClick={startTurn}>
                      Start {currentPlayer.name} turn
                    </button>
                    <button type="button" onClick={finishTurn}>
                      Next player
                    </button>
                  </div>
                ) : game.phase === "car-crash" && currentPlayer !== undefined ? (
                  <div className="turn-actions">
                    <button type="button" className="table-primary" onClick={startTurn}>
                      Start {currentPlayer.name} 30-second turn
                    </button>
                    <button type="button" onClick={finishTurn}>
                      Next nominee
                    </button>
                  </div>
                ) : null
              }
            />
          )}
        </section>

        <aside className="utility-rail">
          <TimerControls ref={timerRef} />
          <section className="nomination-panel">
            <p className="eyebrow">Voting order</p>
            {game.nominations.length === 0 ? (
              <p className="muted">No nominations yet</p>
            ) : (
              <ol>
                {game.nominations.map(({ candidateSeat }) => (
                  <li key={candidateSeat}>Seat {candidateSeat}</li>
                ))}
              </ol>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
};

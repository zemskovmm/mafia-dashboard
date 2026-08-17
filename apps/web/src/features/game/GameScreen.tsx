import { useRef, useState } from "react";
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
  readonly onGameChange: (game: GameState) => void;
  readonly onEvent: (type: string, payload: Record<string, unknown>) => void;
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

export const GameScreen = ({ game, onGameChange, onEvent }: GameScreenProps) => {
  const timerRef = useRef<TimerControlsHandle>(null);
  const [privacyHidden, setPrivacyHidden] = useState(false);
  const currentSeat = game.turnOrder[game.currentTurnIndex];
  const currentPlayer = game.players.find(({ seat }) => seat === currentSeat);

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
    onEvent("turn.started", { seat: currentPlayer.seat, seconds });
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
        <button
          type="button"
          className="privacy-button"
          aria-pressed={privacyHidden}
          onClick={() => setPrivacyHidden((value) => !value)}
        >
          {privacyHidden ? "Show private info" : "Privacy shield"}
        </button>
      </header>

      <div className="live-layout">
        <section className="table-workspace">
          {game.phase === "mafia-negotiation" ? (
            <div className="phase-banner night-banner">Wake Mafia · negotiate target order</div>
          ) : null}
          {game.phase === "sheriff-wake" ? (
            <div className="phase-banner sheriff-banner">Wake Sheriff · 10 seconds</div>
          ) : null}
          {game.phase === "day" && currentPlayer !== undefined ? (
            <div className="current-turn-copy">Current turn: {currentPlayer.name}</div>
          ) : null}

          {game.phase === "voting" ? (
            <VotingStage
              game={game}
              onGameChange={onGameChange}
              onEvent={onEvent}
              onResolved={(votingGame, seats) => {
                const eliminatedSeat = seats[0];
                if (eliminatedSeat === undefined) return;
                const afterElimination = markPlayerInactive(
                  votingGame,
                  eliminatedSeat,
                  "eliminated",
                );
                const winner = evaluateVictory(afterElimination.players);
                const next =
                  winner === null
                    ? beginNight(afterElimination)
                    : { ...afterElimination, phase: "finished" as const, winner };
                onGameChange(next);
                onEvent("player.eliminated", { seat: eliminatedSeat, source: "vote" });
              }}
            />
          ) : game.phase.startsWith("night-") ? (
            <NightStage game={game} onGameChange={onGameChange} onEvent={onEvent} />
          ) : (
            <GameTable
              privacyHidden={privacyHidden}
              seats={game.players.map((player) => ({
                seat: player.seat,
                name: player.name,
                role: player.role,
                status: player.status,
                current: player.seat === currentSeat && game.phase === "day",
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
                      disabled={seat.seat === currentSeat}
                      onClick={() => {
                        if (currentSeat === undefined) return;
                        onGameChange(nominate(game, currentSeat, seat.seat));
                        onEvent("player.nominated", {
                          nominatorSeat: currentSeat,
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
                ) : null
              }
            />
          )}
        </section>

        <aside className="utility-rail">
          <TimerControls ref={timerRef} onEvent={onEvent} />
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

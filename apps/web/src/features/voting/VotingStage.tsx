import { useState } from "react";
import {
  assignCarCrashVote,
  assignVote,
  beginCarCrash,
  beginCarCrashDecision,
  countVotes,
  resolveCarCrashVote,
  resolveVote,
} from "@mafia/game-domain";
import type { GameState } from "@mafia/game-domain";

interface VotingStageProps {
  readonly game: GameState;
  readonly onGameChange: (game: GameState) => void;
  readonly onResolved: (game: GameState, seats: readonly number[]) => void;
  readonly onEvent: (type: string, payload: Record<string, unknown>) => void;
}

export const VotingStage = ({ game, onGameChange, onResolved, onEvent }: VotingStageProps) => {
  const [selectedCandidate, setSelectedCandidate] = useState<number | null>(
    game.nominations[0]?.candidateSeat ?? null,
  );
  const [selectedDecision, setSelectedDecision] = useState(true);
  const totals = countVotes(game);
  const activePlayers = game.players.filter(({ status }) => status === "active");
  const allVotesAssigned = Object.keys(game.voteAssignments).length === activePlayers.length;
  const allDecisionVotesAssigned =
    Object.keys(game.carCrashVotes ?? {}).length === activePlayers.length;

  const resolve = () => {
    const result = resolveVote(game);
    if (result.kind === "car-crash") {
      onGameChange(beginCarCrash(game, result.seats));
      onEvent("voting.resolved", { kind: result.kind, seats: result.seats, totals: result.totals });
      return;
    }
    if (result.kind === "eliminate-both-vote") {
      onGameChange(beginCarCrashDecision(game, result.seats));
      onEvent("voting.resolved", { kind: result.kind, seats: result.seats, totals: result.totals });
      return;
    }
    onResolved(game, result.seats);
    onEvent("voting.resolved", { kind: result.kind, seats: result.seats, totals: result.totals });
  };

  if (game.phase === "car-crash-decision") {
    const nominees = (game.carCrashSeats ?? [])
      .map((seat) => game.players.find((player) => player.seat === seat)?.name ?? `Seat ${seat}`)
      .join(" and ");
    return (
      <section className="voting-stage">
        <div className="phase-banner vote-banner">Car crash · eliminate both?</div>
        <p className="muted">{nominees}</p>
        <div className="candidate-grid" aria-label="Car-crash decision">
          <button
            type="button"
            className={selectedDecision ? "candidate is-selected" : "candidate"}
            aria-pressed={selectedDecision}
            aria-label="Eliminate both nominees"
            onClick={() => setSelectedDecision(true)}
          >
            Eliminate both
          </button>
          <button
            type="button"
            className={!selectedDecision ? "candidate is-selected" : "candidate"}
            aria-pressed={!selectedDecision}
            aria-label="Keep both nominees"
            onClick={() => setSelectedDecision(false)}
          >
            Keep both
          </button>
        </div>

        <div className="voter-grid" aria-label="Eligible voters">
          {activePlayers.map((player) => {
            const assigned = game.carCrashVotes?.[player.seat];
            return (
              <button
                type="button"
                key={player.seat}
                className={assigned === undefined ? "voter" : "voter is-assigned"}
                disabled={assigned !== undefined}
                aria-label={`Assign ${player.name} car-crash vote`}
                onClick={() => {
                  const next = assignCarCrashVote(game, player.seat, selectedDecision);
                  onGameChange(next);
                  onEvent("car-crash.vote-assigned", {
                    voterSeat: player.seat,
                    eliminateBoth: selectedDecision,
                  });
                }}
              >
                <span className="voter-seat">{player.seat}</span>
                <span>{player.name}</span>
                <small>
                  {assigned === undefined
                    ? "Unassigned"
                    : assigned
                      ? "Eliminate both"
                      : "Keep both"}
                </small>
              </button>
            );
          })}
        </div>

        <button
          type="button"
          className="primary-action"
          disabled={!allDecisionVotesAssigned}
          onClick={() => {
            const result = resolveCarCrashVote(game);
            onResolved(game, result.eliminate ? result.seats : []);
            onEvent("car-crash.resolved", {
              eliminate: result.eliminate,
              seats: result.seats,
              yesVotes: result.yesVotes,
              eligibleVoters: result.eligibleVoters,
            });
          }}
        >
          Resolve car crash
        </button>
      </section>
    );
  }

  return (
    <section className="voting-stage">
      <div className="phase-banner vote-banner">Voting · one vote per active player</div>
      <div className="candidate-grid">
        {game.nominations.map(({ candidateSeat, order }) => {
          const player = game.players.find(({ seat }) => seat === candidateSeat)!;
          return (
            <button
              type="button"
              key={candidateSeat}
              className={
                selectedCandidate === candidateSeat ? "candidate is-selected" : "candidate"
              }
              aria-pressed={selectedCandidate === candidateSeat}
              aria-label={`Select candidate ${player.name}`}
              onClick={() => setSelectedCandidate(candidateSeat)}
            >
              <span>#{order}</span>
              <strong>{player.name}</strong>
              <span>{totals[candidateSeat] ?? 0} votes</span>
            </button>
          );
        })}
      </div>

      <div className="voter-grid" aria-label="Eligible voters">
        {activePlayers.map((player) => {
          const assigned = game.voteAssignments[player.seat];
          return (
            <button
              type="button"
              key={player.seat}
              className={assigned === undefined ? "voter" : "voter is-assigned"}
              disabled={selectedCandidate === null || assigned !== undefined}
              aria-label={`Assign ${player.name} vote`}
              onClick={() => {
                if (selectedCandidate === null) return;
                const next = assignVote(game, player.seat, selectedCandidate);
                onGameChange(next);
                onEvent("vote.assigned", {
                  voterSeat: player.seat,
                  candidateSeat: selectedCandidate,
                });
              }}
            >
              <span className="voter-seat">{player.seat}</span>
              <span>{player.name}</span>
              <small>{assigned === undefined ? "Unassigned" : `→ Seat ${assigned}`}</small>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        className="primary-action"
        disabled={!allVotesAssigned}
        onClick={resolve}
      >
        Resolve voting
      </button>
    </section>
  );
};

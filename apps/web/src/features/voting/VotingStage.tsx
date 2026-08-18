import { useEffect, useState } from "react";
import { assignVote, countVotes, resolveVote } from "@mafia/game-domain";
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
  const [tieSeats, setTieSeats] = useState<readonly number[]>([]);
  useEffect(() => setTieSeats([]), [game.voteAssignments]);
  const totals = countVotes(game);
  const activePlayers = game.players.filter(({ status }) => status === "active");
  const allVotesAssigned = Object.keys(game.voteAssignments).length === activePlayers.length;

  const resolve = () => {
    const result = resolveVote(game);
    if (result.kind === "tie") {
      onEvent("voting.resolved", { kind: result.kind, seats: result.seats, totals: result.totals });
      setTieSeats(result.seats);
      return;
    }
    onResolved(game, result.seats);
    onEvent("voting.resolved", { kind: result.kind, seats: result.seats, totals: result.totals });
  };

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

      {tieSeats.length > 0 ? (
        <div className="tie-notice" role="status">
          Tie between seats {tieSeats.join(" and ")}. The configured tie round is required.
        </div>
      ) : null}

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

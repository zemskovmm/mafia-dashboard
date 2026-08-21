import { useState } from "react";
import {
  advanceVotingCandidate,
  assignCarCrashVote,
  assignVote,
  beginCarCrash,
  beginCarCrashDecision,
  countVotes,
  getCurrentVotingCandidateSeat,
  resolveCarCrashVote,
  resolveVote,
} from "@mafia/game-domain";
import type { GameState } from "@mafia/game-domain";
import { GameTable } from "../table/GameTable.js";

interface VotingStageProps {
  readonly game: GameState;
  readonly onGameChange: (game: GameState) => void;
  readonly onResolved: (game: GameState, seats: readonly number[]) => void;
  readonly onEvent: (type: string, payload: Record<string, unknown>) => void;
  readonly hostName?: string;
  readonly privacyHidden?: boolean;
}

export const VotingStage = ({
  game,
  onGameChange,
  onResolved,
  onEvent,
  hostName = "Host",
  privacyHidden = false,
}: VotingStageProps) => {
  const [selectedDecision, setSelectedDecision] = useState(true);
  const totals = countVotes(game);
  const activePlayers = game.players.filter(({ status }) => status === "active");
  const allVotesAssigned = activePlayers.every(
    ({ seat }) => game.voteAssignments[seat] !== undefined,
  );
  const allDecisionVotesAssigned = activePlayers.every(
    ({ seat }) => game.carCrashVotes?.[seat] !== undefined,
  );
  const selectedCandidate = game.phase === "voting" ? getCurrentVotingCandidateSeat(game) : null;
  const selectedCandidateIndex = game.phase === "voting" ? game.currentTurnIndex : -1;

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
      <GameTable
        hostName={hostName}
        privacyHidden={privacyHidden}
        seats={game.players.map((player) => ({
          ...player,
          current: game.carCrashSeats?.includes(player.seat),
          inactive:
            !game.carCrashSeats?.includes(player.seat) ||
            game.carCrashVotes?.[player.seat] !== undefined,
        }))}
        seatActionLabel={(seat) => {
          const assigned = game.carCrashVotes?.[seat.seat];
          return assigned === undefined
            ? `Vote as ${seat.name} to ${selectedDecision ? "eliminate" : "keep"} both nominees`
            : `${seat.name} voted to ${assigned ? "eliminate" : "keep"} both nominees`;
        }}
        onSeatClick={(voterSeat) => {
          if (game.carCrashVotes?.[voterSeat] !== undefined) return;
          const next = assignCarCrashVote(game, voterSeat, selectedDecision);
          onGameChange(next);
          onEvent("car-crash.vote-assigned", { voterSeat, eliminateBoth: selectedDecision });
        }}
        center={
          <div className="table-vote-center" role="group" aria-label="Car-crash decision">
            <span className="table-prompt">Car crash</span>
            <strong>{nominees}</strong>
            <div className="table-choice-actions">
              <button
                type="button"
                className={selectedDecision ? "is-selected" : ""}
                aria-pressed={selectedDecision}
                aria-label="Eliminate both nominees"
                onClick={() => setSelectedDecision(true)}
              >
                Eliminate both
              </button>
              <button
                type="button"
                className={!selectedDecision ? "is-selected" : ""}
                aria-pressed={!selectedDecision}
                aria-label="Keep both nominees"
                onClick={() => setSelectedDecision(false)}
              >
                Keep both
              </button>
            </div>
            <button
              type="button"
              className="table-center-primary"
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
          </div>
        }
      />
    );
  }

  const candidate = game.players.find(({ seat }) => seat === selectedCandidate);
  return (
    <GameTable
      hostName={hostName}
      privacyHidden={privacyHidden}
      seats={game.players.map((player) => ({
        ...player,
        current: player.seat === selectedCandidate,
        inactive: game.voteAssignments[player.seat] !== undefined,
        voteTargetSeat: game.voteAssignments[player.seat],
      }))}
      seatActionLabel={(seat) => {
        const assigned = game.voteAssignments[seat.seat];
        if (assigned !== undefined) return `${seat.name} voted for seat ${assigned}`;
        if (candidate === undefined) return `Seat ${seat.seat}: ${seat.name}`;
        return `Vote as ${seat.name} for ${candidate.name}`;
      }}
      onSeatClick={(voterSeat) => {
        if (candidate === undefined || game.voteAssignments[voterSeat] !== undefined) return;
        const next = assignVote(game, voterSeat, candidate.seat);
        onGameChange(next);
        onEvent("vote.assigned", { voterSeat, candidateSeat: candidate.seat });
      }}
      center={
        <div className="table-vote-center" role="group" aria-label="Voting candidate">
          <span className="table-prompt">
            Candidate {selectedCandidateIndex + 1} of {game.nominations.length}
          </span>
          <strong>{candidate?.name ?? "No candidate"}</strong>
          <span>{selectedCandidate === null ? 0 : (totals[selectedCandidate] ?? 0)} votes</span>
          <div className="candidate-navigation">
            <button
              type="button"
              aria-label="Next candidate"
              disabled={
                selectedCandidateIndex < 0 || selectedCandidateIndex >= game.nominations.length - 1
              }
              onClick={() => {
                const next = advanceVotingCandidate(game);
                const autoAssignedVoterSeats = activePlayers
                  .filter(
                    ({ seat }) =>
                      game.voteAssignments[seat] === undefined &&
                      next.voteAssignments[seat] !== undefined,
                  )
                  .map(({ seat }) => seat);
                onGameChange(next);
                onEvent("voting.candidate-advanced", {
                  candidateSeat: getCurrentVotingCandidateSeat(next),
                  autoAssignedVoterSeats,
                });
              }}
            >
              Next
            </button>
          </div>
          <button
            type="button"
            className="table-center-primary"
            disabled={!allVotesAssigned}
            onClick={resolve}
          >
            Resolve voting
          </button>
        </div>
      }
    />
  );
};

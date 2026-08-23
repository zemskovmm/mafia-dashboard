import { useState } from "react";
import {
  advanceVotingCandidate,
  assignCarCrashVote,
  assignVote,
  beginCarCrash,
  beginCarCrashDecision,
  beginNight,
  beginSkippedCarCrashDecision,
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
  const carCrashSeatSet = new Set(game.carCrashSeats ?? []);
  const allActivePlayersTied =
    carCrashSeatSet.size === activePlayers.length &&
    activePlayers.every(({ seat }) => carCrashSeatSet.has(seat));
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
    if (result.kind === "eliminate-all-skipped") {
      onGameChange(beginSkippedCarCrashDecision(game, result.seats));
      onEvent("voting.resolved", { kind: result.kind, seats: result.seats, totals: result.totals });
      return;
    }
    onResolved(game, result.seats);
    onEvent("voting.resolved", { kind: result.kind, seats: result.seats, totals: result.totals });
  };

  if (
    game.phase === "car-crash-skipped" ||
    (game.phase === "car-crash-decision" && allActivePlayersTied)
  ) {
    return (
      <GameTable
        hostName={hostName}
        privacyHidden={privacyHidden}
        seats={game.players.map((player) => ({
          ...player,
          current: game.carCrashSeats?.includes(player.seat),
          inactive: player.status !== "active",
        }))}
        center={
          <div className="table-vote-center" role="status" aria-label="Car-crash result">
            <span className="table-prompt">Car crash</span>
            <strong>Eliminate-all vote skipped</strong>
            <span className="car-crash-skip-message">
              All active players are tied. Eliminating everyone would leave no way to determine a
              winner.
            </span>
          </div>
        }
        advance={
          <button
            type="button"
            onClick={() => {
              const next = beginNight(game);
              onGameChange(next);
              onEvent("phase.changed", { from: game.phase, to: next.phase });
            }}
          >
            Begin night
          </button>
        }
      />
    );
  }

  if (game.phase === "car-crash-decision") {
    const carCrashSeats = game.carCrashSeats ?? [];
    const collective = carCrashSeats.length > 2 ? "all" : "both";
    const nominees = carCrashSeats
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
            ? `Vote as ${seat.name} to ${selectedDecision ? "eliminate" : "keep"} ${collective} nominees`
            : `${seat.name} voted to ${assigned ? "eliminate" : "keep"} ${collective} nominees`;
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
                aria-label={`Eliminate ${collective} nominees`}
                onClick={() => setSelectedDecision(true)}
              >
                Eliminate {collective}
              </button>
              <button
                type="button"
                className={!selectedDecision ? "is-selected" : ""}
                aria-pressed={!selectedDecision}
                aria-label={`Keep ${collective} nominees`}
                onClick={() => setSelectedDecision(false)}
              >
                Keep {collective}
              </button>
            </div>
          </div>
        }
        advance={
          <div className="table-advance-options">
            <button
              type="button"
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
            <button
              type="button"
              className="table-advance-secondary"
              onClick={() => {
                const next = beginNight(game);
                onGameChange(next);
                onEvent("voting.skipped", { day: game.day });
              }}
            >
              Skip voting
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
        </div>
      }
      advance={
        <div className="table-advance-options">
          {selectedCandidateIndex >= 0 && selectedCandidateIndex < game.nominations.length - 1 ? (
            <button
              type="button"
              aria-label="Next candidate"
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
              Next candidate
            </button>
          ) : (
            <button type="button" disabled={!allVotesAssigned} onClick={resolve}>
              Resolve voting
            </button>
          )}
          <button
            type="button"
            className="table-advance-secondary"
            onClick={() => {
              const next = beginNight(game);
              onGameChange(next);
              onEvent("voting.skipped", { day: game.day });
            }}
          >
            Skip voting
          </button>
        </div>
      }
    />
  );
};

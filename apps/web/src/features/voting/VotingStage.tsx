import { useState, type ReactNode } from "react";
import {
  acceptCarCrashBallot,
  advanceVotingCandidate,
  beginCarCrash,
  beginCarCrashDecision,
  beginNight,
  beginSkippedCarCrashDecision,
  completeCarCrashResult,
  countVotes,
  getCurrentVotingCandidateSeat,
  resolveCarCrashVote,
  resolveVote,
  skipVoting,
  toggleVote,
} from "@mafia/game-domain";
import type { CanonicalGameEventDraft, GameState } from "@mafia/game-domain";
import { GameTable, type TableSeatView } from "../table/GameTable.js";

interface VotingStageProps {
  readonly game: GameState;
  readonly onGameChange: (game: GameState) => void;
  readonly onResolved: (game: GameState, seats: readonly number[]) => void;
  readonly onEvent: (type: string, payload: Record<string, unknown>) => void;
  readonly onAcceptedEvent?: (event: CanonicalGameEventDraft) => void;
  readonly hostName?: string;
  readonly privacyHidden?: boolean;
  readonly onSeatSwipe?: (seat: number) => void;
  readonly swipeAction?: ReactNode;
  readonly onFoul?: (seat: number) => void;
}

export const VotingStage = ({
  game,
  onGameChange,
  onResolved,
  onEvent,
  onAcceptedEvent,
  hostName = "Host",
  privacyHidden = false,
  onSeatSwipe,
  swipeAction,
  onFoul,
}: VotingStageProps) => {
  const [, setSelectedVoterSeat] = useState<number | null>(null);
  const totals = countVotes(game);
  const activePlayers = game.players.filter(({ status }) => status === "active");
  const allVotesAssigned = activePlayers.every(
    ({ seat }) => game.voteAssignments[seat] !== undefined,
  );

  const carCrashSeatSet = new Set(game.carCrashSeats ?? []);
  const allActivePlayersTied =
    carCrashSeatSet.size === activePlayers.length &&
    activePlayers.every(({ seat }) => carCrashSeatSet.has(seat));
  const selectedCandidate = game.phase === "voting" ? getCurrentVotingCandidateSeat(game) : null;
  const selectedCandidateIndex = game.phase === "voting" ? game.currentTurnIndex : -1;
  const renderFoulAction = (seat: TableSeatView) =>
    seat.status === "active" && onFoul !== undefined ? (
      <button type="button" aria-label={`Foul ${seat.name}`} onClick={() => onFoul(seat.seat)}>
        Foul
      </button>
    ) : null;

  const beginNightFromAcceptedState = () => {
    if (onAcceptedEvent !== undefined) {
      onAcceptedEvent({
        type: "phase.changed",
        payload: { to: "night-mafia" },
      });
      return;
    }
    const next = beginNight(game);
    onGameChange(next);
    onEvent("phase.changed", { from: game.phase, to: next.phase });
  };

  const skipVotingAsAcceptedState = () => {
    if (onAcceptedEvent !== undefined) {
      onAcceptedEvent({
        type: "voting.skipped",
        payload: { reason: "host-skipped" },
      });
      return;
    }
    const next = skipVoting(game);
    onGameChange(next);
    onEvent("voting.skipped", { day: game.day, reason: "host-skipped" });
  };

  const resolve = () => {
    const result = resolveVote(game);
    if (onAcceptedEvent !== undefined) {
      const voteAssignments = Object.fromEntries(
        Object.entries(game.voteAssignments).flatMap(([seat, candidateSeat]) =>
          candidateSeat === undefined ? [] : [[Number(seat), candidateSeat]],
        ),
      );
      onAcceptedEvent({
        type: "voting.resolved",
        payload: { voteAssignments, result },
      });
      return;
    }
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

  if (game.phase === "voting-cancelled") {
    const cancellationMessage =
      game.votingCancellation?.reason === "red-card"
        ? "A player received a red card, so voting is cancelled for this day."
        : "Voting was skipped by the host.";
    return (
      <GameTable
        hostName={hostName}
        privacyHidden={privacyHidden}
        onSeatSwipe={onSeatSwipe}
        swipeAction={swipeAction}
        seats={game.players.map((player) => ({
          ...player,
          inactive: player.status !== "active",
        }))}
        renderSeatActions={renderFoulAction}
        center={
          <div className="table-vote-center" role="status" aria-label="Voting cancelled">
            <span className="table-prompt">Voting</span>
            <strong>Voting cancelled</strong>
            <span className="voting-cancellation-message">{cancellationMessage}</span>
          </div>
        }
        advance={
          <button type="button" onClick={beginNightFromAcceptedState}>
            Begin night
          </button>
        }
      />
    );
  }

  if (
    game.phase === "car-crash-skipped" ||
    (game.phase === "car-crash-decision" && allActivePlayersTied)
  ) {
    return (
      <GameTable
        hostName={hostName}
        privacyHidden={privacyHidden}
        onSeatSwipe={onSeatSwipe}
        swipeAction={swipeAction}
        seats={game.players.map((player) => ({
          ...player,
          current: game.carCrashSeats?.includes(player.seat),
          inactive: player.status !== "active",
        }))}
        renderSeatActions={renderFoulAction}
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
          <button type="button" onClick={beginNightFromAcceptedState}>
            Begin night
          </button>
        }
      />
    );
  }

  if (game.phase === "car-crash-decision") {
    const carCrashSeats = game.carCrashSeats ?? [];
    const nominees = carCrashSeats
      .map((seat) => game.players.find((player) => player.seat === seat)?.name ?? `Seat ${seat}`)
      .join(" and ");
    return (
      <GameTable
        hostName={hostName}
        privacyHidden={privacyHidden}
        onSeatSwipe={onSeatSwipe}
        swipeAction={swipeAction}
        seats={game.players.map((player) => ({
          ...player,
          current: game.carCrashSeats?.includes(player.seat),
          votingHighlight: game.carCrashVotes?.[player.seat] === true,
          inactive: player.status !== "active",
        }))}
        renderSeatActions={renderFoulAction}
        seatActionDisabled={(seat) => seat.status !== "active"}
        seatActionLabel={(seat) => {
          const selected = game.carCrashVotes?.[seat.seat] === true;
          return selected
            ? `Remove ${seat.name}'s eliminate-all vote`
            : `Vote as ${seat.name} to eliminate all car-crash players`;
        }}
        onSeatClick={(voterSeat) => {
          const player = game.players.find(({ seat }) => seat === voterSeat);
          if (player?.status !== "active") return;
          const votes = { ...game.carCrashVotes };
          if (votes[voterSeat] === true) delete votes[voterSeat];
          else votes[voterSeat] = true;
          setSelectedVoterSeat(votes[voterSeat] === true ? voterSeat : null);
          onGameChange({ ...game, carCrashVotes: votes });
        }}
        center={
          <div className="table-vote-center" role="group" aria-label="Car-crash decision">
            <span className="table-prompt">Car crash</span>
            <strong>{nominees}</strong>
            <span>Eliminate all players voting</span>
            <span>{Object.values(game.carCrashVotes ?? {}).filter(Boolean).length} votes</span>
          </div>
        }
        advance={
          <div className="table-advance-options">
            <button
              type="button"
              onClick={() => {
                const votes = Object.fromEntries(
                  game.players
                    .filter(({ status }) => status === "active")
                    .map(({ seat }) => [seat, game.carCrashVotes?.[seat] === true]),
                );
                const acceptedGame = { ...game, carCrashVotes: votes };
                const result = resolveCarCrashVote(acceptedGame);
                if (onAcceptedEvent !== undefined) {
                  onAcceptedEvent({
                    type: "car-crash.ballot-resolved",
                    payload: { votes, result },
                  });
                } else {
                  onGameChange(acceptCarCrashBallot(acceptedGame));
                  onEvent("car-crash.ballot-resolved", {
                    votes,
                    eliminate: result.eliminate,
                    seats: result.seats,
                    yesVotes: result.yesVotes,
                    eligibleVoters: result.eligibleVoters,
                  });
                }
              }}
            >
              Resolve car crash
            </button>
            <button
              type="button"
              className="table-advance-secondary"
              onClick={skipVotingAsAcceptedState}
            >
              Skip voting
            </button>
          </div>
        }
      />
    );
  }

  if (game.phase === "car-crash-result" && game.carCrashResult !== undefined) {
    const result = game.carCrashResult;
    const names = result.seats
      .map((seat) => game.players.find((player) => player.seat === seat)?.name ?? `Seat ${seat}`)
      .join(" and ");
    return (
      <GameTable
        hostName={hostName}
        privacyHidden={privacyHidden}
        seats={game.players.map((player) => ({
          ...player,
          current: result.seats.includes(player.seat),
          provisionalDeceased: result.eliminate && result.seats.includes(player.seat),
        }))}
        renderSeatActions={renderFoulAction}
        center={
          <div className="table-vote-center" role="status" aria-label="Car-crash result">
            <span className="table-prompt">Car crash result</span>
            <strong>{result.eliminate ? "Eliminated" : "Players stay"}</strong>
            <span>{names}</span>
            <span>
              {result.yesVotes} of {result.eligibleVoters} eliminate votes
            </span>
          </div>
        }
        advance={
          <button
            type="button"
            onClick={() => {
              const next = completeCarCrashResult(game);
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
            Continue
          </button>
        }
      />
    );
  }

  const candidate = game.players.find(({ seat }) => seat === selectedCandidate);
  return (
    <GameTable
      hostName={hostName}
      privacyHidden={privacyHidden}
      onSeatSwipe={onSeatSwipe}
      swipeAction={swipeAction}
      seats={game.players.map((player) => ({
        ...player,
        current: player.seat === selectedCandidate,
        votingHighlight: game.voteAssignments[player.seat] === selectedCandidate,
        inactive: game.voteAssignments[player.seat] !== undefined,
        voteTargetSeat: game.voteAssignments[player.seat],
      }))}
      renderSeatActions={renderFoulAction}
      seatActionLabel={(seat) => {
        const assigned = game.voteAssignments[seat.seat];
        if (assigned !== undefined) return `${seat.name} voted for seat ${assigned}`;
        if (candidate === undefined) return `Seat ${seat.seat}: ${seat.name}`;
        return `Vote as ${seat.name} for ${candidate.name}`;
      }}
      onSeatClick={(voterSeat) => {
        if (candidate === undefined) return;
        const assignedCandidateSeat = game.voteAssignments[voterSeat];
        if (assignedCandidateSeat !== undefined && assignedCandidateSeat !== candidate.seat) return;
        const removingVote = assignedCandidateSeat === candidate.seat;
        const next = toggleVote(game, voterSeat, candidate.seat);
        setSelectedVoterSeat(removingVote ? null : voterSeat);
        onGameChange(next);
      }}
      center={
        <div className="table-vote-center" role="group" aria-label="Voting candidate">
          <span className="table-prompt">
            Candidate {selectedCandidateIndex + 1} of {game.nominations.length}
          </span>
          <strong>
            {candidate === undefined ? "No candidate" : `#${candidate.seat} ${candidate.name}`}
          </strong>
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
                setSelectedVoterSeat(null);
                onGameChange(next);
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
            onClick={skipVotingAsAcceptedState}
          >
            Skip voting
          </button>
        </div>
      }
    />
  );
};

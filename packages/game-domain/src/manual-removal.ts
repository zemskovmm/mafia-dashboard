import { completeDay } from "./day-actions.js";
import { createFederationBallot, getCollectiveLiftEligibility } from "./federation-actions.js";
import { evaluateVictory, isTerminalGamePhase, markPlayerInactive } from "./game.js";
import { isNightCheckEligible } from "./night-actions.js";
import { transitionToNight } from "./night-transition.js";
import type { GameState, ManualRemoval } from "./types.js";

export const assertManualRemoval = (removal: ManualRemoval): void => {
  if (!Number.isInteger(removal.seat) || removal.seat < 1 || removal.seat > 10)
    throw new Error("Manual removal seat must be 1–10");
  if (!["voted-out", "mafia-kill", "other"].includes(removal.reason))
    throw new Error("Manual removal requires Voted out, Killed by Mafia or Other");
};

/** A correction of participation, never a disciplinary ruling or invented vote/shot. */
export const manuallyRemovePlayer = (game: GameState, removal: ManualRemoval): GameState => {
  if (isTerminalGamePhase(game.phase))
    throw new Error("A terminal game cannot accept manual removal");
  assertManualRemoval(removal);
  if (game.manualRemovals?.some((entry) => entry.seat === removal.seat))
    throw new Error("This player has already been manually removed");
  const changed = markPlayerInactive(game, removal.seat, "eliminated");
  let next: GameState = {
    ...changed,
    manualRemovals: [
      ...(game.manualRemovals ?? []),
      { seat: removal.seat, reason: removal.reason },
    ],
  };
  // Older checkpoints can lack the current-night entitlement snapshot. Capture
  // the existing eligibility, not a disqualification of the now-eliminated owner.
  if (game.phase.startsWith("night-") && game.nightCheckEligibility === undefined)
    next = {
      ...next,
      nightCheckEligibility: {
        don: isNightCheckEligible(game, "don"),
        sheriff: isNightCheckEligible(game, "sheriff"),
      },
    };

  // Accepted result screens settle atomically on Continue, just as with existing
  // disciplinary corrections. Never finish at transient parity before that kill
  // or the rest of an accepted collective departure has been applied.
  const pendingBoundary =
    game.phase === "night-mafia-result" ||
    game.phase === "car-crash-result" ||
    game.disciplinaryRemovals?.some(
      (entry) => entry.departure === "pending" || entry.checkCompletionPending,
    );
  const winner = evaluateVictory(next.players);
  if (winner !== null && !pendingBoundary)
    return {
      ...next,
      phase: "finished",
      winner,
      ballot: undefined,
      goodbyeSeats: undefined,
      goodbyeNext: undefined,
    };

  const pendingCandidates = ["day", "voting", "car-crash", "car-crash-decision"].includes(
    game.phase,
  );
  if (pendingCandidates)
    next = {
      ...next,
      nominations: game.nominations
        .filter((entry) => entry.candidateSeat !== removal.seat)
        .map((entry, index) => ({ ...entry, order: index + 1 })),
    };

  if (
    game.phase === "day" ||
    game.phase === "voting" ||
    game.phase === "car-crash" ||
    game.phase === "car-crash-decision" ||
    (game.phase === "goodbye-speech" && game.goodbyeNext === "day")
  ) {
    const removedIndex = game.turnOrder.indexOf(removal.seat);
    const turnOrder = game.turnOrder.filter((seat) => seat !== removal.seat);
    const currentTurnIndex =
      game.currentTurnIndex - (removedIndex >= 0 && removedIndex < game.currentTurnIndex ? 1 : 0);
    next = {
      ...next,
      turnOrder,
      currentTurnIndex:
        game.phase === "car-crash-decision"
          ? Math.max(0, Math.min(currentTurnIndex, turnOrder.length - 1))
          : currentTurnIndex,
      ...(removedIndex === game.currentTurnIndex &&
      (game.phase === "day" || game.phase === "goodbye-speech")
        ? {
            currentSpeechRestricted:
              next.players.find((p) => p.seat === turnOrder[currentTurnIndex])?.mutePending ??
              false,
          }
        : {}),
    };

    if (game.phase === "day")
      return currentTurnIndex >= turnOrder.length ? completeDay(next) : next;

    if (game.phase === "car-crash") {
      if (!turnOrder.length) return transitionToNight(next);
      next = { ...next, carCrashSeats: turnOrder };
      return currentTurnIndex >= turnOrder.length
        ? {
            ...next,
            phase: "voting",
            currentTurnIndex: 0,
            voteAssignments: {},
            votingRound: "repeat",
            ballot: createFederationBallot(turnOrder[0]!),
          }
        : next;
    }

    if (game.phase === "voting") {
      if (!turnOrder.length) return transitionToNight(next);
      const ballot = game.ballot!;
      const index = Math.min(currentTurnIndex, turnOrder.length - 1);
      const acceptedCandidateSeats = ballot.acceptedCandidateSeats.filter(
        (seat) => seat !== removal.seat,
      );
      const replacementAccepted = acceptedCandidateSeats.includes(turnOrder[index]!);
      const selectedIndex = game.turnOrder.indexOf(ballot.selectedCandidateSeat);
      next = {
        ...next,
        currentTurnIndex: index,
        voteAssignments: Object.fromEntries(
          Object.entries(game.voteAssignments).filter(
            ([voter, candidate]) => Number(voter) !== removal.seat && candidate !== removal.seat,
          ),
        ),
        ...(game.carCrashSeats
          ? { carCrashSeats: game.carCrashSeats.filter((seat) => seat !== removal.seat) }
          : {}),
        ballot: {
          ...ballot,
          acceptedCandidateSeats,
          selectedCandidateSeat:
            ballot.selectedCandidateSeat === removal.seat
              ? turnOrder[Math.min(selectedIndex, turnOrder.length - 1)]!
              : ballot.selectedCandidateSeat,
          reviewedCandidateSeats: ballot.reviewedCandidateSeats.filter(
            (seat) => seat !== removal.seat,
          ),
          ...(removedIndex === game.currentTurnIndex
            ? {
                mention: replacementAccepted ? 2 : 0,
                stopped: replacementAccepted,
              }
            : {}),
          ...(ballot.dispute?.candidateSeat === removal.seat ? { dispute: undefined } : {}),
          ...(ballot.finalRuling?.candidateSeat === removal.seat ? { finalRuling: undefined } : {}),
        },
      };
    }
  }

  if (game.phase === "car-crash-decision") {
    const carCrashSeats = game.carCrashSeats?.filter((seat) => seat !== removal.seat) ?? [];
    next = {
      ...next,
      carCrashSeats,
      carCrashVotes: Object.fromEntries(
        Object.entries(game.carCrashVotes ?? {}).filter(
          ([voter]) => Number(voter) !== removal.seat,
        ),
      ),
    };
    if (carCrashSeats.length < 2) return transitionToNight(next);
    const eligibility = getCollectiveLiftEligibility(next, carCrashSeats);
    if (!eligibility.permitted)
      return { ...next, phase: "car-crash-skipped", ballotSkipReason: eligibility.reason };
  }
  return next;
};

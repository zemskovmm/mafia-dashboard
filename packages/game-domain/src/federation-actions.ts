import { isCasperPlayer } from "./casper.js";
import { evaluateVictory, isTerminalGamePhase } from "./game.js";
import type {
  BestMoveCompletionReason,
  CollectiveLiftSkipReason,
  FederationBallot,
  GameState,
  OpponentVictoryAdjudication,
  ShotObservation,
} from "./types.js";
export const assertFederationAction = (game: GameState): void => {
  if (isTerminalGamePhase(game.phase))
    throw new Error("A terminal game cannot accept more actions");
};
export const assertJudgeReason = (reason: string): void => {
  if (
    typeof reason !== "string" ||
    reason.length === 0 ||
    reason !== reason.trim() ||
    reason.length > 500
  )
    throw new Error("A judge reason must be trimmed and contain 1–500 characters");
};
const requireSeat = (game: GameState, seat: number) => {
  const player = game.players.find((p) => p.seat === seat);
  if (!Number.isInteger(seat) || !player) throw new Error("Seat must identify a seated player");
  return player;
};
export const requireFederationBallot = (game: GameState): FederationBallot => {
  assertFederationAction(game);
  if (game.phase !== "voting" || !game.ballot)
    throw new Error("An ordered open ballot is required");
  if (game.ballot.dispute)
    throw new Error("A disputed ballot is paused pending external review and final ruling");
  return game.ballot;
};
export const createFederationBallot = (candidateSeat: number): FederationBallot => ({
  orderAnnouncements: 0,
  mention: 0,
  stopped: false,
  selectedCandidateSeat: candidateSeat,
  acceptedCandidateSeats: [],
  reviewedCandidateSeats: [],
});
export const announceVotingOrder = (game: GameState): GameState => {
  const ballot = requireFederationBallot(game);
  if (ballot.orderAnnouncements === 2 || ballot.mention !== 0)
    throw new Error("The full order is announced exactly twice before live calls");
  return {
    ...game,
    ballot: { ...ballot, orderAnnouncements: ballot.orderAnnouncements === 0 ? 1 : 2 },
  };
};
export const mentionVotingCandidate = (game: GameState): GameState => {
  const ballot = requireFederationBallot(game);
  if (ballot.orderAnnouncements !== 2 || ballot.mention === 2 || ballot.stopped)
    throw new Error("A candidate needs two ordered mentions before vote acceptance");
  const mention = ballot.mention === 0 ? 1 : 2;
  let voteAssignments = game.voteAssignments;
  if (mention === 2 && game.currentTurnIndex === game.turnOrder.length - 1) {
    const last = game.turnOrder[game.currentTurnIndex]!;
    voteAssignments = { ...voteAssignments };
    for (const player of game.players)
      if (player.status === "active" && voteAssignments[player.seat] === undefined)
        voteAssignments = { ...voteAssignments, [player.seat]: last };
  }
  return { ...game, voteAssignments, ballot: { ...ballot, mention } };
};
export const stopVotingCandidate = (game: GameState): GameState => {
  const ballot = requireFederationBallot(game);
  if (ballot.mention !== 2 || ballot.stopped)
    throw new Error("STOP requires the second live mention and an open acceptance window");
  const candidate = game.turnOrder[game.currentTurnIndex]!;
  return {
    ...game,
    ballot: {
      ...ballot,
      stopped: true,
      acceptedCandidateSeats: [...ballot.acceptedCandidateSeats, candidate],
    },
  };
};
export const acceptFederationVote = (
  game: GameState,
  voterSeat: number,
  candidateSeat: number,
): GameState => {
  const ballot = requireFederationBallot(game);
  if (
    ballot.mention !== 2 ||
    ballot.stopped ||
    game.turnOrder[game.currentTurnIndex] !== candidateSeat
  )
    throw new Error("Votes are accepted only for the live second-mentioned candidate before STOP");
  if (requireSeat(game, voterSeat).status !== "active")
    throw new Error("Only active voters may vote");
  if (game.voteAssignments[voterSeat] !== undefined)
    throw new Error(
      "An accepted vote cannot be recast; record an explicit transcription correction",
    );
  return { ...game, voteAssignments: { ...game.voteAssignments, [voterSeat]: candidateSeat } };
};
export const inspectFederationCandidate = (game: GameState, candidateSeat: number): GameState => {
  assertFederationAction(game);
  if (game.phase !== "voting" || !game.ballot || !game.turnOrder.includes(candidateSeat))
    throw new Error("Inspection requires a ballot candidate");
  return { ...game, ballot: { ...game.ballot, selectedCandidateSeat: candidateSeat } };
};
export const selectHostVotingCandidate = (game: GameState, candidateSeat: number): GameState => {
  const ballot = requireFederationBallot(game);
  if (!game.turnOrder.includes(candidateSeat)) throw new Error("Select a ballot candidate");
  const voteAssignments = { ...game.voteAssignments };
  if (
    candidateSeat === game.turnOrder.at(-1) &&
    !ballot.reviewedCandidateSeats.includes(candidateSeat)
  ) {
    for (const player of game.players)
      if (player.status === "active" && voteAssignments[player.seat] === undefined)
        voteAssignments[player.seat] = candidateSeat;
  }
  return {
    ...game,
    voteAssignments,
    ballot: { ...ballot, hostRecording: true, selectedCandidateSeat: candidateSeat },
  };
};
export const recordHostVote = (
  game: GameState,
  voterSeat: number,
  candidateSeat: number | null,
): GameState => {
  const ballot = requireFederationBallot(game);
  if (
    ballot.reviewedCandidateSeats.some(
      (seat) => seat === candidateSeat || seat === game.voteAssignments[voterSeat],
    )
  )
    throw new Error("A reviewed judge ruling is final; use authorized history correction");
  if (requireSeat(game, voterSeat).status !== "active")
    throw new Error("Only active voters may vote");
  if (candidateSeat !== null && candidateSeat !== ballot.selectedCandidateSeat)
    throw new Error("A recorded vote must target the selected ballot candidate");
  const voteAssignments = { ...game.voteAssignments };
  if (candidateSeat === null) delete voteAssignments[voterSeat];
  else voteAssignments[voterSeat] = candidateSeat;
  return { ...game, voteAssignments, ballot: { ...ballot, hostRecording: true } };
};
export const advanceFederationCandidate = (game: GameState): GameState => {
  const ballot = requireFederationBallot(game);
  if (!ballot.stopped || game.currentTurnIndex >= game.turnOrder.length - 1)
    throw new Error("Finish the live candidate with STOP before advancing in order");
  const currentTurnIndex = game.currentTurnIndex + 1;
  return {
    ...game,
    currentTurnIndex,
    ballot: {
      ...ballot,
      mention: 0,
      stopped: false,
      selectedCandidateSeat: game.turnOrder[currentTurnIndex]!,
    },
  };
};
export const validateFederationVotes = (
  game: GameState,
  assignments: Readonly<Partial<Record<number, number>>>,
): void => {
  for (const [key, candidate] of Object.entries(assignments)) {
    const seat = Number(key);
    if (
      String(seat) !== key ||
      requireSeat(game, seat).status !== "active" ||
      !game.turnOrder.includes(candidate!)
    )
      throw new Error("Vote assignment is not eligible in this ballot");
  }
};
export const correctAcceptedVote = (
  game: GameState,
  voterSeat: number,
  candidateSeat: number | null,
  reason: string,
): GameState => {
  const ballot = requireFederationBallot(game);
  if (ballot.mention !== 2 && ballot.acceptedCandidateSeats.length === 0)
    throw new Error("A transcription correction requires an actually opened acceptance window");
  assertJudgeReason(reason);
  if (requireSeat(game, voterSeat).status !== "active")
    throw new Error("A correction requires an eligible voter");
  if (candidateSeat !== null && !game.turnOrder.includes(candidateSeat))
    throw new Error("A correction requires a ballot candidate");
  const assignments = { ...game.voteAssignments };
  if (candidateSeat === null) delete assignments[voterSeat];
  else assignments[voterSeat] = candidateSeat;
  return { ...game, voteAssignments: assignments };
};
export const disputeVotingCount = (
  game: GameState,
  candidateSeat: number,
  reason: string,
): GameState => {
  const ballot = requireFederationBallot(game);
  assertJudgeReason(reason);
  if (
    !game.turnOrder.includes(candidateSeat) ||
    (!ballot.hostRecording &&
      (!game.turnOrder.slice(0, game.currentTurnIndex + 1).includes(candidateSeat) ||
        (game.turnOrder[game.currentTurnIndex] === candidateSeat && ballot.mention !== 2)))
  )
    throw new Error("Only an actually called count can be disputed");
  if (ballot.reviewedCandidateSeats.includes(candidateSeat))
    throw new Error("A reviewed judge ruling is final for ordinary appeals");
  return { ...game, ballot: { ...ballot, dispute: { candidateSeat, reason } } };
};
export const ruleOnVotingDispute = (
  game: GameState,
  assignments: Readonly<Record<number, number>>,
  externalReviewAcknowledged: boolean,
  reason: string,
): GameState => {
  assertFederationAction(game);
  if (game.phase !== "voting" || !game.ballot?.dispute)
    throw new Error("A pending count dispute is required");
  if (externalReviewAcknowledged !== true)
    throw new Error("The judge must acknowledge external recording review");
  assertJudgeReason(reason);
  validateFederationVotes(game, assignments);
  const candidateSeat = game.ballot.dispute.candidateSeat;
  return {
    ...game,
    voteAssignments: { ...assignments },
    ballot: {
      ...game.ballot,
      dispute: undefined,
      reviewedCandidateSeats: [...game.ballot.reviewedCandidateSeats, candidateSeat],
      finalRuling: { candidateSeat, reason, externalReviewAcknowledged: true },
    },
  };
};
export const getCollectiveLiftEligibility = (
  game: GameState,
  seats: readonly number[],
):
  | {
      readonly permitted: true;
    }
  | {
      readonly permitted: false;
      readonly reason: CollectiveLiftSkipReason;
    } => {
  const active = game.players.filter((p) => p.status === "active").length;
  if (seats.length === active) return { permitted: false, reason: "all-active" };
  if (game.day === 1 && seats.length === 5) return { permitted: false, reason: "zero-round-five" };
  if (
    active === 9 &&
    seats.length === 3 &&
    !(game.completedGameNights >= 3 && game.sheriffChecksPerformed >= 2)
  )
    return { permitted: false, reason: "nine-three-restricted" };
  return { permitted: true };
};
export const recordActualMultipleShot = (game: GameState, shooterSeat: number): GameState => {
  assertFederationAction(game);
  const shooter = requireSeat(game, shooterSeat);
  if (game.phase !== "night-mafia" || shooter.status !== "active" || shooter.team !== "black")
    throw new Error("Multiple-shot observation requires an eligible shooter during shooting");
  if (game.actualMultipleShotSeats?.includes(shooterSeat))
    throw new Error("Multiple-shot observation is already recorded");
  return {
    ...game,
    actualMultipleShotSeats: [...(game.actualMultipleShotSeats ?? []), shooterSeat],
  };
};
export const recordShotObservations = (
  game: GameState,
  observations: readonly Pick<ShotObservation, "shooterSeat" | "targetSeat">[],
): GameState => {
  assertFederationAction(game);
  if (game.phase !== "night-mafia" || observations.length === 0)
    throw new Error("Physical shots require a nonempty observation during shooting");
  const shotAssignments = { ...game.shotAssignments };
  const shotObservations = [...(game.shotObservations ?? [])];
  for (const { shooterSeat, targetSeat } of observations) {
    const shooter = requireSeat(game, shooterSeat);
    requireSeat(game, targetSeat);
    if (shooter.status !== "active" || shooter.team !== "black")
      throw new Error("Physical-shot observation requires an eligible shooter");
    const additional =
      shotAssignments[shooterSeat] !== undefined ||
      shotObservations.some((shot) => shot.shooterSeat === shooterSeat) ||
      game.actualMultipleShotSeats?.includes(shooterSeat) === true;
    shotObservations.push({ shooterSeat, targetSeat, additional });
    // Only an unassigned shooter's first physical shot supplies a primary assignment.
    if (!additional) shotAssignments[shooterSeat] = targetSeat;
  }
  return { ...game, shotAssignments, shotObservations };
};
export const prepareBestMove = (game: GameState): GameState => {
  assertFederationAction(game);
  if (game.phase !== "night-resolution")
    throw new Error("Best Move preparation requires unresolved night");
  if (game.bestMove?.completionReason) return game;
  if (
    game.day !== 1 ||
    game.bestMoveEnabled === false ||
    game.firstDayDepartureSeats.length >= 2 ||
    game.nightResult?.kind !== "kill"
  )
    return game;
  const victim = requireSeat(game, game.nightResult.targetSeat);
  if (
    victim.status === "red-carded" ||
    isCasperPlayer(victim) ||
    evaluateVictory(game.players) !== null
  )
    return game;
  return { ...game, phase: "best-move", bestMove: { playerSeat: victim.seat, selectedSeats: [] } };
};
const requireBestMove = (game: GameState) => {
  assertFederationAction(game);
  if (game.phase !== "best-move" || !game.bestMove || game.bestMove.completionReason)
    throw new Error("An unfinished night-time Best Move is required");
  return game.bestMove;
};
export const acceptBestMoveSeat = (game: GameState, seat: number): GameState => {
  const bestMove = requireBestMove(game);
  requireSeat(game, seat);
  if (bestMove.selectedSeats.length >= 3)
    throw new Error("Best Move accepts at most three spoken entries");
  return { ...game, bestMove: { ...bestMove, selectedSeats: [...bestMove.selectedSeats, seat] } };
};
export const correctBestMoveSlip = (
  game: GameState,
  index: number,
  seat: number,
  reason: string,
): GameState => {
  assertFederationAction(game);
  if (!game.bestMove || !["best-move", "night-resolution"].includes(game.phase))
    throw new Error("A slip correction requires the current night transcript");
  assertJudgeReason(reason);
  requireSeat(game, seat);
  if (!Number.isInteger(index) || index < 0 || index >= game.bestMove.selectedSeats.length)
    throw new Error("A slip corrects an existing entry only");
  const selectedSeats = game.bestMove.selectedSeats.map((old, i) => (i === index ? seat : old));
  const mafiaHits = game.bestMove.completionReason
    ? countBestMoveHits(game, selectedSeats)
    : undefined;
  return {
    ...game,
    bestMove: {
      ...game.bestMove,
      selectedSeats,
      ...(mafiaHits === undefined ? {} : { mafiaHits }),
    },
  };
};
const countBestMoveHits = (game: GameState, seats: readonly number[]) =>
  game.players.filter((p) => p.team === "black" && new Set(seats).has(p.seat)).length;
export const finalizeBestMove = (
  game: GameState,
  reason: BestMoveCompletionReason,
  readbackAcknowledged: boolean,
): GameState => {
  const bestMove = requireBestMove(game);
  if (
    !["complete-list", "interrupted", "time-expired", "declined", "finished-early"].includes(reason)
  )
    throw new Error("Invalid Best Move completion reason");
  if (readbackAcknowledged !== true)
    throw new Error("The judge must acknowledge transcript readback and acceptance");
  if (reason === "declined" && bestMove.selectedSeats.length !== 0)
    throw new Error(
      "Skip Best Move requires zero accepted entries; Finish early preserves the prefix",
    );
  if (reason === "complete-list" && bestMove.selectedSeats.length !== 3)
    throw new Error("A complete list requires three accepted entries");
  return {
    ...game,
    phase: "night-resolution",
    bestMove: {
      ...bestMove,
      completionReason: reason,
      readbackAcknowledged: true,
      mafiaHits: countBestMoveHits(game, bestMove.selectedSeats),
    },
  };
};
export const adjudicateOpponentVictory = (
  game: GameState,
  adjudication: OpponentVictoryAdjudication,
): GameState => {
  assertFederationAction(game);
  if (adjudication.losingTeam !== "red" && adjudication.losingTeam !== "black")
    throw new Error("Adjudication requires a losing team");
  assertJudgeReason(adjudication.reason);
  if (!/^(6\.3\.[1-5]|6\.6\.4)$/.test(adjudication.rule))
    throw new Error("Adjudication requires an applicable opponent-victory rule");
  if (
    typeof adjudication.committeeApproved !== "boolean" ||
    (adjudication.rule === "6.3.5" && !adjudication.committeeApproved)
  )
    throw new Error("Rule 6.3.5 requires explicit committee agreement");
  if (
    adjudication.offenderSeat !== undefined &&
    requireSeat(game, adjudication.offenderSeat).team !== adjudication.losingTeam
  )
    throw new Error("Offender team must match the losing team");
  return {
    ...game,
    phase: "finished",
    winner: adjudication.losingTeam === "red" ? "black" : "red",
    adjudication: { ...adjudication },
    turnOrder: [],
    currentTurnIndex: 0,
    goodbyeSeats: undefined,
    goodbyeNext: undefined,
    carCrashResult: undefined,
    ballot: undefined,
  };
};

import type { LegalVotingSkipReason, RemovalObservation, RemovalOccurrenceStage } from "./types.js";
import { isFederationGame } from "./rules-edition.js";
import { observeDisciplinaryRemoval } from "./federation-discipline.js";
import {
  acceptFederationVote,
  advanceFederationCandidate,
  assertFederationAction,
  createFederationBallot,
  getCollectiveLiftEligibility,
  inspectFederationCandidate,
  requireFederationBallot,
} from "./federation-actions.js";
import { evaluateVictory, markPlayerInactive } from "./game.js";
import { beginNight } from "./night-actions.js";
import { transitionToNight } from "./night-transition.js";
import type { CarCrashVoteResult, GameState, VoteResult } from "./types.js";

const currentSpeakerSeat = (game: GameState): number => {
  const seat = game.turnOrder[game.currentTurnIndex];
  if (seat === undefined) {
    throw new Error("There is no current speaker");
  }
  return seat;
};

export const getActiveNominations = (game: GameState): GameState["nominations"] =>
  game.nominations
    .filter(({ candidateSeat }) =>
      game.players.some(({ seat, status }) => seat === candidateSeat && status === "active"),
    )
    .map((nomination, index) => ({ ...nomination, order: index + 1 }));

export const cancelVoting = (
  game: GameState,
  votingCancellation: NonNullable<GameState["votingCancellation"]>,
): GameState => {
  if (
    isFederationGame(game) &&
    (votingCancellation.reason !== "red-card" ||
      (game.ballotCancellationDay !== game.day && !game.redCardIssuedThisDay) ||
      game.phase === "car-crash-result" ||
      game.phase === "car-crash-skipped")
  )
    throw new Error(
      "Federation cancellation requires applicable current-day disciplinary debt; a completed result is preserved",
    );
  const cancellablePhases: ReadonlySet<GameState["phase"]> = new Set([
    "day",
    "voting",
    "voting-cancelled",
    "car-crash",
    "car-crash-decision",
    "car-crash-result",
    "car-crash-skipped",
  ]);
  if (!cancellablePhases.has(game.phase)) {
    throw new Error(`Voting cannot be cancelled from phase ${game.phase}`);
  }
  return {
    ...game,
    phase: "voting-cancelled",
    ...(isFederationGame(game)
      ? { ballot: undefined, ballotSkipReason: "disciplinary-cancellation" as const }
      : {}),
    voteAssignments: {},
    votingRound: undefined,
    carCrashSeats: undefined,
    carCrashVotes: undefined,
    carCrashResult: undefined,
    votingCancellation,
  };
};

export const skipVoting = (game: GameState): GameState => {
  if (isFederationGame(game))
    throw new Error("Federation voting requires a named legal skip, not a host override");
  return cancelVoting(game, { reason: "host-skipped" });
};

export const isVotingRequired = (day: number, nominationCount: number): boolean =>
  nominationCount > 0 && (day > 1 || nominationCount > 1);

const completeDay = (game: GameState): GameState => {
  const nominations = getActiveNominations(game);
  if (
    game.redCardIssuedThisDay === true ||
    (isFederationGame(game) && game.ballotCancellationDay === game.day)
  ) {
    return cancelVoting({ ...game, nominations }, { reason: "red-card" });
  }
  if (!isVotingRequired(game.day, nominations.length))
    return beginNight({
      ...game,
      nominations,
      ...(isFederationGame(game)
        ? {
            ballotSkipReason:
              nominations.length === 0
                ? ("no-nominees" as const)
                : ("zero-round-sole-nominee" as const),
          }
        : {}),
    });
  const voting: GameState = {
    ...game,
    phase: "voting",
    nominations,
    turnOrder: nominations.map(({ candidateSeat }) => candidateSeat),
    currentTurnIndex: 0,
    voteAssignments: {},
    votingRound: "initial",
    ...(isFederationGame(game)
      ? { ballot: createFederationBallot(nominations[0]!.candidateSeat) }
      : {}),
  };
  if (isFederationGame(game) && nominations.length === 1) {
    const seat = nominations[0]!.candidateSeat;
    return completeEliminations(
      {
        ...voting,
        voteAssignments: Object.fromEntries(
          game.players.filter((p) => p.status === "active").map((p) => [p.seat, seat]),
        ),
        ballot: undefined,
      },
      [seat],
    );
  }
  if (nominations.length !== 1) return voting;
  return selectVotingCandidate(voting, nominations[0]!.candidateSeat);
};

export const skipFederationVoting = (game: GameState, reason: LegalVotingSkipReason): GameState => {
  assertFederationAction(game);
  if (reason === "no-nominees" || reason === "zero-round-sole-nominee") {
    if (
      game.phase !== "day" ||
      game.nominations.length !== (reason === "no-nominees" ? 0 : 1) ||
      (reason === "zero-round-sole-nominee" && game.day !== 1)
    )
      throw new Error("Named discussion skip does not match nominees/round");
    return { ...beginNight(game), ballotSkipReason: reason };
  }
  if (reason === "disciplinary-cancellation") {
    if (game.ballotCancellationDay !== game.day && !game.redCardIssuedThisDay)
      throw new Error("No disciplinary cancellation applies to this day");
    return { ...cancelVoting(game, { reason: "red-card" }), ballotSkipReason: reason };
  }
  const eligibility = getCollectiveLiftEligibility(game, game.carCrashSeats ?? game.turnOrder);
  if (game.phase !== "car-crash-decision" || eligibility.permitted || eligibility.reason !== reason)
    throw new Error("Named collective-lift skip does not match the current legal restriction");
  return beginSkippedCarCrashDecision(game, game.carCrashSeats ?? []);
};

export const nominate = (
  game: GameState,
  nominatorSeat: number,
  candidateSeat: number,
): GameState => {
  if (game.phase !== "day") {
    throw new Error("Nominations are only accepted during the day");
  }
  if (currentSpeakerSeat(game) !== nominatorSeat) {
    throw new Error("Only the current speaker may nominate");
  }
  const candidate = game.players.find(({ seat }) => seat === candidateSeat);
  if (candidate === undefined || candidate.status !== "active") {
    throw new Error("The nomination target must be an active player");
  }
  if (game.nominations.some((nomination) => nomination.nominatorSeat === nominatorSeat)) {
    throw new Error("The current speaker has already nominated a player");
  }
  if (game.nominations.some((nomination) => nomination.candidateSeat === candidateSeat)) {
    throw new Error(`Seat ${candidateSeat} is already nominated`);
  }

  return {
    ...game,
    nominations: [
      ...game.nominations,
      { nominatorSeat, candidateSeat, order: game.nominations.length + 1 },
    ],
  };
};

export const issueFoul = (
  game: GameState,
  seat: number,
  removalObservation?: RemovalObservation,
): GameState => {
  if (isFederationGame(game)) assertFederationAction(game);
  const player = game.players.find((candidate) => candidate.seat === seat);
  if (player === undefined || player.status !== "active") {
    throw new Error("A foul can only be issued to an active player");
  }

  const fouls = player.fouls + 1;
  const updated: GameState = {
    ...game,
    players: game.players.map((candidate) =>
      candidate.seat === seat
        ? { ...candidate, fouls, mutePending: candidate.mutePending || fouls === 3 }
        : candidate,
    ),
  };
  if (
    isFederationGame(game) &&
    removalObservation &&
    (fouls !== 4 || removalObservation.rule !== "6.2.1")
  )
    throw new Error("Only a fourth foul may carry its removal observation");
  return fouls >= 4 ? redCard(updated, seat, removalObservation) : updated;
};

export const completeCurrentTurn = (game: GameState): GameState => {
  if (game.phase === "car-crash") {
    const nextIndex = game.currentTurnIndex + 1;
    return nextIndex >= game.turnOrder.length
      ? {
          ...game,
          phase: "voting",
          currentTurnIndex: 0,
          voteAssignments: {},
          votingRound: "repeat",
          ...(isFederationGame(game) ? { ballot: createFederationBallot(game.turnOrder[0]!) } : {}),
        }
      : { ...game, currentTurnIndex: nextIndex };
  }
  if (game.phase !== "day") {
    throw new Error("A current turn can only be completed during the day");
  }
  const seat = currentSpeakerSeat(game);
  const players = game.players.map((player) =>
    player.seat === seat &&
    player.mutePending &&
    (!isFederationGame(game) || game.currentSpeechRestricted)
      ? { ...player, mutePending: false }
      : player,
  );
  const nextIndex = game.currentTurnIndex + 1;

  if (nextIndex >= game.turnOrder.length) {
    return completeDay({
      ...game,
      players,
      currentTurnIndex: nextIndex,
    });
  }

  return {
    ...game,
    players,
    currentTurnIndex: nextIndex,
    ...(isFederationGame(game)
      ? {
          currentSpeechRestricted:
            players.find((p) => p.seat === game.turnOrder[nextIndex])?.mutePending ?? false,
        }
      : {}),
  };
};

export const redCard = (
  game: GameState,
  seat: number,
  observation?: RemovalObservation,
): GameState => {
  if (isFederationGame(game)) {
    if (!observation) {
      const player = game.players.find((p) => p.seat === seat);
      const stage: RemovalOccurrenceStage | undefined =
        game.phase === "day"
          ? "day-discussion"
          : ["voting", "car-crash", "car-crash-decision", "voting-cancelled"].includes(game.phase)
            ? "open-voting"
            : ["car-crash-result", "car-crash-skipped"].includes(game.phase)
              ? "after-voting-result"
              : game.phase === "goodbye-speech"
                ? "farewell"
                : undefined;
      if (!stage) throw new Error("Night disqualification requires explicit occurrence timing");
      if (player?.fouls !== 4)
        throw new Error("A federation red card requires a reasoned removal observation");
      observation = { seat, stage, rule: "6.2.1", reason: "Fourth foul", checkInProgress: false };
    }
    if (observation.seat !== seat)
      throw new Error("Removal observation seat does not match the action subject");
    return observeDisciplinaryRemoval(game, observation);
  }
  const allowedPhases: ReadonlySet<GameState["phase"]> = new Set([
    "day",
    "voting",
    "voting-cancelled",
    "car-crash",
    "car-crash-decision",
    "car-crash-result",
    "car-crash-skipped",
    "goodbye-speech",
    "best-move",
    "night-mafia",
    "night-mafia-result",
    "night-don",
    "night-don-result",
    "night-sheriff",
    "night-sheriff-result",
    "night-resolution",
  ]);
  if (game.day < 1 || !allowedPhases.has(game.phase)) {
    throw new Error("Red cards are only accepted during active play from day one");
  }
  const afterRedCard = markPlayerInactive(game, seat, "red-carded");
  const updated: GameState = {
    ...afterRedCard,
    nominations: getActiveNominations(afterRedCard),
    redCardIssuedThisDay: game.phase === "day" ? true : game.redCardIssuedThisDay,
  };
  const winner = evaluateVictory(updated.players);
  if (winner !== null) return { ...updated, phase: "finished", winner };
  if (
    game.phase === "voting" ||
    game.phase === "voting-cancelled" ||
    game.phase === "car-crash" ||
    game.phase === "car-crash-decision" ||
    game.phase === "car-crash-result" ||
    game.phase === "car-crash-skipped"
  ) {
    return cancelVoting(updated, { reason: "red-card" });
  }
  if (game.phase === "night-don") {
    const hasDon = updated.players.some(
      ({ role, status }) => role === "don" && status === "active",
    );
    if (!hasDon) {
      const hasSheriff = updated.players.some(
        ({ role, status }) => role === "sheriff" && status === "active",
      );
      return { ...updated, phase: hasSheriff ? "night-sheriff" : "night-resolution" };
    }
  }
  if (
    game.phase === "night-sheriff" &&
    !updated.players.some(({ role, status }) => role === "sheriff" && status === "active")
  ) {
    return { ...updated, phase: "night-resolution" };
  }
  if (game.phase !== "day") return updated;

  const removedIndex = game.turnOrder.indexOf(seat);
  if (removedIndex < 0) return updated;
  const turnOrder = game.turnOrder.filter((candidateSeat) => candidateSeat !== seat);
  const currentTurnIndex =
    removedIndex < game.currentTurnIndex ? game.currentTurnIndex - 1 : game.currentTurnIndex;
  if (currentTurnIndex >= turnOrder.length) {
    return completeDay({
      ...updated,
      turnOrder,
      currentTurnIndex,
    });
  }
  return { ...updated, turnOrder, currentTurnIndex };
};

export const startVoting = (game: GameState): GameState => {
  if (game.phase !== "day" || game.nominations.length === 0) {
    throw new Error("Voting requires a completed day with at least one nomination");
  }
  return completeDay(game);
};

export const assignVote = (
  game: GameState,
  voterSeat: number,
  candidateSeat: number,
): GameState => {
  if (isFederationGame(game)) return acceptFederationVote(game, voterSeat, candidateSeat);
  if (game.phase !== "voting") {
    throw new Error("Votes can only be assigned during voting");
  }
  const voter = game.players.find(({ seat }) => seat === voterSeat);
  if (voter === undefined || voter.status !== "active") {
    throw new Error("Only active players may vote");
  }
  if (!game.nominations.some((nomination) => nomination.candidateSeat === candidateSeat)) {
    throw new Error("Votes must target a nominated player");
  }
  if (game.voteAssignments[voterSeat] !== undefined) {
    throw new Error(`Seat ${voterSeat} has already voted`);
  }
  if (candidateSeat !== getCurrentVotingCandidateSeat(game)) {
    throw new Error("Votes must target the current voting candidate");
  }
  return {
    ...game,
    voteAssignments: { ...game.voteAssignments, [voterSeat]: candidateSeat },
  };
};

export const toggleVote = (
  game: GameState,
  voterSeat: number,
  candidateSeat: number,
): GameState => {
  if (isFederationGame(game)) return acceptFederationVote(game, voterSeat, candidateSeat);
  const assignedCandidateSeat = game.voteAssignments[voterSeat];
  if (assignedCandidateSeat === undefined) return assignVote(game, voterSeat, candidateSeat);
  if (game.phase !== "voting") {
    throw new Error("Votes can only be changed during voting");
  }
  const voter = game.players.find(({ seat }) => seat === voterSeat);
  if (voter === undefined || voter.status !== "active") {
    throw new Error("Only active players may change votes");
  }
  if (candidateSeat !== getCurrentVotingCandidateSeat(game)) {
    throw new Error("Votes can only be changed for the current voting candidate");
  }
  if (assignedCandidateSeat !== candidateSeat) {
    return {
      ...game,
      voteAssignments: { ...game.voteAssignments, [voterSeat]: candidateSeat },
    };
  }
  const voteAssignments = { ...game.voteAssignments };
  delete voteAssignments[voterSeat];
  return { ...game, voteAssignments };
};

export const getCurrentVotingCandidateSeat = (game: GameState): number => {
  if (game.phase !== "voting") {
    throw new Error("There is no active voting candidate outside voting");
  }
  const candidateSeat = game.turnOrder[game.currentTurnIndex];
  const nomination = game.nominations[game.currentTurnIndex];
  if (candidateSeat === undefined || nomination?.candidateSeat !== candidateSeat) {
    throw new Error("The voting candidate cursor does not match nomination order");
  }
  return candidateSeat;
};

export const selectVotingCandidate = (game: GameState, candidateSeat: number): GameState => {
  if (isFederationGame(game)) return inspectFederationCandidate(game, candidateSeat);
  getCurrentVotingCandidateSeat(game);
  const nextIndex = game.nominations.findIndex(
    (nomination) => nomination.candidateSeat === candidateSeat,
  );
  if (nextIndex < 0 || game.turnOrder[nextIndex] !== candidateSeat) {
    throw new Error("Only a nominated voting candidate can be selected");
  }
  const voteAssignments = { ...game.voteAssignments };
  if (nextIndex === game.nominations.length - 1) {
    for (const player of game.players) {
      if (player.status === "active" && voteAssignments[player.seat] === undefined) {
        voteAssignments[player.seat] = candidateSeat;
      }
    }
  }
  return { ...game, currentTurnIndex: nextIndex, voteAssignments };
};

export const advanceVotingCandidate = (game: GameState): GameState => {
  if (isFederationGame(game)) return advanceFederationCandidate(game);
  getCurrentVotingCandidateSeat(game);
  const candidateSeat = game.turnOrder[game.currentTurnIndex + 1];
  if (candidateSeat === undefined) {
    throw new Error("The final voting candidate is already active");
  }
  return selectVotingCandidate(game, candidateSeat);
};

export const countVotes = (game: GameState): Record<number, number> => {
  const totals: Record<number, number> = Object.fromEntries(
    game.nominations.map(({ candidateSeat }) => [candidateSeat, 0]),
  );
  for (const candidateSeat of Object.values(game.voteAssignments)) {
    if (candidateSeat !== undefined) {
      totals[candidateSeat] = (totals[candidateSeat] ?? 0) + 1;
    }
  }
  return totals;
};

export const resolveVote = (game: GameState): VoteResult => {
  if (isFederationGame(game)) {
    const ballot = requireFederationBallot(game);
    if (!ballot.hostRecording && !ballot.stopped)
      throw new Error("Voting must reach an accepted STOP before resolution");
  }
  if (game.phase !== "voting") {
    throw new Error("A vote can only be resolved during voting");
  }
  getCurrentVotingCandidateSeat(game);

  const eligibleVoterSeats = game.players
    .filter(({ status }) => status === "active")
    .map(({ seat }) => seat);
  const eligibleVoterSeatSet = new Set(eligibleVoterSeats);
  const nominatedSeatSet = new Set(game.turnOrder);
  const voteEntries = Object.entries(game.voteAssignments);
  const assignedVoterSeats = new Set<number>();
  for (const [voterSeatKey, candidateSeat] of voteEntries) {
    const voterSeat = Number(voterSeatKey);
    if (!Number.isSafeInteger(voterSeat) || voterSeat < 1 || String(voterSeat) !== voterSeatKey) {
      throw new Error("Vote assignment keys must use canonical seat numbers");
    }
    if (!eligibleVoterSeatSet.has(voterSeat)) {
      throw new Error("Only active players may participate in voting");
    }
    if (candidateSeat === undefined) continue;
    if (!Number.isSafeInteger(candidateSeat) || !nominatedSeatSet.has(candidateSeat)) {
      throw new Error("Every vote must target a nominated player");
    }
    assignedVoterSeats.add(voterSeat);
  }
  if (
    assignedVoterSeats.size !== eligibleVoterSeats.length ||
    eligibleVoterSeats.some((seat) => !assignedVoterSeats.has(seat))
  ) {
    const totals = countVotes(game);
    const remaining = eligibleVoterSeats.length - assignedVoterSeats.size;
    const leader = game.turnOrder.find((seat) =>
      game.turnOrder.every(
        (other) => other === seat || (totals[seat] ?? 0) > (totals[other] ?? 0) + remaining,
      ),
    );
    if (!isFederationGame(game) || leader === undefined)
      throw new Error(
        "Every eligible player must vote unless the result is conclusively determined",
      );
    return { kind: "winner", seats: [leader], totals };
  }

  const totals = countVotes(game);
  const highest = Math.max(...game.turnOrder.map((seat) => totals[seat] ?? 0));
  const seats = game.turnOrder.filter((candidateSeat) => totals[candidateSeat] === highest);
  const previousTiedSeats = new Set(game.carCrashSeats ?? []);
  const repeatedSameTie =
    game.votingRound === "repeat" &&
    previousTiedSeats.size === seats.length &&
    seats.every((seat) => previousTiedSeats.has(seat));
  const liftEligibility = getCollectiveLiftEligibility(game, seats);
  if (isFederationGame(game) && repeatedSameTie && !liftEligibility.permitted)
    return { kind: "eliminate-all-skipped", seats, totals, skipReason: liftEligibility.reason };
  const allActivePlayersTied =
    seats.length === eligibleVoterSeats.length &&
    eligibleVoterSeats.every((seat) => seats.includes(seat));
  return {
    kind:
      seats.length === 1
        ? "winner"
        : repeatedSameTie
          ? allActivePlayersTied
            ? "eliminate-all-skipped"
            : "eliminate-both-vote"
          : "car-crash",
    seats,
    totals,
  };
};

export const beginCarCrash = (game: GameState, seats: readonly number[]): GameState => {
  if (game.phase !== "voting" || seats.length < 2) {
    throw new Error("A car crash requires a tied voting result");
  }
  const activeSeats = new Set(
    game.players.filter(({ status }) => status === "active").map(({ seat }) => seat),
  );
  if (seats.some((seat) => !activeSeats.has(seat))) {
    throw new Error("Car-crash nominees must be active players");
  }
  const tied = new Set(seats);
  return {
    ...game,
    phase: "car-crash",
    turnOrder: [...seats],
    currentTurnIndex: 0,
    nominations: game.nominations
      .filter(({ candidateSeat }) => tied.has(candidateSeat))
      .map((nomination, index) => ({ ...nomination, order: index + 1 })),
    voteAssignments: {},
    votingRound: "repeat",
    carCrashSeats: [...seats],
    carCrashVotes: {},
  };
};

export const beginCarCrashDecision = (game: GameState, seats: readonly number[]): GameState => {
  if (isFederationGame(game) && !getCollectiveLiftEligibility(game, seats).permitted)
    throw new Error("This collective lift is prohibited by federation rules");
  if (game.phase !== "voting" || game.votingRound !== "repeat" || seats.length < 2) {
    throw new Error("An eliminate-both ballot requires a repeated car-crash tie");
  }
  return {
    ...game,
    phase: "car-crash-decision",
    voteAssignments: {},
    carCrashSeats: [...seats],
    carCrashVotes: {},
  };
};

export const beginSkippedCarCrashDecision = (
  game: GameState,
  seats: readonly number[],
): GameState => {
  if (game.phase !== "voting" || game.votingRound !== "repeat") {
    throw new Error("A skipped eliminate-all ballot requires a repeated car-crash tie");
  }
  const activeSeats = game.players
    .filter(({ status }) => status === "active")
    .map(({ seat }) => seat);
  const tied = new Set(seats);
  const eligibility = getCollectiveLiftEligibility(game, seats);
  if (
    isFederationGame(game)
      ? eligibility.permitted
      : tied.size !== activeSeats.length || activeSeats.some((seat) => !tied.has(seat))
  ) {
    throw new Error("The eliminate-all ballot is skipped only when every active player is tied");
  }
  return {
    ...game,
    phase: "car-crash-skipped",
    ...(isFederationGame(game) && !eligibility.permitted
      ? { ballotSkipReason: eligibility.reason }
      : {}),
    voteAssignments: {},
    carCrashSeats: [...seats],
    carCrashVotes: undefined,
  };
};

export const assignCarCrashVote = (
  game: GameState,
  voterSeat: number,
  eliminateBoth: boolean,
): GameState => {
  if (game.phase !== "car-crash-decision") {
    throw new Error("Eliminate-both votes require the car-crash decision phase");
  }
  const voter = game.players.find(({ seat }) => seat === voterSeat);
  if (voter?.status !== "active") throw new Error("Only active players may vote");
  if (game.carCrashVotes?.[voterSeat] !== undefined) {
    throw new Error(`Seat ${voterSeat} has already voted`);
  }
  return {
    ...game,
    carCrashVotes: { ...game.carCrashVotes, [voterSeat]: eliminateBoth },
  };
};

export const resolveCarCrashVote = (game: GameState): CarCrashVoteResult => {
  if (
    isFederationGame(game) &&
    !getCollectiveLiftEligibility(game, game.carCrashSeats ?? []).permitted
  )
    throw new Error("This collective lift is prohibited by federation rules");
  if (game.phase !== "car-crash-decision") {
    throw new Error("Only a car-crash decision can be resolved");
  }
  const eligibleSeats = new Set(
    game.players.filter(({ status }) => status === "active").map(({ seat }) => seat),
  );
  const eligibleVoters = eligibleSeats.size;
  const voteEntries = Object.entries(game.carCrashVotes ?? {});
  if (
    voteEntries.some(([voterSeatKey]) => {
      const voterSeat = Number(voterSeatKey);
      return !Number.isSafeInteger(voterSeat) || String(voterSeat) !== voterSeatKey;
    })
  ) {
    throw new Error("Car-crash vote keys must use canonical seat numbers");
  }
  if (voteEntries.some(([voterSeat]) => !eligibleSeats.has(Number(voterSeat)))) {
    throw new Error("Only active players may vote in a car-crash decision");
  }
  if (voteEntries.some(([, vote]) => typeof vote !== "boolean")) {
    throw new Error("Every car-crash vote must be a boolean decision");
  }
  if (
    voteEntries.length !== eligibleVoters ||
    [...eligibleSeats].some((seat) => !Object.hasOwn(game.carCrashVotes ?? {}, seat))
  ) {
    const yes = voteEntries.filter(([, vote]) => vote === true).length;
    const remaining = eligibleVoters - voteEntries.length;
    if (
      !isFederationGame(game) ||
      !(yes > eligibleVoters / 2 || yes + remaining <= eligibleVoters / 2)
    )
      throw new Error(
        "Every eligible player must vote unless the lift result is conclusively determined",
      );
  }
  const yesVotes = voteEntries.filter(([, vote]) => vote === true).length;
  return {
    eliminate: yesVotes > eligibleVoters / 2,
    seats: game.carCrashSeats ?? [],
    yesVotes,
    eligibleVoters,
  };
};

export const acceptCarCrashBallot = (game: GameState): GameState => ({
  ...game,
  phase: "car-crash-result",
  carCrashResult: resolveCarCrashVote(game),
  winner: null,
});

export const completeEliminations = (game: GameState, seats: readonly number[]): GameState => {
  const afterElimination = seats.reduce(
    (state, seat) => markPlayerInactive(state, seat, "eliminated"),
    game,
  );
  const winner = evaluateVictory(afterElimination.players);
  if (winner !== null) return { ...afterElimination, phase: "finished", winner };

  const goodbyeSeats = seats.filter(
    (seat) =>
      isFederationGame(game) ||
      !afterElimination.players.find((player) => player.seat === seat)?.mutePending,
  );
  if (goodbyeSeats.length === 0) return transitionToNight(afterElimination);
  return {
    ...afterElimination,
    phase: "goodbye-speech",
    goodbyeSeats,
    goodbyeNext: "night",
    winner: null,
  };
};

export const completeCarCrashResult = (game: GameState): GameState => {
  if (game.phase !== "car-crash-result" || game.carCrashResult === undefined) {
    throw new Error("Only a reviewed car-crash result can continue");
  }
  if (!game.carCrashResult.eliminate) return transitionToNight(game);

  const seats = isFederationGame(game)
    ? game.carCrashResult.seats.filter(
        (seat) => game.players.find((p) => p.seat === seat)?.status === "active",
      )
    : game.carCrashResult.seats;
  const cleared = {
    ...game,
    votingRound: undefined,
    carCrashSeats: undefined,
    carCrashVotes: undefined,
    carCrashResult: undefined,
  };
  return completeEliminations(cleared, seats);
};

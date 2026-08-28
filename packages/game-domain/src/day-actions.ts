import { evaluateVictory, markPlayerInactive } from "./game.js";
import { beginNight } from "./night-actions.js";
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
    voteAssignments: {},
    votingRound: undefined,
    carCrashSeats: undefined,
    carCrashVotes: undefined,
    carCrashResult: undefined,
    votingCancellation,
  };
};

export const skipVoting = (game: GameState): GameState =>
  cancelVoting(game, { reason: "host-skipped" });

export const isVotingRequired = (day: number, nominationCount: number): boolean =>
  nominationCount > 0 && (day > 1 || nominationCount > 1);

const completeDay = (game: GameState): GameState => {
  const nominations = getActiveNominations(game);
  if (game.redCardIssuedThisDay === true) {
    return cancelVoting({ ...game, nominations }, { reason: "red-card" });
  }
  if (!isVotingRequired(game.day, nominations.length)) return beginNight({ ...game, nominations });
  const voting: GameState = {
    ...game,
    phase: "voting",
    nominations,
    turnOrder: nominations.map(({ candidateSeat }) => candidateSeat),
    currentTurnIndex: 0,
    voteAssignments: {},
    votingRound: "initial",
  };
  if (nominations.length !== 1) return voting;
  const candidateSeat = nominations[0]!.candidateSeat;
  return {
    ...voting,
    voteAssignments: Object.fromEntries(
      voting.players
        .filter(({ status }) => status === "active")
        .map(({ seat }) => [seat, candidateSeat]),
    ),
  };
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

export const issueFoul = (game: GameState, seat: number): GameState => {
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
  return fouls >= 4 ? redCard(updated, seat) : updated;
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
        }
      : { ...game, currentTurnIndex: nextIndex };
  }
  if (game.phase !== "day") {
    throw new Error("A current turn can only be completed during the day");
  }
  const seat = currentSpeakerSeat(game);
  const players = game.players.map((player) =>
    player.seat === seat && player.mutePending ? { ...player, mutePending: false } : player,
  );
  const nextIndex = game.currentTurnIndex + 1;

  if (nextIndex >= game.turnOrder.length) {
    return completeDay({
      ...game,
      players,
      currentTurnIndex: nextIndex,
    });
  }

  return { ...game, players, currentTurnIndex: nextIndex };
};

export const redCard = (game: GameState, seat: number): GameState => {
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
    throw new Error(`Seat ${voterSeat} has already voted for another candidate`);
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

export const advanceVotingCandidate = (game: GameState): GameState => {
  getCurrentVotingCandidateSeat(game);
  const nextIndex = game.currentTurnIndex + 1;
  if (nextIndex >= game.nominations.length) {
    throw new Error("The final voting candidate is already active");
  }
  const candidateSeat = game.nominations[nextIndex]!.candidateSeat;
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
  if (game.phase !== "voting") {
    throw new Error("A vote can only be resolved during voting");
  }
  getCurrentVotingCandidateSeat(game);
  if (game.currentTurnIndex !== game.turnOrder.length - 1) {
    throw new Error("Voting can only resolve on the final candidate");
  }
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
    throw new Error("Every eligible player must vote before resolution");
  }

  const totals = countVotes(game);
  const highest = Math.max(...game.turnOrder.map((seat) => totals[seat] ?? 0));
  const seats = game.turnOrder.filter((candidateSeat) => totals[candidateSeat] === highest);
  const previousTiedSeats = new Set(game.carCrashSeats ?? []);
  const repeatedSameTie =
    game.votingRound === "repeat" &&
    previousTiedSeats.size === seats.length &&
    seats.every((seat) => previousTiedSeats.has(seat));
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
  if (tied.size !== activeSeats.length || activeSeats.some((seat) => !tied.has(seat))) {
    throw new Error("The eliminate-all ballot is skipped only when every active player is tied");
  }
  return {
    ...game,
    phase: "car-crash-skipped",
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
    throw new Error("Every eligible player must vote before resolution");
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

export const completeCarCrashResult = (game: GameState): GameState => {
  if (game.phase !== "car-crash-result" || game.carCrashResult === undefined) {
    throw new Error("Only a reviewed car-crash result can continue");
  }
  if (!game.carCrashResult.eliminate) return beginNight(game);

  const afterElimination = game.carCrashResult.seats.reduce(
    (state, seat) => markPlayerInactive(state, seat, "eliminated"),
    game,
  );
  const cleared = {
    ...afterElimination,
    votingRound: undefined,
    carCrashSeats: undefined,
    carCrashVotes: undefined,
    carCrashResult: undefined,
  };
  const winner = evaluateVictory(cleared.players);
  return winner === null
    ? {
        ...cleared,
        phase: "goodbye-speech",
        goodbyeSeats: [...game.carCrashResult.seats],
        goodbyeNext: "night",
        winner: null,
      }
    : { ...cleared, phase: "finished", winner };
};

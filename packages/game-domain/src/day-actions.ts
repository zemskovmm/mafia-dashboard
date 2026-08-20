import { evaluateVictory, markPlayerInactive } from "./game.js";
import type { CarCrashVoteResult, GameState, VoteResult } from "./types.js";

const currentSpeakerSeat = (game: GameState): number => {
  const seat = game.turnOrder[game.currentTurnIndex];
  if (seat === undefined) {
    throw new Error("There is no current speaker");
  }
  return seat;
};

const activeNominations = (game: GameState): GameState["nominations"] =>
  game.nominations
    .filter(({ candidateSeat }) =>
      game.players.some(({ seat, status }) => seat === candidateSeat && status === "active"),
    )
    .map((nomination, index) => ({ ...nomination, order: index + 1 }));

const completeDay = (game: GameState): GameState => {
  const nominations = activeNominations(game);
  if (nominations.length === 0 || (game.day === 1 && nominations.length === 1)) {
    return {
      ...game,
      phase: "night-mafia",
      nominations: [],
      voteAssignments: {},
      shotAssignments: {},
    };
  }
  return {
    ...game,
    phase: "voting",
    nominations,
    voteAssignments: {},
    votingRound: "initial",
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
  if (candidateSeat === nominatorSeat) {
    throw new Error("The current speaker must nominate another active player");
  }
  const candidate = game.players.find(({ seat }) => seat === candidateSeat);
  if (candidate === undefined || candidate.status !== "active") {
    throw new Error("The nomination target must be another active player");
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
  return {
    ...game,
    players: game.players.map((candidate) =>
      candidate.seat === seat
        ? { ...candidate, fouls, mutePending: candidate.mutePending || fouls === 3 }
        : candidate,
    ),
  };
};

export const completeCurrentTurn = (game: GameState): GameState => {
  if (game.phase === "car-crash") {
    const nextIndex = game.currentTurnIndex + 1;
    return nextIndex >= game.turnOrder.length
      ? {
          ...game,
          phase: "voting",
          currentTurnIndex: nextIndex,
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
  if (game.phase !== "day") {
    throw new Error("Red cards are only accepted during the day");
  }
  const afterRedCard = markPlayerInactive(game, seat, "red-carded");
  const updated = { ...afterRedCard, nominations: activeNominations(afterRedCard) };
  const winner = evaluateVictory(updated.players);
  if (winner !== null) return { ...updated, phase: "finished", winner };
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
  return {
    ...game,
    voteAssignments: { ...game.voteAssignments, [voterSeat]: candidateSeat },
  };
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
  const eligibleVoters = game.players.filter(({ status }) => status === "active").length;
  if (Object.keys(game.voteAssignments).length !== eligibleVoters) {
    throw new Error("Every eligible player must vote before resolution");
  }

  const totals = countVotes(game);
  const highest = Math.max(...Object.values(totals));
  const seats = game.nominations
    .map(({ candidateSeat }) => candidateSeat)
    .filter((candidateSeat) => totals[candidateSeat] === highest);
  return {
    kind:
      seats.length === 1
        ? "winner"
        : game.votingRound === "repeat"
          ? "eliminate-both-vote"
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
  const eligibleVoters = game.players.filter(({ status }) => status === "active").length;
  const voteEntries = Object.entries(game.carCrashVotes ?? {});
  if (voteEntries.some(([voterSeat]) => String(Number(voterSeat)) !== voterSeat)) {
    throw new Error("Car-crash vote keys must use canonical seat numbers");
  }
  if (voteEntries.length !== eligibleVoters) {
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

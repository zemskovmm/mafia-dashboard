import { evaluateVictory, markPlayerInactive } from "./game.js";
import type { GameState, VoteResult } from "./types.js";

const currentSpeakerSeat = (game: GameState): number => {
  const seat = game.turnOrder[game.currentTurnIndex];
  if (seat === undefined) {
    throw new Error("There is no current speaker");
  }
  return seat;
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
  if (game.phase !== "day") {
    throw new Error("A current turn can only be completed during the day");
  }
  const seat = currentSpeakerSeat(game);
  const players = game.players.map((player) =>
    player.seat === seat && player.mutePending ? { ...player, mutePending: false } : player,
  );
  const nextIndex = game.currentTurnIndex + 1;

  if (nextIndex >= game.turnOrder.length) {
    return {
      ...game,
      players,
      currentTurnIndex: nextIndex,
      phase: game.nominations.length > 0 ? "voting" : "night-mafia",
      voteAssignments: {},
    };
  }

  return { ...game, players, currentTurnIndex: nextIndex };
};

export const redCard = (game: GameState, seat: number): GameState => {
  const updated = markPlayerInactive(game, seat, "red-carded");
  const winner = evaluateVictory(updated.players);
  return winner === null ? updated : { ...updated, phase: "finished", winner };
};

export const startVoting = (game: GameState): GameState => {
  if (game.phase !== "day" || game.nominations.length === 0) {
    throw new Error("Voting requires a completed day with at least one nomination");
  }
  return { ...game, phase: "voting", voteAssignments: {} };
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
  return { kind: seats.length === 1 ? "winner" : "tie", seats, totals };
};

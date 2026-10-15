import type { GameState } from "@mafia/game-domain";

const privateNight = (game: GameState): boolean =>
  game.phase.startsWith("night-") || game.phase === "best-move";

export const pendingGoodbyeSeats = (game: GameState): readonly number[] => {
  if (game.phase === "goodbye-speech") return game.goodbyeSeats ?? [];
  if (game.phase === "best-move") return game.goodbyeSeats ?? [game.bestMove?.playerSeat ?? -1];
  return [];
};

/** Only compare accepted forward states within one live GameScreen generation. */
export const playerExitSeats = (previous: GameState, next: GameState): readonly number[] => {
  const samePlayer = (seat: number) => {
    const before = previous.players.find((player) => player.seat === seat);
    const after = next.players.find((player) => player.seat === seat);
    return before && after && before.id === after.id ? { before, after } : null;
  };
  const disciplinary = next.players.flatMap((player) => {
    const pair = samePlayer(player.seat);
    return pair && pair.before.status !== "red-carded" && pair.after.status === "red-carded"
      ? [player.seat]
      : [];
  });
  if (next.phase === "draw" || next.phase === "cancelled" || next.adjudication) return disciplinary;
  const seats = new Set(disciplinary);
  const waiting = pendingGoodbyeSeats(next);
  for (const player of next.players) {
    const pair = samePlayer(player.seat);
    if (
      pair?.before.status === "active" &&
      pair.after.status === "eliminated" &&
      !waiting.includes(player.seat) &&
      (!privateNight(previous) || next.phase === "finished")
    )
      seats.add(player.seat);
  }
  // Completion or a decided game releases the whole list. Nonterminal sanctions do not.
  if (
    previous.phase === "goodbye-speech" &&
    (next.phase === "finished" ||
      (disciplinary.length === 0 && ["day", "night-mafia"].includes(next.phase)))
  ) {
    for (const seat of previous.goodbyeSeats ?? []) {
      if (samePlayer(seat)?.after.status === "eliminated") seats.add(seat);
    }
  }
  // A private kill may already be applied when another exclusion makes the outcome public.
  if (
    next.phase === "finished" &&
    privateNight(previous) &&
    previous.nightResult?.kind === "kill"
  ) {
    const seat = previous.nightResult.targetSeat;
    if (samePlayer(seat)?.after.status === "eliminated") seats.add(seat);
  }
  return [...seats];
};

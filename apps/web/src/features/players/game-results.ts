import type { GameState } from "@mafia/game-domain";
import type { FinalGameResults } from "../../api/client.js";

export const buildFinalGameResults = (
  game: GameState,
  playedAt: Date,
  hostPlayerId: string,
  reason: string | null = null,
): FinalGameResults | null => {
  const outcome =
    game.phase === "finished"
      ? game.winner
      : game.phase === "draw" || game.phase === "cancelled"
        ? game.phase
        : null;
  const reasonedOutcome = outcome === "draw" || outcome === "cancelled";
  if (
    outcome === null ||
    (reasonedOutcome &&
      (reason === null || reason.length === 0 || reason.length > 500 || reason !== reason.trim()))
  ) {
    return null;
  }

  return {
    hostPlayerId,
    outcome,
    winner: outcome === "red" || outcome === "black" ? outcome : null,
    reason: reasonedOutcome ? reason : null,
    playedAt: playedAt.toISOString(),
    players: game.players.map((player) => ({
      playerId: player.id,
      seat: player.seat,
      role: player.role,
      team: player.role === "mafia" || player.role === "don" ? "black" : "red",
      status: player.status,
      fouls: player.fouls,
      bestMoveHits:
        game.bestMove?.playerSeat === player.seat && game.bestMove.mafiaHits !== undefined
          ? game.bestMove.mafiaHits
          : null,
    })),
  };
};

import type { GameState } from "@mafia/game-domain";
import type { FinalGameResults } from "../../api/client.js";

export const buildFinalGameResults = (game: GameState, playedAt: Date): FinalGameResults | null => {
  if (game.phase !== "finished" || game.winner === null) return null;

  return {
    winner: game.winner,
    playedAt: playedAt.toISOString(),
    players: game.players.map((player) => ({
      playerId: player.id,
      seat: player.seat,
      role: player.role,
      team: player.role === "mafia" || player.role === "don" ? "black" : "red",
      status: player.status,
      fouls: player.fouls,
    })),
  };
};

import type { PoolClient } from "pg";

export class DeletedGameError extends Error {
  public readonly code = "game_deleted";

  public constructor(gameId: string) {
    super(`Game ${gameId} was deleted`);
    this.name = "DeletedGameError";
  }
}

/** Serialize writes to one server-issued record without assigning ownership. */
export const lockClubGame = async (
  client: PoolClient,
  clubId: string,
  gameId: string,
): Promise<void> => {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))", [
    clubId,
    gameId,
  ]);
};

/** Keep relational result/history projections coherent with a snapshot commit. */
export const lockAggregateProjectionTables = async (client: PoolClient): Promise<void> => {
  await client.query(
    "LOCK TABLE game_results, game_player_results, game_events IN ROW EXCLUSIVE MODE",
  );
  await client.query("LOCK TABLE game_session_players IN ROW EXCLUSIVE MODE");
};

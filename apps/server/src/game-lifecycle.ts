import type { PoolClient } from "pg";

export class DeletedGameError extends Error {
  public readonly code = "game_deleted";

  public constructor(gameId: string) {
    super(`Game ${gameId} was deleted with player history`);
    this.name = "DeletedGameError";
  }
}

export class AuthoritativeGameSessionError extends Error {
  public readonly code = "game_session_authoritative";

  public constructor(gameId: string) {
    super(`Game ${gameId} is managed by the authoritative session aggregate`);
    this.name = "AuthoritativeGameSessionError";
  }
}

export const lockClubActiveGame = async (client: PoolClient, clubId: string): Promise<void> => {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('active-game:' || $1, 0))", [
    clubId,
  ]);
};

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

export const assertGameNotDeleted = async (
  client: PoolClient,
  clubId: string,
  gameId: string,
): Promise<void> => {
  const deleted = await client.query(
    "SELECT 1 FROM deleted_games WHERE club_id = $1 AND game_id = $2",
    [clubId, gameId],
  );
  if (deleted.rowCount !== 0) throw new DeletedGameError(gameId);
};

export const assertClubGameNotDeleted = assertGameNotDeleted;

export const assertLegacyGameMutationAllowed = async (
  client: PoolClient,
  clubId: string,
  gameId: string,
): Promise<void> => {
  const session = await client.query("SELECT 1 FROM game_sessions WHERE club_id = $1 AND id = $2", [
    clubId,
    gameId,
  ]);
  if (session.rowCount !== 0) throw new AuthoritativeGameSessionError(gameId);
};

export const lockAggregateProjectionTables = async (client: PoolClient): Promise<void> => {
  await client.query(
    "LOCK TABLE game_results, game_player_results, game_events IN ROW EXCLUSIVE MODE",
  );
  await client.query("LOCK TABLE game_session_players IN ROW EXCLUSIVE MODE");
};

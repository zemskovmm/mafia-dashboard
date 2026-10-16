import { randomUUID } from "node:crypto";
import type { ClubTournament } from "@mafia/game-domain";
import type { Pool, PoolClient } from "pg";
import { lockClubGame } from "./game-lifecycle.js";
import { GameSessionNotFoundError } from "./game-session-store.js";
import { sortTournaments, tournamentName, TournamentNotFoundError } from "./tournament-metadata.js";

export const postgresAssignTournament = async (
  client: PoolClient,
  gameId: string,
  tournamentId: string | null,
  clubId: string,
): Promise<string | null> => {
  if (tournamentId === null) {
    await client.query("DELETE FROM game_tournaments WHERE club_id = $1 AND game_id = $2", [
      clubId,
      gameId,
    ]);
    return null;
  }
  const target = await client.query<{ id: string }>(
    "SELECT id FROM tournaments WHERE club_id = $1 AND id = $2 FOR KEY SHARE",
    [clubId, tournamentId],
  );
  const id = target.rows[0]?.id;
  if (!id) throw new TournamentNotFoundError();
  await client.query(
    `INSERT INTO game_tournaments (club_id, game_id, tournament_id) VALUES ($1, $2, $3)
    ON CONFLICT (club_id, game_id) DO UPDATE SET tournament_id = EXCLUDED.tournament_id`,
    [clubId, gameId, id],
  );
  return id;
};

export class TournamentStore {
  public constructor(private readonly pool: Pool) {}
  public async list(clubId: string): Promise<readonly ClubTournament[]> {
    return sortTournaments(
      (
        await this.pool.query<ClubTournament>(
          "SELECT id, name FROM tournaments WHERE club_id = $1",
          [clubId],
        )
      ).rows,
    );
  }
  public async create(name: string, clubId: string): Promise<ClubTournament> {
    const normalized = tournamentName(name);
    const result = await this.pool.query<ClubTournament>(
      `INSERT INTO tournaments (club_id, id, name, name_key) VALUES ($1, $2, $3, $4)
      ON CONFLICT (club_id, name_key) DO UPDATE SET name_key = EXCLUDED.name_key RETURNING id, name`,
      [clubId, randomUUID(), normalized.name, normalized.nameKey],
    );
    return result.rows[0]!;
  }
  public async assign(
    gameId: string,
    tournamentId: string | null,
    clubId: string,
  ): Promise<string | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockClubGame(client, clubId, gameId);
      if (
        (
          await client.query(
            "SELECT 1 FROM game_sessions WHERE club_id = $1 AND id = $2 FOR UPDATE",
            [clubId, gameId],
          )
        ).rowCount === 0
      )
        throw new GameSessionNotFoundError();
      const assigned = await postgresAssignTournament(client, gameId, tournamentId, clubId);
      await client.query("COMMIT");
      return assigned;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

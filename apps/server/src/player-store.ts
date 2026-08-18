import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { assertGameNotDeleted, assertLegacyGameMutationAllowed } from "./game-lifecycle.js";
import { initializeSchema } from "./initialize-schema.js";

export interface PlayerProfileInput {
  readonly nickname: string;
  readonly consent: boolean;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string | null;
}

export interface PlayerStatistics {
  readonly hostedGames: number;
  readonly gamesPlayed: number;
  readonly wins: number;
  readonly losses: number;
  readonly redGames: number;
  readonly redWins: number;
  readonly blackGames: number;
  readonly blackWins: number;
  readonly sheriffGames: number;
  readonly citizenGames: number;
  readonly mafiaGames: number;
  readonly donGames: number;
  readonly totalFouls: number;
  readonly eliminations: number;
  readonly redCards: number;
}

export interface PlayerProfile extends PlayerProfileInput {
  readonly id: string;
  readonly consentAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastPlayedAt: Date | null;
  readonly statistics: PlayerStatistics;
}

export interface GamePlayerResultInput {
  readonly playerId: string;
  readonly seat: number;
  readonly role: "sheriff" | "citizen" | "mafia" | "don";
  readonly team: "red" | "black";
  readonly status: "active" | "eliminated" | "red-carded";
  readonly fouls: number;
}

export interface GameResultsInput {
  readonly gameId: string;
  readonly hostPlayerId?: string | null;
  readonly winner: "red" | "black";
  readonly playedAt: Date;
  readonly players: readonly GamePlayerResultInput[];
}

interface PlayerRow {
  id: string;
  nickname: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  data_processing_consent: boolean;
  consent_at: Date | null;
  created_at: Date;
  updated_at: Date;
  last_played_at: Date | null;
  hosted_games: number;
  games_played: number;
  wins: number;
  red_games: number;
  red_wins: number;
  black_games: number;
  black_wins: number;
  sheriff_games: number;
  citizen_games: number;
  mafia_games: number;
  don_games: number;
  total_fouls: number;
  eliminations: number;
  red_cards: number;
}

const mapPlayer = (row: PlayerRow): PlayerProfile => ({
  id: row.id,
  nickname: row.nickname,
  consent: row.data_processing_consent,
  firstName: row.first_name,
  lastName: row.last_name,
  email: row.email,
  consentAt: row.consent_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastPlayedAt: row.last_played_at,
  statistics: {
    hostedGames: row.hosted_games,
    gamesPlayed: row.games_played,
    wins: row.wins,
    losses: row.games_played - row.wins,
    redGames: row.red_games,
    redWins: row.red_wins,
    blackGames: row.black_games,
    blackWins: row.black_wins,
    sheriffGames: row.sheriff_games,
    citizenGames: row.citizen_games,
    mafiaGames: row.mafia_games,
    donGames: row.don_games,
    totalFouls: row.total_fouls,
    eliminations: row.eliminations,
    redCards: row.red_cards,
  },
});

const profileSelect = `
  SELECT p.id, p.nickname, p.first_name, p.last_name, p.email,
         p.data_processing_consent, p.consent_at, p.created_at, p.updated_at,
         p.last_played_at,
         (SELECT COUNT(*)::int FROM game_results hosted WHERE hosted.host_player_id = p.id)
           AS hosted_games,
         COUNT(r.player_id)::int AS games_played,
         COUNT(r.player_id) FILTER (WHERE r.won)::int AS wins,
         COUNT(r.player_id) FILTER (WHERE r.team = 'red')::int AS red_games,
         COUNT(r.player_id) FILTER (WHERE r.team = 'red' AND r.won)::int AS red_wins,
         COUNT(r.player_id) FILTER (WHERE r.team = 'black')::int AS black_games,
         COUNT(r.player_id) FILTER (WHERE r.team = 'black' AND r.won)::int AS black_wins,
         COUNT(r.player_id) FILTER (WHERE r.role = 'sheriff')::int AS sheriff_games,
         COUNT(r.player_id) FILTER (WHERE r.role = 'citizen')::int AS citizen_games,
         COUNT(r.player_id) FILTER (WHERE r.role = 'mafia')::int AS mafia_games,
         COUNT(r.player_id) FILTER (WHERE r.role = 'don')::int AS don_games,
         COALESCE(SUM(r.fouls), 0)::int AS total_fouls,
         COUNT(r.player_id) FILTER (WHERE r.final_status = 'eliminated')::int AS eliminations,
         COUNT(r.player_id) FILTER (WHERE r.final_status = 'red-carded')::int AS red_cards
    FROM players p
    LEFT JOIN game_player_results r ON r.player_id = p.id`;

const profileGroupAndOrder = `
   GROUP BY p.id
   ORDER BY p.last_played_at DESC NULLS LAST, LOWER(p.nickname) ASC, p.id ASC`;

export class PlayerStore {
  public constructor(private readonly pool: Pool) {}

  public async initialize(): Promise<void> {
    await initializeSchema(this.pool);
  }

  public async list(): Promise<readonly PlayerProfile[]> {
    const result = await this.pool.query<PlayerRow>(`${profileSelect}${profileGroupAndOrder}`);
    return result.rows.map(mapPlayer);
  }

  public async get(id: string): Promise<PlayerProfile | null> {
    const result = await this.pool.query<PlayerRow>(
      `${profileSelect} WHERE p.id = $1 ${profileGroupAndOrder}`,
      [id],
    );
    return result.rows[0] === undefined ? null : mapPlayer(result.rows[0]);
  }

  public async create(input: PlayerProfileInput): Promise<PlayerProfile> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO players
         (id, nickname, first_name, last_name, email, data_processing_consent, consent_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 THEN NOW() ELSE NULL END)`,
      [id, input.nickname.trim(), input.firstName, input.lastName, input.email, input.consent],
    );
    const player = await this.get(id);
    if (player === null) throw new Error("Created player was not found");
    return player;
  }

  public async update(id: string, input: PlayerProfileInput): Promise<PlayerProfile | null> {
    const result = await this.pool.query(
      `UPDATE players
          SET nickname = $2,
              first_name = $3,
              last_name = $4,
              email = $5,
              data_processing_consent = $6,
              consent_at = CASE
                WHEN $6 THEN COALESCE(consent_at, NOW())
                ELSE NULL
              END,
              updated_at = NOW()
        WHERE id = $1`,
      [id, input.nickname.trim(), input.firstName, input.lastName, input.email, input.consent],
    );
    if (result.rowCount === 0) return null;
    return this.get(id);
  }

  public async delete(id: string): Promise<"deleted" | "not_found" | "active_game"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "LOCK TABLE game_results, game_player_results, game_events IN SHARE ROW EXCLUSIVE MODE",
      );
      await client.query("LOCK TABLE game_session_players IN SHARE MODE");
      const locked = await client.query<{ id: string }>(
        "SELECT id FROM players WHERE id = $1 FOR UPDATE",
        [id],
      );
      if (locked.rowCount === 0) {
        await client.query("COMMIT");
        return "not_found";
      }
      const activeGame = await client.query(
        `SELECT 1
           FROM game_session_players
          WHERE player_id = $1
          LIMIT 1`,
        [id],
      );
      if (activeGame.rowCount !== 0) {
        await client.query("COMMIT");
        return "active_game";
      }
      const currentGames = await client.query<{ game_id: string }>(
        `SELECT game_id FROM game_player_results WHERE player_id = $1
         UNION
         SELECT game_id FROM game_results WHERE host_player_id = $1
         ORDER BY game_id`,
        [id],
      );
      const gameIds = currentGames.rows.map(({ game_id }) => game_id);
      const affectedPlayers =
        gameIds.length === 0
          ? []
          : (
              await client.query<{ player_id: string }>(
                `SELECT player_id
                   FROM game_player_results
                  WHERE game_id = ANY($1::uuid[])
                 UNION
                 SELECT host_player_id AS player_id
                   FROM game_results
                  WHERE game_id = ANY($1::uuid[])
                    AND host_player_id IS NOT NULL`,
                [gameIds],
              )
            ).rows.map(({ player_id }) => player_id);

      if (gameIds.length > 0) {
        await client.query(
          `INSERT INTO deleted_games (game_id)
           SELECT UNNEST($1::uuid[])
           ON CONFLICT (game_id) DO NOTHING`,
          [gameIds],
        );
        await client.query("DELETE FROM game_sessions WHERE id = ANY($1::uuid[])", [gameIds]);
        await client.query("DELETE FROM game_events WHERE game_id = ANY($1::uuid[])", [gameIds]);
        await client.query("DELETE FROM game_results WHERE game_id = ANY($1::uuid[])", [gameIds]);
      }
      await client.query("DELETE FROM players WHERE id = $1", [id]);
      if (affectedPlayers.length > 0) {
        await client.query(
          `UPDATE players AS p
              SET last_played_at = (
                    SELECT MAX(history.played_at)
                      FROM (
                        SELECT result.played_at
                          FROM game_player_results AS player_result
                          JOIN game_results AS result ON result.game_id = player_result.game_id
                         WHERE player_result.player_id = p.id
                        UNION ALL
                        SELECT hosted.played_at
                          FROM game_results AS hosted
                         WHERE hosted.host_player_id = p.id
                      ) AS history
                  ),
                  updated_at = NOW()
            WHERE p.id = ANY($1::uuid[])`,
          [affectedPlayers],
        );
      }
      await client.query("COMMIT");
      return "deleted";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async saveGameResults(input: GameResultsInput): Promise<void> {
    const hostPlayerId = input.hostPlayerId ?? null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE game_results, game_player_results IN ROW EXCLUSIVE MODE");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.gameId]);
      await assertGameNotDeleted(client, input.gameId);
      await assertLegacyGameMutationAllowed(client, input.gameId);
      const previousResult = await client.query<{ host_player_id: string | null }>(
        "SELECT host_player_id FROM game_results WHERE game_id = $1",
        [input.gameId],
      );
      await client.query(
        `INSERT INTO game_results (game_id, winner, played_at, host_player_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (game_id) DO UPDATE
           SET winner = EXCLUDED.winner,
               played_at = EXCLUDED.played_at,
               host_player_id = EXCLUDED.host_player_id`,
        [input.gameId, input.winner, input.playedAt, hostPlayerId],
      );
      const previousResults = await client.query<{ player_id: string }>(
        "SELECT player_id FROM game_player_results WHERE game_id = $1",
        [input.gameId],
      );
      const affectedPlayerIds = [
        ...new Set([
          ...previousResults.rows.map(({ player_id }) => player_id),
          ...input.players.map(({ playerId }) => playerId),
          ...previousResult.rows.flatMap(({ host_player_id }) =>
            host_player_id === null ? [] : [host_player_id],
          ),
          ...(hostPlayerId === null ? [] : [hostPlayerId]),
        ]),
      ];
      await client.query("DELETE FROM game_player_results WHERE game_id = $1", [input.gameId]);

      for (const player of input.players) {
        await client.query(
          `INSERT INTO game_player_results
             (game_id, player_id, seat, role, team, final_status, fouls, won)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $5 = $8)`,
          [
            input.gameId,
            player.playerId,
            player.seat,
            player.role,
            player.team,
            player.status,
            player.fouls,
            input.winner,
          ],
        );
      }
      await client.query(
        `UPDATE players AS p
            SET last_played_at = (
                  SELECT MAX(history.played_at)
                    FROM (
                      SELECT result.played_at
                        FROM game_player_results AS player_result
                        JOIN game_results AS result ON result.game_id = player_result.game_id
                       WHERE player_result.player_id = p.id
                      UNION ALL
                      SELECT hosted.played_at
                        FROM game_results AS hosted
                       WHERE hosted.host_player_id = p.id
                    ) AS history
                ),
                updated_at = NOW()
          WHERE p.id = ANY($1::uuid[])`,
        [affectedPlayerIds],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async deleteGameResults(gameId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE game_results, game_player_results IN ROW EXCLUSIVE MODE");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [gameId]);
      await assertGameNotDeleted(client, gameId);
      await assertLegacyGameMutationAllowed(client, gameId);
      const participants = await client.query<{ player_id: string }>(
        "SELECT player_id FROM game_player_results WHERE game_id = $1",
        [gameId],
      );
      const result = await client.query<{ host_player_id: string | null }>(
        "DELETE FROM game_results WHERE game_id = $1 RETURNING host_player_id",
        [gameId],
      );
      const affectedPlayerIds = [
        ...new Set([
          ...participants.rows.map(({ player_id }) => player_id),
          ...result.rows.flatMap(({ host_player_id }) =>
            host_player_id === null ? [] : [host_player_id],
          ),
        ]),
      ];
      await client.query(
        `UPDATE players AS p
            SET last_played_at = (
                  SELECT MAX(history.played_at)
                    FROM (
                      SELECT result.played_at
                        FROM game_player_results AS player_result
                        JOIN game_results AS result ON result.game_id = player_result.game_id
                       WHERE player_result.player_id = p.id
                      UNION ALL
                      SELECT hosted.played_at
                        FROM game_results AS hosted
                       WHERE hosted.host_player_id = p.id
                    ) AS history
                ),
                updated_at = NOW()
          WHERE p.id = ANY($1::uuid[])`,
        [affectedPlayerIds],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

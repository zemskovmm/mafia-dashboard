import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  assertGameNotDeleted,
  assertLegacyGameMutationAllowed,
  lockClubGame,
} from "./game-lifecycle.js";
import { initializeSchema } from "./initialize-schema.js";
import { DEFAULT_CLUB_ID } from "./club-store.js";

export class ManagerLockedError extends Error {
  public readonly code = "manager_locked";

  public constructor() {
    super("The club creator manager cannot be demoted");
    this.name = "ManagerLockedError";
  }
}

export class OwnerProfileForbiddenError extends Error {
  public readonly code = "owner_profile_forbidden";

  public constructor() {
    super("Only the linked club creator can mutate the locked Owner profile");
    this.name = "OwnerProfileForbiddenError";
  }
}

export class ClubAccessConsentRequiredError extends Error {
  public readonly code = "club_access_consent_required";

  public constructor() {
    super("Club access requires consent unless this is the linked club creator");
    this.name = "ClubAccessConsentRequiredError";
  }
}

export type PlayerClubAccess = "none" | "user" | "manager";

export interface PlayerProfileInput {
  readonly nickname: string;
  readonly consent: boolean;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string | null;
  readonly clubAccess?: PlayerClubAccess;
}

interface PlayerStatistics {
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
  readonly bestMoves: number;
  readonly bestMoveMafiaHits: number;
}

export interface PlayerProfile extends Omit<PlayerProfileInput, "clubAccess"> {
  readonly id: string;
  readonly clubAccess: PlayerClubAccess;
  readonly managerLocked: boolean;
  readonly consentAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastPlayedAt: Date | null;
  readonly statistics: PlayerStatistics;
}

interface GamePlayerResultInput {
  readonly playerId: string;
  readonly seat: number;
  readonly role: "sheriff" | "citizen" | "mafia" | "don";
  readonly team: "red" | "black";
  readonly status: "active" | "eliminated" | "red-carded";
  readonly fouls: number;
  readonly bestMoveHits?: number | null;
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
  club_access: PlayerClubAccess;
  manager_locked: boolean;
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
  best_moves: number;
  best_move_mafia_hits: number;
}

const mapPlayer = (row: PlayerRow): PlayerProfile => ({
  id: row.id,
  nickname: row.nickname,
  consent: row.data_processing_consent,
  firstName: row.first_name,
  lastName: row.last_name,
  email: row.email,
  clubAccess: row.club_access,
  managerLocked: row.manager_locked,
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
    bestMoves: row.best_moves,
    bestMoveMafiaHits: row.best_move_mafia_hits,
  },
});

const profileSelect = `
  SELECT p.id, p.nickname, p.first_name, p.last_name, p.email,
         p.club_access,
         (p.club_access = 'manager' AND EXISTS (
            SELECT 1 FROM clubs AS club
             WHERE club.id = p.club_id AND club.created_by = p.user_id
          )) AS manager_locked,
         p.data_processing_consent, p.consent_at, p.created_at, p.updated_at,
         p.last_played_at,
         (SELECT COUNT(*)::int FROM game_results hosted
           WHERE hosted.club_id = p.club_id AND hosted.host_player_id = p.id)
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
         COUNT(r.player_id) FILTER (WHERE r.final_status = 'red-carded')::int AS red_cards,
         COUNT(r.player_id) FILTER (WHERE r.best_move_hits IS NOT NULL)::int AS best_moves,
         COALESCE(SUM(r.best_move_hits), 0)::int AS best_move_mafia_hits
    FROM players p
    LEFT JOIN game_player_results r ON r.club_id = p.club_id AND r.player_id = p.id`;

const profileGroupAndOrder = `
   GROUP BY p.id
   ORDER BY p.last_played_at DESC NULLS LAST, LOWER(p.nickname) ASC, p.id ASC`;

export class PlayerStore {
  public constructor(private readonly pool: Pool) {}

  public async initialize(): Promise<void> {
    await initializeSchema(this.pool);
  }

  public async list(clubId = DEFAULT_CLUB_ID): Promise<readonly PlayerProfile[]> {
    const result = await this.pool.query<PlayerRow>(
      `${profileSelect} WHERE p.club_id = $1 ${profileGroupAndOrder}`,
      [clubId],
    );
    return result.rows.map(mapPlayer);
  }

  public async get(id: string, clubId = DEFAULT_CLUB_ID): Promise<PlayerProfile | null> {
    const result = await this.pool.query<PlayerRow>(
      `${profileSelect} WHERE p.id = $1 AND p.club_id = $2 ${profileGroupAndOrder}`,
      [id, clubId],
    );
    return result.rows[0] === undefined ? null : mapPlayer(result.rows[0]);
  }

  public async create(input: PlayerProfileInput, clubId = DEFAULT_CLUB_ID): Promise<PlayerProfile> {
    const id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const clubAccess = input.clubAccess ?? "none";
      if (clubAccess !== "none" && !input.consent) {
        throw new ClubAccessConsentRequiredError();
      }
      const linkedUser =
        clubAccess !== "none" && input.email !== null
          ? (
              await client.query<{ id: string }>(
                `SELECT id FROM users
                  WHERE LOWER(BTRIM(email)) = LOWER(BTRIM($1))
                  ORDER BY created_at, id
                  LIMIT 1`,
                [input.email],
              )
            ).rows[0]
          : undefined;
      await client.query(
        `INSERT INTO players
           (id, club_id, nickname, first_name, last_name, email, data_processing_consent,
            consent_at, club_access, user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 THEN NOW() ELSE NULL END, $8, $9)`,
        [
          id,
          clubId,
          input.nickname.trim(),
          input.firstName,
          input.lastName,
          input.email,
          input.consent,
          clubAccess,
          linkedUser?.id ?? null,
        ],
      );
      if (linkedUser !== undefined) {
        await client.query(
          `INSERT INTO club_memberships (club_id, user_id, role, access_player_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (club_id, user_id) DO UPDATE
             SET role = EXCLUDED.role
           WHERE club_memberships.access_player_id = EXCLUDED.access_player_id`,
          [clubId, linkedUser.id, clubAccess, id],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const player = await this.get(id, clubId);
    if (player === null) throw new Error("Created player was not found");
    return player;
  }

  public async update(
    id: string,
    input: PlayerProfileInput,
    clubId: string,
    actorUserId: string,
  ): Promise<PlayerProfile | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = (
        await client.query<{
          user_id: string | null;
          club_access: PlayerClubAccess;
          manager_locked: boolean;
        }>(
          `SELECT player.user_id,
                  player.club_access,
                  (player.club_access = 'manager' AND player.user_id = club.created_by) AS manager_locked
             FROM players AS player
             JOIN clubs AS club ON club.id = player.club_id
            WHERE player.id = $1 AND player.club_id = $2
            FOR UPDATE OF player`,
          [id, clubId],
        )
      ).rows[0];
      if (existing === undefined) {
        await client.query("COMMIT");
        return null;
      }

      const clubAccess = input.clubAccess ?? "none";
      if (existing.manager_locked && existing.user_id !== actorUserId) {
        throw new OwnerProfileForbiddenError();
      }
      if (existing.manager_locked && clubAccess !== "manager") {
        throw new ManagerLockedError();
      }
      if (clubAccess !== "none" && !input.consent && !existing.manager_locked) {
        throw new ClubAccessConsentRequiredError();
      }
      const linkedUser =
        clubAccess !== "none" && input.email !== null
          ? (
              await client.query<{ id: string }>(
                `SELECT id FROM users
                  WHERE LOWER(BTRIM(email)) = LOWER(BTRIM($1))
                  ORDER BY created_at, id
                  LIMIT 1`,
                [input.email],
              )
            ).rows[0]
          : undefined;
      const linkedUserId = existing.manager_locked ? existing.user_id : (linkedUser?.id ?? null);

      if (existing.user_id !== null && existing.user_id !== linkedUserId) {
        await client.query(
          `DELETE FROM club_memberships
            WHERE club_id = $1 AND access_player_id = $2`,
          [clubId, id],
        );
      }
      await client.query(
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
                club_access = $7,
                user_id = $8,
                updated_at = NOW()
          WHERE id = $1 AND club_id = $9`,
        [
          id,
          input.nickname.trim(),
          input.firstName,
          input.lastName,
          input.email,
          input.consent,
          clubAccess,
          linkedUserId,
          clubId,
        ],
      );

      if (linkedUserId !== null) {
        await client.query(
          `INSERT INTO club_memberships (club_id, user_id, role, access_player_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (club_id, user_id) DO UPDATE
             SET role = EXCLUDED.role
           WHERE club_memberships.access_player_id = EXCLUDED.access_player_id`,
          [clubId, linkedUserId, clubAccess, id],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.get(id, clubId);
  }

  public async delete(
    id: string,
    clubId = DEFAULT_CLUB_ID,
  ): Promise<"deleted" | "not_found" | "active_game" | "manager_locked"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "LOCK TABLE game_results, game_player_results, game_events IN SHARE ROW EXCLUSIVE MODE",
      );
      await client.query("LOCK TABLE game_session_players IN SHARE MODE");
      const locked = await client.query<{ id: string }>(
        "SELECT id FROM players WHERE id = $1 AND club_id = $2 FOR UPDATE",
        [id, clubId],
      );
      if (locked.rowCount === 0) {
        await client.query("COMMIT");
        return "not_found";
      }
      const playerAccess = (
        await client.query<{ user_id: string | null; manager_locked: boolean }>(
          `SELECT player.user_id,
                  (player.club_access = 'manager' AND player.user_id = club.created_by) AS manager_locked
             FROM players AS player
             JOIN clubs AS club ON club.id = player.club_id
            WHERE player.id = $1 AND player.club_id = $2`,
          [id, clubId],
        )
      ).rows[0]!;
      if (playerAccess.manager_locked) {
        await client.query("COMMIT");
        return "manager_locked";
      }
      const activeGame = await client.query(
        `SELECT 1
           FROM game_session_players
          WHERE club_id = $2 AND player_id = $1
          LIMIT 1`,
        [id, clubId],
      );
      if (activeGame.rowCount !== 0) {
        await client.query("COMMIT");
        return "active_game";
      }
      const currentGames = await client.query<{ game_id: string }>(
        `SELECT game_id FROM game_player_results WHERE club_id = $2 AND player_id = $1
         UNION
         SELECT game_id FROM game_results WHERE club_id = $2 AND host_player_id = $1
         ORDER BY game_id`,
        [id, clubId],
      );
      const gameIds = currentGames.rows.map(({ game_id }) => game_id);
      const affectedPlayers =
        gameIds.length === 0
          ? []
          : (
              await client.query<{ player_id: string }>(
                `SELECT player_id
                   FROM game_player_results
                  WHERE club_id = $2 AND game_id = ANY($1::uuid[])
                 UNION
                 SELECT host_player_id AS player_id
                   FROM game_results
                  WHERE club_id = $2 AND game_id = ANY($1::uuid[])
                    AND host_player_id IS NOT NULL`,
                [gameIds, clubId],
              )
            ).rows.map(({ player_id }) => player_id);

      if (gameIds.length > 0) {
        await client.query(
          `INSERT INTO deleted_games (game_id, club_id)
           SELECT game_id, $2 FROM UNNEST($1::uuid[]) AS game_id
           ON CONFLICT (club_id, game_id) DO NOTHING`,
          [gameIds, clubId],
        );
        await client.query(
          "DELETE FROM game_sessions WHERE club_id = $2 AND id = ANY($1::uuid[])",
          [gameIds, clubId],
        );
        await client.query(
          "DELETE FROM game_events WHERE club_id = $2 AND game_id = ANY($1::uuid[])",
          [gameIds, clubId],
        );
        await client.query(
          "DELETE FROM game_results WHERE club_id = $2 AND game_id = ANY($1::uuid[])",
          [gameIds, clubId],
        );
      }
      const linkedUserId = playerAccess.user_id;
      if (linkedUserId !== null) {
        await client.query(
          `DELETE FROM club_memberships
            WHERE club_id = $1 AND access_player_id = $2`,
          [clubId, id],
        );
      }
      await client.query("DELETE FROM players WHERE id = $1 AND club_id = $2", [id, clubId]);
      if (affectedPlayers.length > 0) {
        await client.query(
          `UPDATE players AS p
              SET last_played_at = (
                    SELECT MAX(history.played_at)
                      FROM (
                        SELECT result.played_at
                          FROM game_player_results AS player_result
                          JOIN game_results AS result
                            ON result.club_id = player_result.club_id
                           AND result.game_id = player_result.game_id
                         WHERE player_result.club_id = p.club_id
                           AND player_result.player_id = p.id
                        UNION ALL
                        SELECT hosted.played_at
                          FROM game_results AS hosted
                         WHERE hosted.club_id = p.club_id
                           AND hosted.host_player_id = p.id
                      ) AS history
                  ),
                  updated_at = NOW()
            WHERE p.club_id = $2 AND p.id = ANY($1::uuid[])`,
          [affectedPlayers, clubId],
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

  public async saveGameResults(input: GameResultsInput, clubId = DEFAULT_CLUB_ID): Promise<void> {
    const hostPlayerId = input.hostPlayerId ?? null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE game_results, game_player_results IN ROW EXCLUSIVE MODE");
      await lockClubGame(client, clubId, input.gameId);
      await assertGameNotDeleted(client, clubId, input.gameId);
      await assertLegacyGameMutationAllowed(client, clubId, input.gameId);
      const participantIds = [
        ...input.players.map(({ playerId }) => playerId),
        ...(hostPlayerId === null ? [] : [hostPlayerId]),
      ];
      const participants = await client.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM players WHERE club_id = $1 AND id = ANY($2::uuid[])",
        [clubId, participantIds],
      );
      if (participants.rows[0]?.count !== participantIds.length) {
        throw new Error("All game participants must belong to the selected club");
      }
      const previousResult = await client.query<{ host_player_id: string | null }>(
        "SELECT host_player_id FROM game_results WHERE game_id = $1 AND club_id = $2",
        [input.gameId, clubId],
      );
      await client.query(
        `INSERT INTO game_results (game_id, club_id, winner, played_at, host_player_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (club_id, game_id) DO UPDATE
           SET winner = EXCLUDED.winner,
               played_at = EXCLUDED.played_at,
               host_player_id = EXCLUDED.host_player_id`,
        [input.gameId, clubId, input.winner, input.playedAt, hostPlayerId],
      );
      const previousResults = await client.query<{ player_id: string }>(
        "SELECT player_id FROM game_player_results WHERE club_id = $2 AND game_id = $1",
        [input.gameId, clubId],
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
      await client.query("DELETE FROM game_player_results WHERE club_id = $2 AND game_id = $1", [
        input.gameId,
        clubId,
      ]);

      for (const player of input.players) {
        await client.query(
          `INSERT INTO game_player_results
             (club_id, game_id, player_id, seat, role, team, final_status, fouls, won,
              best_move_hits)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $6 = $9, $10)`,
          [
            clubId,
            input.gameId,
            player.playerId,
            player.seat,
            player.role,
            player.team,
            player.status,
            player.fouls,
            input.winner,
            player.bestMoveHits ?? null,
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
                        JOIN game_results AS result
                          ON result.club_id = player_result.club_id
                         AND result.game_id = player_result.game_id
                       WHERE player_result.club_id = p.club_id
                         AND player_result.player_id = p.id
                      UNION ALL
                      SELECT hosted.played_at
                        FROM game_results AS hosted
                       WHERE hosted.club_id = p.club_id
                         AND hosted.host_player_id = p.id
                    ) AS history
                ),
                updated_at = NOW()
          WHERE p.club_id = $2 AND p.id = ANY($1::uuid[])`,
        [affectedPlayerIds, clubId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async deleteGameResults(gameId: string, clubId = DEFAULT_CLUB_ID): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE game_results, game_player_results IN ROW EXCLUSIVE MODE");
      await lockClubGame(client, clubId, gameId);
      await assertGameNotDeleted(client, clubId, gameId);
      await assertLegacyGameMutationAllowed(client, clubId, gameId);
      const participants = await client.query<{ player_id: string }>(
        "SELECT player_id FROM game_player_results WHERE club_id = $2 AND game_id = $1",
        [gameId, clubId],
      );
      const result = await client.query<{ host_player_id: string | null }>(
        "DELETE FROM game_results WHERE game_id = $1 AND club_id = $2 RETURNING host_player_id",
        [gameId, clubId],
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
                        JOIN game_results AS result
                          ON result.club_id = player_result.club_id
                         AND result.game_id = player_result.game_id
                       WHERE player_result.club_id = p.club_id
                         AND player_result.player_id = p.id
                      UNION ALL
                      SELECT hosted.played_at
                        FROM game_results AS hosted
                       WHERE hosted.club_id = p.club_id
                         AND hosted.host_player_id = p.id
                    ) AS history
                ),
                updated_at = NOW()
          WHERE p.club_id = $2 AND p.id = ANY($1::uuid[])`,
        [affectedPlayerIds, clubId],
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

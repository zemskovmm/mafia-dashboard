import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import {
  DeletedGameError,
  assertGameNotDeleted,
  lockAggregateProjectionTables,
  lockClubActiveGame,
  lockClubGame,
} from "./game-lifecycle.js";
import { GameSessionStore } from "./game-session-store.js";
import { PlayerStore } from "./player-store.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://mafia:mafia@127.0.0.1:54329/mafia_test";
const schemaName = `game_lifecycle_test_${randomUUID().replaceAll("-", "")}`;
const bootstrapPool = new Pool({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const players = new PlayerStore(pool);

beforeAll(async () => {
  await bootstrapPool.query(`CREATE SCHEMA ${schemaName}`);
  await players.initialize();
});

afterAll(async () => {
  await pool.end();
  await bootstrapPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await bootstrapPool.end();
});

const nickname = (base: string): string => `${base}-${randomUUID().slice(0, 8)}`;
const canonicalHash = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

describe("game lifecycle", () => {
  it("clears current aggregate rows, recomputes profiles, and leaves a tombstone", async () => {
    const host = await players.create({
      nickname: nickname("Lifecycle host"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const participant = await players.create({
      nickname: nickname("Lifecycle player"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const gameId = randomUUID();
    const playedAt = new Date("2026-08-18T08:00:00.000Z");

    await pool.query(
      `INSERT INTO game_results
         (club_id, game_id, outcome, winner, reason, played_at, host_player_id)
       VALUES ($1, $2, 'red', 'red', NULL, $3, $4)`,
      [DEFAULT_CLUB_ID, gameId, playedAt, host.id],
    );
    await pool.query(
      `INSERT INTO game_player_results
         (club_id, game_id, player_id, seat, role, team, final_status, fouls, won, best_move_hits)
       VALUES ($1, $2, $3, 1, 'citizen', 'red', 'active', 0, TRUE, NULL)`,
      [DEFAULT_CLUB_ID, gameId, participant.id],
    );
    await pool.query(
      "UPDATE players SET last_played_at = $1 WHERE club_id = $2 AND id = ANY($3::uuid[])",
      [playedAt, DEFAULT_CLUB_ID, [host.id, participant.id]],
    );
    await pool.query(
      `INSERT INTO game_events
         (id, club_id, game_id, sequence, idempotency_key, event_type, phase, payload,
          replay_version, replay_sequence, phase_after, day_before, day_after, state_hash_after)
       VALUES ($1, $2, $3, 1, $4, 'game.completed', 'finished', $5::jsonb,
               1, 1, 'finished', 1, 1, $6)`,
      [
        randomUUID(),
        DEFAULT_CLUB_ID,
        gameId,
        randomUUID(),
        JSON.stringify({ winner: "red" }),
        canonicalHash(gameId),
      ],
    );

    await new GameSessionStore(pool).clear({
      gameId,
      claim: { claimId: randomUUID(), claimGeneration: 0 },
    });

    await expect(
      pool.query<{ count: number }>(
        `SELECT (
           (SELECT COUNT(*) FROM game_results WHERE club_id = $1 AND game_id = $2) +
           (SELECT COUNT(*) FROM game_events WHERE club_id = $1 AND game_id = $2)
         )::int AS count`,
        [DEFAULT_CLUB_ID, gameId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      pool.query("SELECT 1 FROM deleted_games WHERE club_id = $1 AND game_id = $2", [
        DEFAULT_CLUB_ID,
        gameId,
      ]),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(players.get(host.id)).resolves.toMatchObject({ lastPlayedAt: null });
    await expect(players.get(participant.id)).resolves.toMatchObject({
      lastPlayedAt: null,
      statistics: { gamesPlayed: 0, hostedGames: 0 },
    });
  });

  it("checks tombstones inside the requested club only", async () => {
    const gameId = randomUUID();
    const client = {
      query: vi.fn().mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({ rowCount: 1 }),
    } as unknown as PoolClient;

    await expect(assertGameNotDeleted(client, DEFAULT_CLUB_ID, gameId)).resolves.toBeUndefined();
    await expect(assertGameNotDeleted(client, "foreign-club", gameId)).rejects.toMatchObject({
      name: DeletedGameError.name,
      code: "game_deleted",
    });
    expect(client.query).toHaveBeenNthCalledWith(
      1,
      "SELECT 1 FROM deleted_games WHERE club_id = $1 AND game_id = $2",
      [DEFAULT_CLUB_ID, gameId],
    );
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      "SELECT 1 FROM deleted_games WHERE club_id = $1 AND game_id = $2",
      ["foreign-club", gameId],
    );
  });

  it("uses scoped lifecycle locks before touching aggregate projections", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rowCount: 0 }) } as unknown as PoolClient;

    await lockClubActiveGame(client, DEFAULT_CLUB_ID);
    await lockClubGame(client, DEFAULT_CLUB_ID, "game-id");
    await lockAggregateProjectionTables(client);

    expect(client.query).toHaveBeenNthCalledWith(
      1,
      "SELECT pg_advisory_xact_lock(hashtextextended('active-game:' || $1, 0))",
      [DEFAULT_CLUB_ID],
    );
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      "SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))",
      [DEFAULT_CLUB_ID, "game-id"],
    );
    expect(client.query).toHaveBeenNthCalledWith(
      3,
      "LOCK TABLE game_results, game_player_results, game_events IN ROW EXCLUSIVE MODE",
    );
    expect(client.query).toHaveBeenNthCalledWith(
      4,
      "LOCK TABLE game_session_players IN ROW EXCLUSIVE MODE",
    );
  });
});

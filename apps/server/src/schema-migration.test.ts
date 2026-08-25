import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import { initializeSchema } from "./initialize-schema.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://mafia:mafia@127.0.0.1:54329/mafia_test";
const adminPool = new Pool({ connectionString: databaseUrl });
const legacyOwnerId = "00000000-0000-4000-8000-000000000001";

afterAll(async () => {
  await adminPool.end();
});

const constraintDefinitions = async (pool: Pool) =>
  (
    await pool.query<{ table_name: string; definition: string }>(
      `SELECT relation.relname AS table_name, pg_get_constraintdef(constraint_row.oid) AS definition
         FROM pg_constraint AS constraint_row
         JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = current_schema()
          AND relation.relname IN (
          'game_sessions', 'deleted_games', 'game_session_mutations',
          'game_session_players', 'game_results', 'game_player_results'
        )
          AND constraint_row.contype IN ('p', 'f', 'u')
        ORDER BY relation.relname, definition`,
    )
  ).rows;

describe("tenant-composite game schema migration", () => {
  it("migrates fresh and populated legacy schemas idempotently without losing replay rows", async () => {
    const schemaName = `tenant_game_keys_${randomUUID().replaceAll("-", "")}`;
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    const isolatedPool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName}`,
    });
    try {
      await initializeSchema(isolatedPool);
      expect(await constraintDefinitions(isolatedPool)).toEqual(
        expect.arrayContaining([
          { table_name: "deleted_games", definition: "PRIMARY KEY (club_id, game_id)" },
          { table_name: "game_sessions", definition: "PRIMARY KEY (club_id, id)" },
          {
            table_name: "game_session_mutations",
            definition:
              "FOREIGN KEY (club_id, game_id) REFERENCES game_sessions(club_id, id) ON DELETE CASCADE",
          },
          {
            table_name: "game_session_players",
            definition:
              "FOREIGN KEY (club_id, game_id) REFERENCES game_sessions(club_id, id) ON DELETE CASCADE",
          },
          { table_name: "game_results", definition: "PRIMARY KEY (club_id, game_id)" },
          {
            table_name: "game_player_results",
            definition:
              "FOREIGN KEY (club_id, game_id) REFERENCES game_results(club_id, game_id) ON DELETE CASCADE",
          },
        ]),
      );

      await isolatedPool.query(`
        ALTER TABLE game_session_mutations DROP CONSTRAINT game_session_mutations_game_fk;
        ALTER TABLE game_session_players DROP CONSTRAINT game_session_players_game_fk;
        ALTER TABLE game_session_players DROP CONSTRAINT game_session_players_player_fk;
        ALTER TABLE game_results DROP CONSTRAINT game_results_host_player_fk;
        ALTER TABLE game_player_results DROP CONSTRAINT game_player_results_game_fk;
        ALTER TABLE game_player_results DROP CONSTRAINT game_player_results_player_fk;

        ALTER TABLE game_session_mutations DROP CONSTRAINT game_session_mutations_pkey;
        ALTER TABLE game_session_mutations DROP CONSTRAINT game_session_mutations_game_revision_unique;
        ALTER TABLE game_session_players DROP CONSTRAINT game_session_players_pkey;
        ALTER TABLE game_session_players DROP CONSTRAINT game_session_players_game_seat_unique;
        ALTER TABLE game_player_results DROP CONSTRAINT game_player_results_pkey;
        ALTER TABLE game_player_results DROP CONSTRAINT game_player_results_game_seat_unique;

        ALTER TABLE game_session_mutations DROP COLUMN club_id;
        ALTER TABLE game_session_players DROP COLUMN club_id;
        ALTER TABLE game_player_results DROP COLUMN club_id;

        ALTER TABLE game_sessions DROP CONSTRAINT game_sessions_pkey;
        ALTER TABLE game_sessions ADD CONSTRAINT game_sessions_pkey PRIMARY KEY (id);
        ALTER TABLE deleted_games DROP CONSTRAINT deleted_games_pkey;
        ALTER TABLE deleted_games ADD CONSTRAINT deleted_games_pkey PRIMARY KEY (game_id);
        ALTER TABLE game_results DROP CONSTRAINT game_results_pkey;
        ALTER TABLE game_results ADD CONSTRAINT game_results_pkey PRIMARY KEY (game_id);

        ALTER TABLE game_session_mutations
          ADD CONSTRAINT game_session_mutations_pkey PRIMARY KEY (game_id, mutation_id),
          ADD CONSTRAINT game_session_mutations_game_id_revision_key UNIQUE (game_id, revision),
          ADD CONSTRAINT game_session_mutations_game_id_fkey
            FOREIGN KEY (game_id) REFERENCES game_sessions (id) ON DELETE CASCADE;
        ALTER TABLE game_session_players
          ADD CONSTRAINT game_session_players_pkey PRIMARY KEY (game_id, player_id),
          ADD CONSTRAINT game_session_players_game_id_seat_key UNIQUE (game_id, seat),
          ADD CONSTRAINT game_session_players_game_id_fkey
            FOREIGN KEY (game_id) REFERENCES game_sessions (id) ON DELETE CASCADE,
          ADD CONSTRAINT game_session_players_player_id_fkey
            FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE RESTRICT;
        ALTER TABLE game_results
          ADD CONSTRAINT game_results_host_player_id_fkey
            FOREIGN KEY (host_player_id) REFERENCES players (id) ON DELETE RESTRICT;
        ALTER TABLE game_player_results
          ADD CONSTRAINT game_player_results_pkey PRIMARY KEY (game_id, player_id),
          ADD CONSTRAINT game_player_results_game_id_seat_key UNIQUE (game_id, seat),
          ADD CONSTRAINT game_player_results_game_id_fkey
            FOREIGN KEY (game_id) REFERENCES game_results (game_id) ON DELETE CASCADE,
          ADD CONSTRAINT game_player_results_player_id_fkey
            FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE RESTRICT;
      `);

      const gameId = randomUUID();
      const deletedGameId = randomUUID();
      const mutationId = randomUUID();
      const playerId = randomUUID();
      await isolatedPool.query(
        "INSERT INTO players (id, club_id, nickname) VALUES ($1, $2, 'Legacy player')",
        [playerId, DEFAULT_CLUB_ID],
      );
      await isolatedPool.query(
        `INSERT INTO game_sessions
           (id, club_id, name, revision, last_mutation_id, state, status)
         VALUES ($1, $2, 'Legacy populated session', 1, $3, '{}'::jsonb, 'active')`,
        [gameId, DEFAULT_CLUB_ID, mutationId],
      );
      await isolatedPool.query(
        `INSERT INTO game_session_mutations (game_id, mutation_id, revision, request)
         VALUES ($1, $2, 1, '{}'::jsonb)`,
        [gameId, mutationId],
      );
      await isolatedPool.query(
        `INSERT INTO game_session_players (game_id, player_id, seat, is_host)
         VALUES ($1, $2, NULL, TRUE)`,
        [gameId, playerId],
      );
      await isolatedPool.query(
        `INSERT INTO game_results (game_id, club_id, winner, played_at, host_player_id)
         VALUES ($1, $2, 'red', '2026-08-18T08:00:00Z', $3)`,
        [gameId, DEFAULT_CLUB_ID, playerId],
      );
      await isolatedPool.query(
        `INSERT INTO game_player_results
           (game_id, player_id, seat, role, team, final_status, fouls, won)
         VALUES ($1, $2, 1, 'citizen', 'red', 'active', 0, TRUE)`,
        [gameId, playerId],
      );
      await isolatedPool.query("INSERT INTO deleted_games (game_id, club_id) VALUES ($1, $2)", [
        deletedGameId,
        DEFAULT_CLUB_ID,
      ]);
      await isolatedPool.query(
        `INSERT INTO game_events
           (id, club_id, game_id, sequence, idempotency_key, event_type, phase, payload, secret)
         SELECT md5('legacy-replay-' || ordinal::text)::uuid, $1, $2, ordinal,
                'legacy-' || ordinal::text, 'legacy.replay', 'day',
                jsonb_build_object('ordinal', ordinal), FALSE
           FROM generate_series(1, 89) AS ordinal`,
        [DEFAULT_CLUB_ID, gameId],
      );

      await initializeSchema(isolatedPool);
      await initializeSchema(isolatedPool);

      expect(
        await isolatedPool.query(
          `SELECT
             (SELECT COUNT(*)::int FROM game_sessions WHERE club_id = $1 AND id = $2) AS sessions,
             (SELECT COUNT(*)::int FROM game_session_mutations WHERE club_id = $1 AND game_id = $2) AS mutations,
             (SELECT COUNT(*)::int FROM game_session_players WHERE club_id = $1 AND game_id = $2) AS roster,
             (SELECT COUNT(*)::int FROM game_results WHERE club_id = $1 AND game_id = $2) AS results,
             (SELECT COUNT(*)::int FROM game_player_results WHERE club_id = $1 AND game_id = $2) AS player_results,
             (SELECT COUNT(*)::int FROM game_events WHERE club_id = $1 AND game_id = $2) AS replay_rows,
             (SELECT COUNT(*)::int FROM deleted_games WHERE club_id = $1 AND game_id = $3) AS tombstones`,
          [DEFAULT_CLUB_ID, gameId, deletedGameId],
        ),
      ).toMatchObject({
        rows: [
          {
            sessions: 1,
            mutations: 1,
            roster: 1,
            results: 1,
            player_results: 1,
            replay_rows: 89,
            tombstones: 1,
          },
        ],
      });

      const secondClubId = randomUUID();
      const secondPlayerId = randomUUID();
      await isolatedPool.query(
        `INSERT INTO clubs (id, name, city, created_by)
         VALUES ($1, 'Second migration club', 'Granada', $2)`,
        [secondClubId, legacyOwnerId],
      );
      await isolatedPool.query(
        "INSERT INTO players (id, club_id, nickname) VALUES ($1, $2, 'Second player')",
        [secondPlayerId, secondClubId],
      );
      await isolatedPool.query(
        `INSERT INTO game_sessions
           (id, club_id, name, revision, last_mutation_id, state, status)
         VALUES ($1, $2, 'Colliding session', 1, $3, '{}'::jsonb, 'active')`,
        [gameId, secondClubId, mutationId],
      );
      await isolatedPool.query(
        `INSERT INTO game_session_mutations (club_id, game_id, mutation_id, revision, request)
         VALUES ($1, $2, $3, 1, '{}'::jsonb)`,
        [secondClubId, gameId, mutationId],
      );
      await isolatedPool.query(
        `INSERT INTO game_session_players (club_id, game_id, player_id, seat, is_host)
         VALUES ($1, $2, $3, NULL, TRUE)`,
        [secondClubId, gameId, secondPlayerId],
      );
      await isolatedPool.query(
        `INSERT INTO game_results (club_id, game_id, winner, played_at, host_player_id)
         VALUES ($1, $2, 'black', '2026-08-18T09:00:00Z', $3)`,
        [secondClubId, gameId, secondPlayerId],
      );
      await isolatedPool.query(
        `INSERT INTO game_player_results
           (club_id, game_id, player_id, seat, role, team, final_status, fouls, won)
         VALUES ($1, $2, $3, 1, 'mafia', 'black', 'active', 0, TRUE)`,
        [secondClubId, gameId, secondPlayerId],
      );
      await isolatedPool.query("INSERT INTO deleted_games (club_id, game_id) VALUES ($1, $2)", [
        secondClubId,
        deletedGameId,
      ]);
      expect(
        await isolatedPool.query(
          `SELECT
             (SELECT COUNT(*)::int FROM game_sessions WHERE id = $1) AS sessions,
             (SELECT COUNT(*)::int FROM game_session_mutations WHERE game_id = $1) AS mutations,
             (SELECT COUNT(*)::int FROM game_session_players WHERE game_id = $1) AS rosters,
             (SELECT COUNT(*)::int FROM game_results WHERE game_id = $1) AS results,
             (SELECT COUNT(*)::int FROM game_player_results WHERE game_id = $1) AS player_results,
             (SELECT COUNT(*)::int FROM deleted_games WHERE game_id = $2) AS tombstones`,
          [gameId, deletedGameId],
        ),
      ).toMatchObject({
        rows: [
          {
            sessions: 2,
            mutations: 2,
            rosters: 2,
            results: 2,
            player_results: 2,
            tombstones: 2,
          },
        ],
      });
    } finally {
      await isolatedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    }
  });
});

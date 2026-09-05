import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import { initializeSchema } from "./initialize-schema.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://mafia:mafia@127.0.0.1:54329/mafia_test";
const adminPool = new Pool({ connectionString: databaseUrl });
const defaultOwnerId = "00000000-0000-4000-8000-000000000001";

afterAll(async () => {
  await adminPool.end();
});

interface IsolatedSchema {
  readonly name: string;
  readonly pool: Pool;
}

const createIsolatedPool = async (schemaName: string): Promise<Pool> => {
  await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
  return new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schemaName}`,
  });
};

const withIsolatedSchema = async <T>(
  prefix: string,
  run: (schema: IsolatedSchema) => Promise<T>,
): Promise<T> => {
  const name = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  const pool = await createIsolatedPool(name);
  try {
    return await run({ name, pool });
  } finally {
    await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
  }
};

const schemaCatalog = async (pool: Pool) => {
  const [tables, columns, constraints, indexes] = await Promise.all([
    pool.query<{ table_name: string }>(`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_type = 'BASE TABLE'
       ORDER BY table_name
    `),
    pool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(`
      SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = current_schema()
       ORDER BY table_name, ordinal_position
    `),
    pool.query<{ table_name: string; conname: string; definition: string }>(`
      SELECT relation.relname AS table_name,
             constraint_row.conname,
             pg_get_constraintdef(constraint_row.oid) AS definition
        FROM pg_constraint AS constraint_row
        JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = current_schema()
       ORDER BY relation.relname, constraint_row.conname
    `),
    pool.query<{
      table_name: string;
      index_name: string;
      is_unique: boolean;
      predicate: string | null;
      columns: string[];
    }>(`
      SELECT table_relation.relname AS table_name,
             index_relation.relname AS index_name,
             index_row.indisunique AS is_unique,
             pg_get_expr(index_row.indpred, index_row.indrelid) AS predicate,
             ARRAY(
               SELECT attribute.attname
                 FROM unnest(index_row.indkey::smallint[]) WITH ORDINALITY
                   AS key_column(attnum, ordinal)
                 JOIN pg_attribute AS attribute
                   ON attribute.attrelid = index_row.indrelid
                  AND attribute.attnum = key_column.attnum
                ORDER BY key_column.ordinal
             )::text[] AS columns
        FROM pg_index AS index_row
        JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
        JOIN pg_class AS table_relation ON table_relation.oid = index_row.indrelid
        JOIN pg_namespace AS namespace ON namespace.oid = table_relation.relnamespace
       WHERE namespace.nspname = current_schema()
       ORDER BY table_relation.relname, index_relation.relname
    `),
  ]);

  return {
    tables: tables.rows,
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
  };
};

const currentTableNames = [
  "club_memberships",
  "clubs",
  "deleted_clubs",
  "deleted_games",
  "game_daily_counters",
  "game_events",
  "game_player_results",
  "game_results",
  "game_rulesets",
  "game_session_mutations",
  "game_session_players",
  "game_sessions",
  "players",
  "user_sessions",
  "users",
  "youtube_oauth_credentials",
];

const expectCurrentCatalog = async (pool: Pool): Promise<void> => {
  const catalog = await schemaCatalog(pool);
  expect(catalog.tables.map(({ table_name }) => table_name)).toEqual(currentTableNames);

  const sessionColumns = catalog.columns
    .filter(({ table_name }) => table_name === "game_sessions")
    .map(({ column_name }) => column_name);
  expect(sessionColumns).toEqual([
    "id",
    "club_id",
    "ruleset_id",
    "ruleset_version",
    "name",
    "revision",
    "last_mutation_id",
    "state",
    "results",
    "status",
    "initial_game",
    "replay_base_event_id",
    "head_event_id",
    "reset_return_event_id",
    "reset_return_was_completed",
    "replay_version",
    "created_at",
    "updated_at",
    "claim_id",
    "claim_generation",
    "claimed_by_user_id",
    "claimed_at",
    "claim_last_seen_at",
    "claim_expires_at",
  ]);
  expect(
    catalog.columns
      .filter(({ table_name }) => table_name === "game_events")
      .map(({ column_name }) => column_name),
  ).toEqual([
    "id",
    "club_id",
    "game_id",
    "sequence",
    "idempotency_key",
    "event_type",
    "phase",
    "seat",
    "payload",
    "parent_event_id",
    "replay_version",
    "replay_sequence",
    "phase_after",
    "day_before",
    "day_after",
    "state_hash_after",
    "created_at",
  ]);

  expect(catalog.constraints).toEqual(
    expect.arrayContaining([
      {
        table_name: "club_memberships",
        conname: "club_memberships_access_player_fk",
        definition:
          "FOREIGN KEY (access_player_id, club_id, user_id) REFERENCES players(id, club_id, user_id) ON DELETE CASCADE",
      },
      {
        table_name: "game_sessions",
        conname: "game_sessions_pkey",
        definition: "PRIMARY KEY (club_id, id)",
      },
      {
        table_name: "game_sessions",
        conname: "game_sessions_claim_metadata_ck",
        definition: expect.stringContaining("claim_generation >= 0"),
      },
      {
        table_name: "game_sessions",
        conname: "game_sessions_claimed_by_user_fk",
        definition:
          "FOREIGN KEY (claimed_by_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
      },
      {
        table_name: "game_session_mutations",
        conname: "game_session_mutations_game_fk",
        definition:
          "FOREIGN KEY (club_id, game_id) REFERENCES game_sessions(club_id, id) ON DELETE CASCADE",
      },
      {
        table_name: "game_session_players",
        conname: "game_session_players_player_fk",
        definition:
          "FOREIGN KEY (club_id, player_id) REFERENCES players(club_id, id) ON DELETE RESTRICT",
      },
      {
        table_name: "game_results",
        conname: "game_results_shape_ck",
        definition: expect.stringContaining("draw"),
      },
      {
        table_name: "game_player_results",
        conname: "game_player_results_game_fk",
        definition:
          "FOREIGN KEY (club_id, game_id) REFERENCES game_results(club_id, game_id) ON DELETE CASCADE",
      },
      {
        table_name: "players",
        conname: "players_access_provenance_unique",
        definition: "UNIQUE (id, club_id, user_id)",
      },
      {
        table_name: "players",
        conname: "players_access_requires_consent_ck",
        definition: expect.stringContaining("data_processing_consent"),
      },
      {
        table_name: "game_events",
        conname: "game_events_replay_metadata_ck",
        definition: expect.stringContaining("sha256:[0-9a-f]{64}"),
      },
    ]),
  );
  expect(catalog.indexes).toEqual(
    expect.arrayContaining([
      {
        table_name: "game_sessions",
        index_name: "game_sessions_one_active_per_club_idx",
        is_unique: true,
        predicate: expect.stringMatching(/status = 'active'/),
        columns: ["club_id"],
      },
      {
        table_name: "game_events",
        index_name: "game_events_club_game_replay_sequence_idx",
        is_unique: true,
        predicate: "(replay_sequence IS NOT NULL)",
        columns: ["club_id", "game_id", "replay_sequence"],
      },
      {
        table_name: "players",
        index_name: "players_club_nickname_unique_idx",
        is_unique: true,
        predicate: null,
        columns: ["club_id"],
      },
    ]),
  );
};

describe("current-schema bootstrap", () => {
  it("creates the complete current catalog, required seeds, and current integrity bounds", async () => {
    await withIsolatedSchema("current_schema_fresh", async ({ pool }) => {
      await initializeSchema(pool);
      await expectCurrentCatalog(pool);

      await expect(
        pool.query(
          `SELECT app_user.id AS user_id, app_user.email, club.id AS club_id, membership.role
             FROM users AS app_user
             JOIN clubs AS club ON club.created_by = app_user.id
             JOIN club_memberships AS membership
               ON membership.club_id = club.id AND membership.user_id = app_user.id
            WHERE app_user.id = $1 AND club.id = $2`,
          [defaultOwnerId, DEFAULT_CLUB_ID],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            user_id: defaultOwnerId,
            email: "owner@mafiamalaga.es",
            role: "manager",
          },
        ],
      });
      await expect(
        pool.query(
          "SELECT id, version, player_count, sheriff_count, citizen_count, mafia_count, don_count FROM game_rulesets",
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            id: "club-mafia",
            version: 1,
            player_count: 10,
            sheriff_count: 1,
            citizen_count: 6,
            mafia_count: 2,
            don_count: 1,
          },
        ],
      });

      await expect(
        pool.query(
          "INSERT INTO players (id, nickname, club_access) VALUES ($1, 'No consent manager', 'manager')",
          [randomUUID()],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "players_access_requires_consent_ck",
      });
      await expect(
        pool.query(
          `INSERT INTO game_results (game_id, outcome, winner, reason, played_at)
           VALUES ($1, 'draw', NULL, NULL, NOW())`,
          [randomUUID()],
        ),
      ).rejects.toMatchObject({ code: "23514", constraint: "game_results_shape_ck" });

      const gameId = randomUUID();
      const event = (stateHashAfter: string) => {
        const eventId = randomUUID();
        return pool.query(
          `INSERT INTO game_events
             (id, game_id, sequence, idempotency_key, event_type, phase, payload,
              replay_sequence, phase_after, day_before, day_after, state_hash_after)
           VALUES ($1, $2, 1, $4, 'game.checkpointed', 'day', '{}'::jsonb,
                   1, 'day', 0, 0, $3)`,
          [eventId, gameId, stateHashAfter, `replay-event-${eventId}`],
        );
      };
      await expect(event("deadbeef")).rejects.toMatchObject({
        code: "23514",
        constraint: "game_events_replay_metadata_ck",
      });
      await expect(event(`sha256:${"a".repeat(64)}`)).resolves.toMatchObject({ rowCount: 1 });

      const activeGameId = randomUUID();
      await pool.query(
        `INSERT INTO game_sessions (id, name, revision, last_mutation_id, state, status)
         VALUES ($1, 'Current active game', 1, $2, '{}'::jsonb, 'active')`,
        [activeGameId, randomUUID()],
      );
      await expect(
        pool.query(
          `INSERT INTO game_sessions (id, name, revision, last_mutation_id, state, status)
           VALUES ($1, 'Another current active game', 1, $2, '{}'::jsonb, 'active')`,
          [randomUUID(), randomUUID()],
        ),
      ).rejects.toMatchObject({
        code: "23505",
        constraint: "game_sessions_one_active_per_club_idx",
      });
    });
  });

  it("does not recreate the deleted default club or its membership", async () => {
    await withIsolatedSchema("current_schema_tombstone", async ({ pool }) => {
      await initializeSchema(pool);
      await pool.query("INSERT INTO deleted_clubs (club_id) VALUES ($1)", [DEFAULT_CLUB_ID]);
      await pool.query("DELETE FROM players WHERE club_id = $1", [DEFAULT_CLUB_ID]);
      await pool.query("DELETE FROM clubs WHERE id = $1", [DEFAULT_CLUB_ID]);

      await initializeSchema(pool);

      await expect(
        pool.query(
          `SELECT
             (SELECT COUNT(*)::int FROM clubs WHERE id = $1) AS clubs,
             (SELECT COUNT(*)::int FROM club_memberships WHERE club_id = $1) AS memberships`,
          [DEFAULT_CLUB_ID],
        ),
      ).resolves.toMatchObject({ rows: [{ clubs: 0, memberships: 0 }] });
    });
  });

  it("recreates missing default bootstrap records when no tombstone exists", async () => {
    await withIsolatedSchema("current_schema_seed_rerun", async ({ pool }) => {
      await initializeSchema(pool);
      await pool.query("DELETE FROM players WHERE club_id = $1", [DEFAULT_CLUB_ID]);
      await pool.query("DELETE FROM clubs WHERE id = $1", [DEFAULT_CLUB_ID]);

      await initializeSchema(pool);

      await expect(
        pool.query(
          `SELECT
             (SELECT COUNT(*)::int FROM clubs WHERE id = $1) AS clubs,
             (SELECT COUNT(*)::int FROM club_memberships WHERE club_id = $1) AS memberships,
             (SELECT COUNT(*)::int FROM players WHERE club_id = $1 AND club_access = 'manager') AS managers`,
          [DEFAULT_CLUB_ID],
        ),
      ).resolves.toMatchObject({ rows: [{ clubs: 1, memberships: 1, managers: 1 }] });
    });
  });

  it("reopens a populated current schema without catalog or row churn", async () => {
    await withIsolatedSchema("current_schema_rerun", async ({ pool }) => {
      await initializeSchema(pool);
      const clubId = randomUUID();
      const userId = randomUUID();
      const playerId = randomUUID();
      const hostPlayerId = randomUUID();
      const gameId = randomUUID();
      const mutationId = randomUUID();
      const eventId = randomUUID();
      const state = {
        version: 5,
        legacyLog: [{ type: "setup.player-added", playerId }],
        setup: { selectedPlayerIds: [playerId] },
      };
      const initialGame = { id: gameId, phase: "day", players: [{ id: playerId, seat: 1 }] };
      const results = { outcome: "red", winner: "red", reason: null };

      await pool.query(
        "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Current owner')",
        [userId, `current-${userId}@example.test`],
      );
      await pool.query(
        `INSERT INTO clubs (id, name, city, created_by)
         VALUES ($1, 'Current rerun club', 'Málaga', $2)`,
        [clubId, userId],
      );
      await pool.query(
        `INSERT INTO players (id, club_id, nickname)
         VALUES ($1, $2, 'Current player'), ($3, $2, 'Current host')`,
        [playerId, clubId, hostPlayerId],
      );
      await pool.query(
        `INSERT INTO game_sessions
           (id, club_id, name, revision, last_mutation_id, state, results, status,
            initial_game, replay_base_event_id, head_event_id)
         VALUES ($1, $2, 'Current completed game', 3, $3, $4::jsonb, $5::jsonb, 'completed',
                 $6::jsonb, $7, $7)`,
        [
          gameId,
          clubId,
          mutationId,
          JSON.stringify(state),
          JSON.stringify(results),
          JSON.stringify(initialGame),
          eventId,
        ],
      );
      await pool.query(
        `INSERT INTO game_session_mutations (club_id, game_id, mutation_id, revision, request)
         VALUES ($1, $2, $3, 3, '{"operation":"snapshot"}'::jsonb)`,
        [clubId, gameId, mutationId],
      );
      await pool.query(
        `INSERT INTO game_session_players (club_id, game_id, player_id, seat, is_host, role)
         VALUES ($1, $2, $3, 1, FALSE, 'sheriff'), ($1, $2, $4, NULL, TRUE, NULL)`,
        [clubId, gameId, playerId, hostPlayerId],
      );
      await pool.query(
        `INSERT INTO game_events
           (id, club_id, game_id, sequence, idempotency_key, event_type, phase, payload,
            replay_sequence, phase_after, day_before, day_after, state_hash_after)
         VALUES ($1, $2, $3, 1, 'current-event', 'game.started', 'day', '{}'::jsonb,
                 1, 'day', 0, 0, $4)`,
        [eventId, clubId, gameId, `sha256:${"b".repeat(64)}`],
      );
      await pool.query(
        `INSERT INTO game_results (club_id, game_id, outcome, winner, reason, played_at, host_player_id)
         VALUES ($1, $2, 'red', 'red', NULL, '2026-09-05T00:00:00Z', $3)`,
        [clubId, gameId, hostPlayerId],
      );
      await pool.query(
        `INSERT INTO game_player_results
           (club_id, game_id, player_id, seat, role, team, final_status, fouls, won)
         VALUES ($1, $2, $3, 1, 'sheriff', 'red', 'active', 0, TRUE)`,
        [clubId, gameId, playerId],
      );

      const beforeCatalog = await schemaCatalog(pool);
      const beforeRows = (
        await pool.query(
          `SELECT session.state, session.results, session.initial_game,
                  session.revision, session.xmin::text AS row_version,
                  event.state_hash_after, event.xmin::text AS event_row_version,
                  mutation.request, mutation.xmin::text AS mutation_row_version
             FROM game_sessions AS session
             JOIN game_events AS event
               ON event.club_id = session.club_id AND event.game_id = session.id
             JOIN game_session_mutations AS mutation
               ON mutation.club_id = session.club_id AND mutation.game_id = session.id
            WHERE session.club_id = $1 AND session.id = $2`,
          [clubId, gameId],
        )
      ).rows;

      await initializeSchema(pool);

      expect(await schemaCatalog(pool)).toEqual(beforeCatalog);
      expect(
        (
          await pool.query(
            `SELECT session.state, session.results, session.initial_game,
                    session.revision, session.xmin::text AS row_version,
                    event.state_hash_after, event.xmin::text AS event_row_version,
                    mutation.request, mutation.xmin::text AS mutation_row_version
               FROM game_sessions AS session
               JOIN game_events AS event
                 ON event.club_id = session.club_id AND event.game_id = session.id
               JOIN game_session_mutations AS mutation
                 ON mutation.club_id = session.club_id AND mutation.game_id = session.id
              WHERE session.club_id = $1 AND session.id = $2`,
            [clubId, gameId],
          )
        ).rows,
      ).toEqual(beforeRows);
    });
  });

  it("rejects an incomplete current-looking schema before it repairs or rewrites it", async () => {
    await withIsolatedSchema("current_schema_reject", async ({ pool }) => {
      await initializeSchema(pool);
      await pool.query("ALTER TABLE game_sessions DROP COLUMN claim_generation");
      const beforeCatalog = await schemaCatalog(pool);

      await expect(initializeSchema(pool)).rejects.toThrow("Unsupported existing database schema");

      expect(await schemaCatalog(pool)).toEqual(beforeCatalog);
      await expect(
        pool.query(
          `SELECT column_name
             FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'game_sessions'
              AND column_name = 'claim_generation'`,
        ),
      ).resolves.toMatchObject({ rows: [] });
    });
  });

  it.each([
    ["game_sessions_one_active_per_club_idx", "game_sessions", "status = 'active'"],
    ["game_events_club_game_replay_sequence_idx", "game_events", "replay_sequence IS NOT NULL"],
  ])(
    "rejects incorrect key columns in %s without repairing the index",
    async (name, table, predicate) => {
      await withIsolatedSchema("wrong_index_keys", async ({ pool }) => {
        await initializeSchema(pool);
        await pool.query(`DROP INDEX ${name}`);
        await pool.query(`CREATE UNIQUE INDEX ${name} ON ${table} (id) WHERE ${predicate}`);
        const beforeCatalog = await schemaCatalog(pool);

        await expect(initializeSchema(pool)).rejects.toThrow(
          "Unsupported existing database schema",
        );
        expect(await schemaCatalog(pool)).toEqual(beforeCatalog);
      });
    },
  );

  it("rejects an old partial schema without creating current tables or seeds", async () => {
    await withIsolatedSchema("old_schema_reject", async ({ pool }) => {
      const userId = randomUUID();
      await pool.query(`
        CREATE TABLE users (
          id UUID PRIMARY KEY,
          email TEXT NOT NULL UNIQUE
        );
      `);
      await pool.query("INSERT INTO users (id, email) VALUES ($1, 'old@example.test')", [userId]);
      const beforeCatalog = await schemaCatalog(pool);
      const beforeRows = (await pool.query("SELECT id, email FROM users")).rows;

      await expect(initializeSchema(pool)).rejects.toThrow("Unsupported existing database schema");

      expect(await schemaCatalog(pool)).toEqual(beforeCatalog);
      expect((await pool.query("SELECT id, email FROM users")).rows).toEqual(beforeRows);
    });
  });

  it("serializes concurrent current bootstraps with the transaction advisory lock", async () => {
    await withIsolatedSchema("current_schema_lock", async ({ pool }) => {
      const locker = await pool.connect();
      let released = false;
      try {
        await locker.query("BEGIN");
        await locker.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('mafia_dashboard_schema', 0))",
        );
        let completed = false;
        const blockedInitialization = initializeSchema(pool).then(() => {
          completed = true;
        });

        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(completed).toBe(false);

        await locker.query("COMMIT");
        released = true;
        await blockedInitialization;
        await expectCurrentCatalog(pool);
      } finally {
        if (!released) await locker.query("ROLLBACK").catch(() => undefined);
        locker.release();
      }
    });
  });

  it("rolls back a physical partial write when schema execution fails", async () => {
    await withIsolatedSchema("current_schema_rollback", async ({ pool }) => {
      const realClient = await pool.connect();
      let released = false;
      const failingPool = {
        connect: async () => ({
          query: async (query: string) => {
            if (query.includes("CREATE TABLE")) {
              await realClient.query("CREATE TABLE bootstrap_rollback_probe (id INTEGER)");
              throw new Error("injected schema execution failure");
            }
            return realClient.query(query);
          },
          release: () => {
            released = true;
            realClient.release();
          },
        }),
      } as unknown as Pool;

      await expect(initializeSchema(failingPool)).rejects.toThrow(
        "injected schema execution failure",
      );
      expect(released).toBe(true);
      await expect(
        pool.query("SELECT to_regclass('bootstrap_rollback_probe')::text AS relation_name"),
      ).resolves.toMatchObject({ rows: [{ relation_name: null }] });
      await expect(schemaCatalog(pool)).resolves.toMatchObject({ tables: [] });
    });
  });
});

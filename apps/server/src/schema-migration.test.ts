import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import { initializeSchema } from "./initialize-schema.js";
import { GameSessionStore } from "./game-session-store.js";
import { TournamentStore } from "./tournament-store.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://mafia@127.0.0.1:54329/mafia_test";
const adminPool = new Pool({ connectionString: databaseUrl });

const withSchema = async (name: string, test: (pool: Pool) => Promise<void>) => {
  const schemaName = `${name}_${randomUUID().replaceAll("-", "")}`;
  await adminPool.query(`CREATE SCHEMA ${schemaName}`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
  try {
    await test(pool);
  } finally {
    await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  }
};

afterAll(async () => adminPool.end());

const sessionColumns = async (pool: Pool) =>
  (
    await pool.query<{ column_name: string }>(`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'game_sessions'
       ORDER BY ordinal_position
    `)
  ).rows.map(({ column_name }) => column_name);

describe("current-only game-record schema initialization", () => {
  it("upgrades only the exact immediately preceding catalog without touching accepted rows or retry/deletion metadata", async () => {
    await withSchema("tournament_preceding", async (pool) => {
      await initializeSchema(pool);
      const games = new GameSessionStore(pool);
      const created = await games.create({
        creationId: randomUUID(),
        name: "Raw retained",
        state: { opaque: [1, { hash: "Unchanged-CASE" }] },
        results: null,
      });
      const deletedCreation = randomUUID();
      const deleted = await games.create({
        creationId: deletedCreation,
        name: "Deleted",
        state: {},
        results: null,
      });
      await games.clear({ gameId: deleted.gameId });
      await pool.query("DROP TABLE game_tournaments; DROP TABLE tournaments");
      const before = await pool.query(
        "SELECT row_to_json(g)::text AS raw FROM game_sessions g ORDER BY id",
      );
      const tombstones = await pool.query(
        "SELECT row_to_json(g)::text AS raw FROM deleted_games g ORDER BY game_id",
      );
      const mappings = await pool.query(
        "SELECT row_to_json(g)::text AS raw FROM game_session_creations g ORDER BY creation_id",
      );
      await initializeSchema(pool);
      expect(
        (await pool.query("SELECT row_to_json(g)::text AS raw FROM game_sessions g ORDER BY id"))
          .rows,
      ).toEqual(before.rows);
      expect(
        (
          await pool.query(
            "SELECT row_to_json(g)::text AS raw FROM deleted_games g ORDER BY game_id",
          )
        ).rows,
      ).toEqual(tombstones.rows);
      expect(
        (
          await pool.query(
            "SELECT row_to_json(g)::text AS raw FROM game_session_creations g ORDER BY creation_id",
          )
        ).rows,
      ).toEqual(mappings.rows);
      expect((await games.get(created.gameId))?.tournamentId).toBeNull();
      const tournament = await new TournamentStore(pool).create("Retained event", DEFAULT_CLUB_ID);
      await new TournamentStore(pool).assign(created.gameId, tournament.id, DEFAULT_CLUB_ID);
      await initializeSchema(pool);
      expect((await games.get(created.gameId))?.tournamentId).toBe(tournament.id);
      await expect(
        games.create({
          creationId: deletedCreation,
          name: "Do not revive",
          state: {},
          results: null,
        }),
      ).rejects.toMatchObject({ code: "game_deleted" });
    });
  });
  it.each([
    "DROP TABLE game_tournaments",
    "ALTER TABLE tournaments DROP CONSTRAINT tournaments_name_key_unique; ALTER TABLE tournaments ADD CONSTRAINT tournaments_name_key_unique UNIQUE (club_id,name)",
    "DROP TABLE game_tournaments; DROP TABLE tournaments; ALTER TABLE game_sessions ADD COLUMN old_claim UUID",
    "DROP TABLE game_tournaments; DROP TABLE tournaments; ALTER TABLE players ALTER COLUMN club_access SET DEFAULT 'user'",
    "DROP TABLE game_tournaments; DROP TABLE tournaments; ALTER TABLE players ENABLE ROW LEVEL SECURITY",
    "ALTER TABLE tournaments ADD COLUMN extra TEXT GENERATED ALWAYS AS (name) STORED",
    "DROP TABLE game_tournaments; DROP TABLE tournaments; DROP INDEX players_club_nickname_unique_idx; CREATE UNIQUE INDEX players_club_nickname_unique_idx ON players(id) WHERE retired_at IS NULL",
  ])("rejects partial or drifted tournament boundary before mutation: %s", async (ddl) => {
    await withSchema("tournament_drift", async (pool) => {
      await initializeSchema(pool);
      await pool.query(ddl);
      const before = (
        await pool.query(
          "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() ORDER BY c.relname",
        )
      ).rows;
      await expect(initializeSchema(pool)).rejects.toThrow("Unsupported existing database schema");
      expect(
        (
          await pool.query(
            "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() ORDER BY c.relname",
          )
        ).rows,
      ).toEqual(before);
    });
  });
  it("creates a claim-free catalog that permits multiple active records and retains creation mappings", async () => {
    await withSchema("game_record_target", async (pool) => {
      await initializeSchema(pool);
      const columns = await sessionColumns(pool);
      expect(columns).not.toEqual(
        expect.arrayContaining(["claim_id", "claim_generation", "claim_expires_at"]),
      );
      await expect(
        pool.query("SELECT 1 FROM game_session_creations LIMIT 0"),
      ).resolves.toMatchObject({ rowCount: 0 });
      await expect(
        pool.query(
          "SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'game_sessions_one_active_per_club_idx'",
        ),
      ).resolves.toMatchObject({ rowCount: 0 });
      const gameIds = [randomUUID(), randomUUID()];
      for (const id of gameIds) {
        await pool.query(
          `INSERT INTO game_sessions (id, club_id, name, revision, last_mutation_id, state, results, status)
           VALUES ($1, $2, 'Current active record', 1, $3, '{"kept":true}'::jsonb, NULL, 'active')`,
          [id, DEFAULT_CLUB_ID, randomUUID()],
        );
      }
      const creationId = randomUUID();
      await pool.query(
        "INSERT INTO game_session_creations (club_id, creation_id, game_id) VALUES ($1, $2, $3)",
        [DEFAULT_CLUB_ID, creationId, gameIds[0]],
      );
      const deletedId = randomUUID();
      await pool.query("INSERT INTO deleted_games (club_id, game_id) VALUES ($1, $2)", [
        DEFAULT_CLUB_ID,
        deletedId,
      ]);
      const readBack = async () => ({
        games: (await pool.query("SELECT * FROM game_sessions ORDER BY id")).rows,
        creations: (await pool.query("SELECT * FROM game_session_creations ORDER BY creation_id"))
          .rows,
        tombstones: (await pool.query("SELECT * FROM deleted_games ORDER BY game_id")).rows,
        columns: await sessionColumns(pool),
      });
      const before = await readBack();
      expect(before.games).toHaveLength(2);
      expect(before.creations).toEqual([
        expect.objectContaining({ creation_id: creationId, game_id: gameIds[0] }),
      ]);
      expect(before.tombstones).toEqual([expect.objectContaining({ game_id: deletedId })]);
      await initializeSchema(pool);
      expect(await readBack()).toEqual(before);
    });
  });

  it("rejects the populated prior claim-controlled catalog without changing its data or structure", async () => {
    await withSchema("game_record_legacy", async (pool) => {
      await initializeSchema(pool);
      const gameId = randomUUID();
      const state = { preserved: "snapshot", game: { phase: "old-client" } };
      await pool.query(
        `INSERT INTO game_sessions (id, club_id, name, revision, last_mutation_id, state, results, status)
         VALUES ($1, $2, 'Preserved legacy record', 7, $3, $4::jsonb, NULL, 'active')`,
        [gameId, DEFAULT_CLUB_ID, randomUUID(), JSON.stringify(state)],
      );
      await pool.query("DROP TABLE game_session_creations");
      await pool.query(`
        ALTER TABLE game_sessions
          ADD COLUMN claim_id UUID NULL,
          ADD COLUMN claim_generation BIGINT NOT NULL DEFAULT 0,
          ADD COLUMN claimed_by_user_id UUID NULL,
          ADD COLUMN claimed_at TIMESTAMPTZ NULL,
          ADD COLUMN claim_last_seen_at TIMESTAMPTZ NULL,
          ADD COLUMN claim_expires_at TIMESTAMPTZ NULL,
          ADD CONSTRAINT game_sessions_claim_metadata_ck CHECK (
            claim_generation >= 0 AND (
              (claim_id IS NULL AND claimed_by_user_id IS NULL AND claimed_at IS NULL
                AND claim_last_seen_at IS NULL AND claim_expires_at IS NULL)
              OR
              (claim_id IS NOT NULL AND claim_generation > 0 AND claimed_by_user_id IS NOT NULL
                AND claimed_at IS NOT NULL AND claim_last_seen_at IS NOT NULL AND claim_expires_at IS NOT NULL
                AND claim_last_seen_at >= claimed_at AND claim_expires_at > claim_last_seen_at)
            )
          ),
          ADD CONSTRAINT game_sessions_claimed_by_user_fk
            FOREIGN KEY (claimed_by_user_id) REFERENCES users (id) ON UPDATE RESTRICT ON DELETE RESTRICT
      `);
      await pool.query(
        "CREATE UNIQUE INDEX game_sessions_one_active_per_club_idx ON game_sessions (club_id) WHERE status = 'active'",
      );

      const capture = async () => ({
        data: (
          await pool.query(
            "SELECT row_to_json(g)::text AS raw FROM game_sessions AS g WHERE id = $1",
            [gameId],
          )
        ).rows,
        tables: (
          await pool.query(`SELECT table_name FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`)
        ).rows,
        columns: (
          await pool.query(`SELECT table_name, column_name, udt_name, is_nullable
            FROM information_schema.columns WHERE table_schema = current_schema()
            ORDER BY table_name, ordinal_position`)
        ).rows,
        constraints: (
          await pool.query(`SELECT conname, pg_get_constraintdef(c.oid) AS definition
            FROM pg_constraint AS c JOIN pg_namespace AS n ON n.oid = c.connamespace
            WHERE n.nspname = current_schema() ORDER BY conname`)
        ).rows,
        indexes: (
          await pool.query(`SELECT indexname, indexdef FROM pg_indexes
            WHERE schemaname = current_schema() ORDER BY indexname`)
        ).rows,
      });
      const before = await capture();
      expect(before.data).toHaveLength(1);
      expect(before.data[0].raw).toContain("Preserved legacy record");
      expect(before.columns).toEqual(
        expect.arrayContaining([expect.objectContaining({ column_name: "claim_id" })]),
      );
      expect(before.indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ indexname: "game_sessions_one_active_per_club_idx" }),
        ]),
      );
      expect(before.constraints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ conname: "game_sessions_claim_metadata_ck" }),
        ]),
      );
      expect(before.tables).not.toEqual(
        expect.arrayContaining([{ table_name: "game_session_creations" }]),
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(initializeSchema(pool)).rejects.toThrow(
          "Unsupported existing database schema",
        );
        expect(await capture()).toEqual(before);
      }
    });
  });

  it.each([
    ["catalog column type", "ALTER TABLE players ALTER COLUMN nickname TYPE VARCHAR(80)"],
    ["catalog nullability", "ALTER TABLE players ALTER COLUMN updated_at DROP NOT NULL"],
    [
      "unrelated integrity constraint",
      "ALTER TABLE players DROP CONSTRAINT players_access_requires_consent_ck",
    ],
    [
      "weakened critical constraint definition",
      "ALTER TABLE game_results DROP CONSTRAINT game_results_shape_ck; ALTER TABLE game_results ADD CONSTRAINT game_results_shape_ck CHECK (true)",
    ],
    ["unrelated index", "DROP INDEX players_club_nickname_unique_idx"],
    [
      "retired nickname index predicate",
      "DROP INDEX players_club_nickname_unique_idx; CREATE UNIQUE INDEX players_club_nickname_unique_idx ON players (club_id, LOWER(BTRIM(nickname)))",
    ],
    [
      "critical index keys",
      "DROP INDEX game_events_club_game_replay_sequence_idx; CREATE UNIQUE INDEX game_events_club_game_replay_sequence_idx ON game_events (id) WHERE replay_sequence IS NOT NULL",
    ],
  ])("refuses %s drift before attempting to repair it", async (_description, ddl) => {
    await withSchema("game_record_drift", async (pool) => {
      await initializeSchema(pool);
      await pool.query(ddl);
      await expect(initializeSchema(pool)).rejects.toThrow("Unsupported existing database schema");
      await expect(initializeSchema(pool)).rejects.toThrow("Unsupported existing database schema");
    });
  });

  it("rejects a partial catalog without repairing its rows or relations", async () => {
    await withSchema("game_record_reject", async (pool) => {
      await initializeSchema(pool);
      const id = randomUUID();
      await pool.query(
        `INSERT INTO game_sessions (id, club_id, name, revision, last_mutation_id, state, results, status)
         VALUES ($1, $2, 'Partial record', 1, $3, '{"untouched":true}'::jsonb, NULL, 'active')`,
        [id, DEFAULT_CLUB_ID, randomUUID()],
      );
      await pool.query("DROP TABLE game_session_creations");
      await pool.query("ALTER TABLE game_sessions ADD COLUMN claim_id UUID NULL");

      const before = await pool.query(
        "SELECT row_to_json(g)::text AS raw FROM game_sessions AS g WHERE id = $1",
        [id],
      );
      await expect(initializeSchema(pool)).rejects.toThrow("Unsupported existing database schema");
      await expect(pool.query("SELECT 1 FROM game_session_creations LIMIT 0")).rejects.toThrow();
      await expect(sessionColumns(pool)).resolves.toContain("claim_id");
      expect(
        (
          await pool.query(
            "SELECT row_to_json(g)::text AS raw FROM game_sessions AS g WHERE id = $1",
            [id],
          )
        ).rows,
      ).toEqual(before.rows);
    });
  });

  it("rejects an unknown catalog without adding application tables or changing its row", async () => {
    await withSchema("game_record_unknown", async (pool) => {
      await pool.query("CREATE TABLE unrelated (value TEXT NOT NULL)");
      await pool.query("INSERT INTO unrelated (value) VALUES ('leave intact')");
      const before = await pool.query("SELECT * FROM unrelated");
      await expect(initializeSchema(pool)).rejects.toThrow("Unsupported existing database schema");
      expect((await pool.query("SELECT * FROM unrelated")).rows).toEqual(before.rows);
      expect(
        (
          await pool.query(
            `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name`,
          )
        ).rows,
      ).toEqual([{ table_name: "unrelated" }]);
    });
  });
});

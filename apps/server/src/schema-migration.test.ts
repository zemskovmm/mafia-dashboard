import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import { initializeSchema } from "./initialize-schema.js";

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

describe("server-backed game-record schema upgrade", () => {
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
    });
  });

  it("upgrades the immediately previous populated claim-controlled catalog in place", async () => {
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

      // An unrelated drift must not consume the one-time claim migration.
      await pool.query("ALTER TABLE players DROP CONSTRAINT players_access_requires_consent_ck");
      await expect(initializeSchema(pool)).rejects.toThrow("Unsupported existing database schema");
      await expect(sessionColumns(pool)).resolves.toContain("claim_id");
      await expect(pool.query("SELECT 1 FROM game_session_creations LIMIT 0")).rejects.toThrow();
      await pool.query(`ALTER TABLE players ADD CONSTRAINT players_access_requires_consent_ck
        CHECK (club_access = 'none' OR data_processing_consent OR user_id IS NOT NULL)`);

      await initializeSchema(pool);

      await expect(
        pool.query("SELECT id, revision, state FROM game_sessions WHERE club_id = $1 AND id = $2", [
          DEFAULT_CLUB_ID,
          gameId,
        ]),
      ).resolves.toMatchObject({ rows: [{ id: gameId, revision: 7, state }] });
      const columns = await sessionColumns(pool);
      expect(columns).not.toEqual(
        expect.arrayContaining(["claim_id", "claim_generation", "claimed_by_user_id"]),
      );
      await expect(
        pool.query(
          `INSERT INTO game_sessions (id, club_id, name, revision, last_mutation_id, state, results, status)
           VALUES ($1, $2, 'Second active', 1, $3, '{}'::jsonb, NULL, 'active')`,
          [randomUUID(), DEFAULT_CLUB_ID, randomUUID()],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    });
  });

  it.each([
    ["catalog column type", "ALTER TABLE players ALTER COLUMN nickname TYPE VARCHAR(80)"],
    ["catalog nullability", "ALTER TABLE players ALTER COLUMN nickname DROP NOT NULL"],
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

  it("rejects partial or unknown catalogs before applying an upgrade", async () => {
    await withSchema("game_record_reject", async (pool) => {
      await initializeSchema(pool);
      await pool.query("DROP TABLE game_session_creations");
      await pool.query("ALTER TABLE game_sessions ADD COLUMN claim_id UUID NULL");

      await expect(initializeSchema(pool)).rejects.toThrow("Unsupported existing database schema");
      await expect(pool.query("SELECT 1 FROM game_session_creations LIMIT 0")).rejects.toThrow();
      await expect(sessionColumns(pool)).resolves.toContain("claim_id");
    });
  });
});

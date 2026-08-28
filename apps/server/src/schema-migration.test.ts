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

const createIsolatedPool = async (schemaName: string): Promise<Pool> => {
  await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
  return new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schemaName}`,
  });
};

const dropIsolatedPool = async (schemaName: string, pool: Pool): Promise<void> => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
};

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

describe("club authorization role migration", () => {
  it("reconciles fresh and populated schemas to manager/user access idempotently", async () => {
    const freshSchema = `club_roles_fresh_${randomUUID().replaceAll("-", "")}`;
    const populatedSchema = `club_roles_populated_${randomUUID().replaceAll("-", "")}`;
    const freshPool = await createIsolatedPool(freshSchema);
    const populatedPool = await createIsolatedPool(populatedSchema);
    try {
      await initializeSchema(freshPool);
      await initializeSchema(populatedPool);

      await populatedPool.query(`
        DROP INDEX IF EXISTS club_memberships_access_player_unique_idx;
        ALTER TABLE club_memberships
          DROP CONSTRAINT IF EXISTS club_memberships_access_player_fk;
        ALTER TABLE club_memberships ADD COLUMN manager_player_id UUID NULL;
        ALTER TABLE club_memberships
          DROP CONSTRAINT club_memberships_role_ck;
        UPDATE club_memberships SET role = 'owner' WHERE role = 'manager';
        ALTER TABLE club_memberships
          ADD CONSTRAINT club_memberships_role_check CHECK (role IN ('owner', 'editor'));
        ALTER TABLE club_memberships DROP COLUMN access_player_id;

        DROP INDEX IF EXISTS players_club_access_email_unique_idx;
        ALTER TABLE players DROP CONSTRAINT players_access_requires_consent_ck;
        ALTER TABLE players DROP CONSTRAINT players_club_access_ck;
        ALTER TABLE players ADD COLUMN is_club_manager BOOLEAN NOT NULL DEFAULT FALSE;
        UPDATE players SET is_club_manager = club_access = 'manager';
        ALTER TABLE players DROP COLUMN club_access;
        ALTER TABLE players
          ADD CONSTRAINT players_manager_requires_consent_ck CHECK (
            NOT is_club_manager OR data_processing_consent OR user_id IS NOT NULL
          );
        CREATE UNIQUE INDEX players_club_manager_email_unique_idx
          ON players (club_id, LOWER(BTRIM(email)))
          WHERE is_club_manager;
      `);

      const managerId = randomUUID();
      const managerPlayerId = randomUUID();
      await populatedPool.query(
        `INSERT INTO users (id, email, display_name)
         VALUES ($1, $2, 'Legacy editor')`,
        [managerId, `legacy-editor-${managerId}@example.test`],
      );
      await populatedPool.query(
        `INSERT INTO players
           (id, club_id, nickname, first_name, last_name, email,
            data_processing_consent, consent_at, is_club_manager, user_id)
         VALUES ($1, $2, 'Legacy editor', 'Legacy', 'Editor', $3,
                 TRUE, NOW(), TRUE, $4)`,
        [managerPlayerId, DEFAULT_CLUB_ID, `legacy-editor-${managerId}@example.test`, managerId],
      );
      await populatedPool.query(
        `INSERT INTO club_memberships (club_id, user_id, role, manager_player_id)
         VALUES ($1, $2, 'editor', $3)`,
        [DEFAULT_CLUB_ID, managerId, managerPlayerId],
      );

      await initializeSchema(populatedPool);
      const regularUserId = randomUUID();
      await populatedPool.query(
        "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Regular user')",
        [regularUserId, `regular-${regularUserId}@example.test`],
      );
      await populatedPool.query(
        "INSERT INTO club_memberships (club_id, user_id, role) VALUES ($1, $2, 'user')",
        [DEFAULT_CLUB_ID, regularUserId],
      );
      await initializeSchema(populatedPool);
      await expect(
        populatedPool.query(
          "SELECT role FROM club_memberships WHERE club_id = $1 AND user_id = $2",
          [DEFAULT_CLUB_ID, regularUserId],
        ),
      ).resolves.toMatchObject({ rows: [{ role: "user" }] });

      for (const pool of [freshPool, populatedPool]) {
        await expect(
          pool.query(
            `SELECT pg_get_constraintdef(oid) AS definition
               FROM pg_constraint
              WHERE conrelid = 'club_memberships'::regclass
                AND conname = 'club_memberships_role_ck'`,
          ),
        ).resolves.toMatchObject({
          rows: [{ definition: expect.stringMatching(/manager.*user|user.*manager/) }],
        });
        await expect(
          pool.query(
            `SELECT column_name
               FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'players'
                AND column_name IN ('club_access', 'is_club_manager')
              ORDER BY column_name`,
          ),
        ).resolves.toMatchObject({ rows: [{ column_name: "club_access" }] });
        await expect(
          pool.query(
            `SELECT column_name
               FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'club_memberships'
                AND column_name IN ('access_player_id', 'manager_player_id')
              ORDER BY column_name`,
          ),
        ).resolves.toMatchObject({ rows: [{ column_name: "access_player_id" }] });
      }

      await expect(
        populatedPool.query(
          `SELECT membership.role, membership.access_player_id, player.club_access
             FROM club_memberships AS membership
             JOIN players AS player ON player.id = membership.access_player_id
            WHERE membership.club_id = $1 AND membership.user_id = $2`,
          [DEFAULT_CLUB_ID, managerId],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            role: "manager",
            access_player_id: managerPlayerId,
            club_access: "manager",
          },
        ],
      });
      await expect(
        populatedPool.query(
          "SELECT role FROM club_memberships WHERE club_id = $1 AND user_id = $2",
          [DEFAULT_CLUB_ID, legacyOwnerId],
        ),
      ).resolves.toMatchObject({ rows: [{ role: "manager" }] });
    } finally {
      await dropIsolatedPool(freshSchema, freshPool);
      await dropIsolatedPool(populatedSchema, populatedPool);
    }
  });
});

describe("club language schema migration", () => {
  it("adds a constrained English default to fresh and populated schemas idempotently", async () => {
    const freshSchema = `club_language_fresh_${randomUUID().replaceAll("-", "")}`;
    const legacySchema = `club_language_legacy_${randomUUID().replaceAll("-", "")}`;
    const freshPool = await createIsolatedPool(freshSchema);
    const legacyPool = await createIsolatedPool(legacySchema);
    try {
      await initializeSchema(freshPool);
      await legacyPool.query(`
        CREATE TABLE users (
          id UUID PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL
        );
        CREATE TABLE clubs (
          id UUID PRIMARY KEY,
          name TEXT NOT NULL,
          city TEXT NOT NULL,
          header_logo TEXT NULL,
          card_logo TEXT NULL,
          created_by UUID NOT NULL REFERENCES users (id),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      const legacyUserId = randomUUID();
      const legacyClubId = randomUUID();
      await legacyPool.query(
        `INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Legacy owner')`,
        [legacyUserId, `legacy-${randomUUID()}@example.test`],
      );
      await legacyPool.query(
        `INSERT INTO clubs (id, name, city, created_by)
         VALUES ($1, 'Legacy club', 'Málaga', $2)`,
        [legacyClubId, legacyUserId],
      );

      await initializeSchema(legacyPool);
      const partialClubId = randomUUID();
      await legacyPool.query(`
        ALTER TABLE clubs ALTER COLUMN language_code DROP NOT NULL;
        ALTER TABLE clubs ALTER COLUMN language_code DROP DEFAULT;
      `);
      await legacyPool.query(
        `INSERT INTO clubs (id, name, city, created_by, language_code)
         VALUES ($1, 'Partial migration club', 'Granada', $2, NULL)`,
        [partialClubId, legacyUserId],
      );
      await initializeSchema(legacyPool);

      for (const pool of [freshPool, legacyPool]) {
        await expect(
          pool.query(
            `SELECT data_type, is_nullable, column_default
               FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'clubs'
                AND column_name = 'language_code'`,
          ),
        ).resolves.toMatchObject({
          rows: [{ data_type: "text", is_nullable: "NO", column_default: "'en'::text" }],
        });
        await expect(
          pool.query(
            `SELECT pg_get_constraintdef(oid) AS definition
               FROM pg_constraint
              WHERE conrelid = 'clubs'::regclass
                AND conname = 'clubs_language_code_ck'`,
          ),
        ).resolves.toMatchObject({
          rows: [
            {
              definition: expect.stringContaining("language_code"),
            },
          ],
        });
      }
      await expect(
        legacyPool.query("SELECT id, language_code FROM clubs WHERE id IN ($1, $2) ORDER BY id", [
          legacyClubId,
          partialClubId,
        ]),
      ).resolves.toMatchObject({
        rows: expect.arrayContaining([
          { id: legacyClubId, language_code: "en" },
          { id: partialClubId, language_code: "en" },
        ]),
      });
      await expect(
        legacyPool.query("UPDATE clubs SET language_code = 'es' WHERE id = $1", [legacyClubId]),
      ).rejects.toMatchObject({ constraint: "clubs_language_code_ck" });
    } finally {
      await dropIsolatedPool(freshSchema, freshPool);
      await dropIsolatedPool(legacySchema, legacyPool);
    }
  });
});

describe("replay metadata constraint migration", () => {
  it("enforces replay and day bounds on fresh and upgrade-created columns", async () => {
    const schemaName = `replay_metadata_bounds_${randomUUID().replaceAll("-", "")}`;
    const isolatedPool = await createIsolatedPool(schemaName);
    const constraints = [
      ["game_events_replay_sequence_positive_ck", "replay_sequence", -1],
      ["game_events_day_before_nonnegative_ck", "day_before", -1],
      ["game_events_day_after_nonnegative_ck", "day_after", -1],
    ] as const;
    const expectBounds = async () => {
      const installed = await isolatedPool.query<{ conname: string }>(
        `SELECT conname
           FROM pg_constraint
          WHERE conrelid = 'game_events'::regclass
            AND conname = ANY($1::text[])
          ORDER BY conname`,
        [constraints.map(([name]) => name)],
      );
      expect(installed.rows.map(({ conname }) => conname)).toEqual(
        constraints.map(([name]) => name).sort(),
      );
      for (const [constraint, column, value] of constraints) {
        const metadata = {
          replay_sequence: 1,
          day_before: 0,
          day_after: 0,
          [column]: value,
        };
        await expect(
          isolatedPool.query(
            `INSERT INTO game_events
               (id, game_id, sequence, idempotency_key, event_type, phase, payload,
                replay_sequence, phase_after, day_before, day_after, state_hash_after)
             VALUES ($1::uuid, $2, 1, $1::text, 'game.checkpointed', 'day', '{}'::jsonb,
                     $3, 'day', $4, $5, 'deadbeef')`,
            [
              randomUUID(),
              randomUUID(),
              metadata.replay_sequence,
              metadata.day_before,
              metadata.day_after,
            ],
          ),
        ).rejects.toMatchObject({ code: "23514", constraint });
      }
    };

    try {
      await initializeSchema(isolatedPool);
      await expectBounds();

      await isolatedPool.query(`
        ALTER TABLE game_events DROP COLUMN replay_sequence CASCADE;
        ALTER TABLE game_events DROP COLUMN day_before CASCADE;
        ALTER TABLE game_events DROP COLUMN day_after CASCADE;
      `);
      await initializeSchema(isolatedPool);
      await initializeSchema(isolatedPool);
      await expectBounds();
    } finally {
      await dropIsolatedPool(schemaName, isolatedPool);
    }
  });
});

describe("tenant-composite game schema migration", () => {
  it("migrates fresh and populated legacy schemas idempotently without losing replay rows", async () => {
    const schemaName = `tenant_game_keys_${randomUUID().replaceAll("-", "")}`;
    const isolatedPool = await createIsolatedPool(schemaName);
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
        DROP INDEX IF EXISTS club_memberships_manager_player_unique_idx;
        DROP INDEX IF EXISTS club_memberships_access_player_unique_idx;
        ALTER TABLE club_memberships
          DROP CONSTRAINT IF EXISTS club_memberships_manager_role_ck;
        ALTER TABLE club_memberships
          DROP CONSTRAINT IF EXISTS club_memberships_manager_player_fk;
        ALTER TABLE club_memberships
          DROP CONSTRAINT IF EXISTS club_memberships_access_player_fk;
        ALTER TABLE club_memberships
          DROP CONSTRAINT IF EXISTS club_memberships_role_ck;
        UPDATE club_memberships SET role = 'owner' WHERE role = 'manager';
        ALTER TABLE club_memberships
          ADD CONSTRAINT club_memberships_role_check CHECK (role IN ('owner', 'editor'));
        ALTER TABLE players
          DROP CONSTRAINT IF EXISTS players_manager_provenance_unique;
        ALTER TABLE players
          DROP CONSTRAINT IF EXISTS players_access_provenance_unique;
        ALTER TABLE club_memberships DROP COLUMN IF EXISTS manager_player_id;
        ALTER TABLE club_memberships DROP COLUMN IF EXISTS access_player_id;
        DELETE FROM players;
        DROP INDEX IF EXISTS players_club_manager_email_unique_idx;
        DROP INDEX IF EXISTS players_club_access_email_unique_idx;
        DROP INDEX IF EXISTS players_club_linked_user_unique_idx;
        ALTER TABLE players DROP CONSTRAINT IF EXISTS players_manager_requires_consent_ck;
        ALTER TABLE players DROP CONSTRAINT IF EXISTS players_access_requires_consent_ck;
        ALTER TABLE players DROP CONSTRAINT IF EXISTS players_club_access_ck;
        ALTER TABLE players DROP CONSTRAINT IF EXISTS players_user_fk;
        ALTER TABLE players DROP COLUMN IF EXISTS user_id;
        ALTER TABLE players DROP COLUMN IF EXISTS is_club_manager;
        ALTER TABLE players DROP COLUMN IF EXISTS club_access;
      `);

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
      const laterMatchingPlayerId = randomUUID();
      const backfilledOwnerUserId = randomUUID();
      const backfilledOwnerClubId = randomUUID();
      await isolatedPool.query(
        `INSERT INTO players
           (id, club_id, nickname, first_name, last_name, email,
            data_processing_consent, consent_at, created_at, updated_at)
         VALUES ($1, $2, 'Legacy player', 'Legacy', 'Owner',
                 ' OWNER@MAFIAMALAGA.ES ', TRUE, '2026-08-18T07:00:00Z',
                 '2026-08-18T07:00:00Z', '2026-08-18T07:00:00Z')`,
        [playerId, DEFAULT_CLUB_ID],
      );
      await isolatedPool.query(
        `INSERT INTO players
           (id, club_id, nickname, first_name, last_name, email,
            data_processing_consent, consent_at, created_at, updated_at)
         VALUES ($1, $2, 'Later matching player', 'Later', 'Match',
                 'owner@mafiamalaga.es', TRUE, '2026-08-18T08:00:00Z',
                 '2026-08-18T08:00:00Z', '2026-08-18T08:00:00Z')`,
        [laterMatchingPlayerId, DEFAULT_CLUB_ID],
      );
      await isolatedPool.query(
        `INSERT INTO users (id, email, display_name, created_at, updated_at)
         VALUES ($1, 'backfill.owner@example.test', 'Ada Lovelace Byron',
                 '2026-08-18T06:00:00Z', '2026-08-18T06:00:00Z')`,
        [backfilledOwnerUserId],
      );
      await isolatedPool.query(
        `INSERT INTO clubs (id, name, city, created_by, created_at, updated_at)
         VALUES ($1, 'Owner backfill club', 'London', $2,
                 '2026-08-18T06:30:00Z', '2026-08-18T06:30:00Z')`,
        [backfilledOwnerClubId, backfilledOwnerUserId],
      );
      await isolatedPool.query(`
        ALTER TABLE club_memberships ADD COLUMN manager_player_id UUID NULL;
        ALTER TABLE club_memberships
          ADD CONSTRAINT club_memberships_manager_player_fk
          FOREIGN KEY (manager_player_id) REFERENCES players (id) ON DELETE CASCADE;
        ALTER TABLE club_memberships
          ADD CONSTRAINT club_memberships_manager_role_ck CHECK (
            manager_player_id IS NULL OR role = 'editor'
          );
        CREATE UNIQUE INDEX club_memberships_manager_player_unique_idx
          ON club_memberships (manager_player_id)
          WHERE manager_player_id IS NOT NULL;
      `);
      await isolatedPool.query(
        `INSERT INTO club_memberships (club_id, user_id, role, manager_player_id)
         VALUES ($1, $2, 'editor', $3)`,
        [backfilledOwnerClubId, legacyOwnerId, playerId],
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
           (id, club_id, game_id, sequence, idempotency_key, event_type, phase, payload)
         SELECT md5('legacy-replay-' || ordinal::text)::uuid, $1, $2, ordinal,
                'legacy-' || ordinal::text, 'legacy.replay', 'day',
                jsonb_build_object('ordinal', ordinal)
           FROM generate_series(1, 89) AS ordinal`,
        [DEFAULT_CLUB_ID, gameId],
      );

      await initializeSchema(isolatedPool);
      const backfilledOwnerCountAfterFirstRun = await isolatedPool.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM players WHERE club_id = $1",
        [backfilledOwnerClubId],
      );
      await isolatedPool.query(
        "UPDATE players SET email = 'creator-edited@example.test' WHERE id = $1",
        [playerId],
      );
      await initializeSchema(isolatedPool);

      const managerColumns = await isolatedPool.query<{
        email: string | null;
        data_processing_consent: boolean;
        consent_unchanged: boolean;
        club_access: string;
        user_id: string | null;
      }>(
        `SELECT email,
                data_processing_consent,
                consent_at = TIMESTAMPTZ '2026-08-18T07:00:00Z' AS consent_unchanged,
                club_access,
                user_id
           FROM players
          WHERE id = $1`,
        [playerId],
      );
      expect(managerColumns.rows[0]).toMatchObject({
        email: "creator-edited@example.test",
        data_processing_consent: true,
        consent_unchanged: true,
        club_access: "manager",
        user_id: legacyOwnerId,
      });
      expect(
        await isolatedPool.query("SELECT club_access, user_id FROM players WHERE id = $1", [
          laterMatchingPlayerId,
        ]),
      ).toMatchObject({ rows: [{ club_access: "none", user_id: null }] });

      const managerConstraints = await isolatedPool.query<{ indexname: string }>(
        `SELECT indexname
           FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname IN (
              'players_club_access_email_unique_idx',
              'players_club_linked_user_unique_idx'
            )
          ORDER BY indexname`,
      );
      expect(managerConstraints.rows).toEqual(
        expect.arrayContaining([
          { indexname: "players_club_access_email_unique_idx" },
          { indexname: "players_club_linked_user_unique_idx" },
        ]),
      );

      const managerConstraintNames = await isolatedPool.query<{
        conname: string;
        definition: string;
      }>(
        `SELECT conname, pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conrelid = 'players'::regclass
            AND conname IN ('players_access_requires_consent_ck', 'players_club_access_ck', 'players_user_fk')
          ORDER BY conname`,
      );
      expect(managerConstraintNames.rows.map(({ conname }) => ({ conname }))).toEqual([
        { conname: "players_access_requires_consent_ck" },
        { conname: "players_club_access_ck" },
        { conname: "players_user_fk" },
      ]);
      const managerConsentDefinition = managerConstraintNames.rows.find(
        ({ conname }) => conname === "players_access_requires_consent_ck",
      )!.definition;
      expect(managerConsentDefinition).toMatch(/club_access = 'none'/);
      expect(managerConsentDefinition).toMatch(/data_processing_consent/);
      expect(managerConsentDefinition).toMatch(/user_id IS NOT NULL/);
      expect(managerConsentDefinition).not.toMatch(/email/);

      await isolatedPool.query(
        `UPDATE players
            SET first_name = NULL,
                last_name = NULL,
                email = NULL,
                data_processing_consent = FALSE,
                consent_at = NULL
          WHERE id = $1`,
        [playerId],
      );
      await expect(
        isolatedPool.query(
          `UPDATE players
              SET first_name = NULL,
                  last_name = NULL,
                  email = NULL,
                  data_processing_consent = FALSE,
                  consent_at = NULL,
                  club_access = 'manager'
            WHERE id = $1`,
          [laterMatchingPlayerId],
        ),
      ).rejects.toMatchObject({ code: "23514", constraint: "players_access_requires_consent_ck" });

      await initializeSchema(isolatedPool);
      await expect(
        isolatedPool.query(
          `SELECT data_processing_consent, consent_at, first_name, last_name, email,
                  club_access, user_id
             FROM players
            WHERE id = $1`,
          [playerId],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            data_processing_consent: false,
            consent_at: null,
            first_name: null,
            last_name: null,
            email: null,
            club_access: "manager",
            user_id: legacyOwnerId,
          },
        ],
      });

      const membershipProvenanceColumn = await isolatedPool.query<{
        column_name: string;
        is_nullable: string;
      }>(
        `SELECT column_name, is_nullable
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'club_memberships'
            AND column_name = 'access_player_id'`,
      );
      expect(membershipProvenanceColumn.rows).toEqual([
        { column_name: "access_player_id", is_nullable: "YES" },
      ]);

      const crossClubManagerUserId = randomUUID();
      const wrongLinkedUserId = randomUUID();
      const wrongMembershipUserId = randomUUID();
      const crossClubPlayerId = randomUUID();
      const wrongUserPlayerId = randomUUID();
      await isolatedPool.query(
        `INSERT INTO users (id, email, display_name)
         VALUES ($1, $2, 'Cross-club manager'),
                ($3, $4, 'Actual linked manager'),
                ($5, $6, 'Wrong membership manager')`,
        [
          crossClubManagerUserId,
          `cross-club-${crossClubManagerUserId}@example.test`,
          wrongLinkedUserId,
          `actual-${wrongLinkedUserId}@example.test`,
          wrongMembershipUserId,
          `wrong-${wrongMembershipUserId}@example.test`,
        ],
      );
      await isolatedPool.query(
        `INSERT INTO players (id, club_id, nickname, user_id)
         VALUES ($1, $2, 'Cross-club provenance player', $3),
                ($4, $2, 'Wrong-user provenance player', $5)`,
        [
          crossClubPlayerId,
          DEFAULT_CLUB_ID,
          crossClubManagerUserId,
          wrongUserPlayerId,
          wrongLinkedUserId,
        ],
      );
      await isolatedPool.query(
        `INSERT INTO club_memberships (club_id, user_id, role)
         VALUES ($1, $2, 'manager'), ($3, $4, 'manager')`,
        [backfilledOwnerClubId, crossClubManagerUserId, DEFAULT_CLUB_ID, wrongMembershipUserId],
      );

      const provenanceUpdateErrors = await Promise.all(
        [
          [backfilledOwnerClubId, crossClubManagerUserId, crossClubPlayerId],
          [DEFAULT_CLUB_ID, wrongMembershipUserId, wrongUserPlayerId],
        ].map(async ([clubId, userId, accessPlayerId]) => {
          try {
            await isolatedPool.query(
              `UPDATE club_memberships
                  SET access_player_id = $3
                WHERE club_id = $1 AND user_id = $2`,
              [clubId, userId, accessPlayerId],
            );
            return null;
          } catch (error) {
            return error;
          }
        }),
      );
      expect(provenanceUpdateErrors).toEqual([
        expect.objectContaining({
          code: "23503",
          constraint: "club_memberships_access_player_fk",
        }),
        expect.objectContaining({
          code: "23503",
          constraint: "club_memberships_access_player_fk",
        }),
      ]);

      const membershipProvenanceConstraints = await isolatedPool.query<{
        conname: string;
        definition: string;
      }>(
        `SELECT conname, pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conrelid = 'club_memberships'::regclass
            AND conname = 'club_memberships_access_player_fk'
          ORDER BY conname`,
      );
      expect(membershipProvenanceConstraints.rows).toHaveLength(1);
      expect(membershipProvenanceConstraints.rows).toEqual(
        expect.arrayContaining([
          {
            conname: "club_memberships_access_player_fk",
            definition:
              "FOREIGN KEY (access_player_id, club_id, user_id) REFERENCES players(id, club_id, user_id) ON DELETE CASCADE",
          },
        ]),
      );
      await expect(
        isolatedPool.query(
          `SELECT pg_get_constraintdef(oid) AS definition
             FROM pg_constraint
            WHERE conrelid = 'players'::regclass
              AND conname = 'players_access_provenance_unique'`,
        ),
      ).resolves.toMatchObject({
        rows: [{ definition: "UNIQUE (id, club_id, user_id)" }],
      });

      const membershipProvenanceIndex = await isolatedPool.query<{ indexdef: string }>(
        `SELECT indexdef
           FROM pg_indexes
           WHERE schemaname = current_schema()
             AND indexname = 'club_memberships_access_player_unique_idx'`,
      );
      expect(membershipProvenanceIndex.rows).toEqual([
        {
          indexdef: expect.stringMatching(
            /CREATE UNIQUE INDEX .* \(access_player_id\) WHERE \(access_player_id IS NOT NULL\)$/,
          ),
        },
      ]);

      await expect(
        isolatedPool.query(
          `SELECT role, access_player_id
             FROM club_memberships
            WHERE club_id = $1 AND user_id = $2`,
          [backfilledOwnerClubId, legacyOwnerId],
        ),
      ).resolves.toMatchObject({ rows: [{ role: "manager", access_player_id: null }] });

      expect(
        await isolatedPool.query(
          `SELECT role, access_player_id
             FROM club_memberships
            WHERE club_id = $1 AND user_id = $2`,
          [DEFAULT_CLUB_ID, legacyOwnerId],
        ),
      ).toMatchObject({ rows: [{ role: "manager", access_player_id: null }] });

      const backfilledOwners = await isolatedPool.query<{
        id: string;
        nickname: string;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
        data_processing_consent: boolean;
        consent_at: Date | null;
        club_access: string;
        user_id: string | null;
      }>(
        `SELECT player.id,
                player.nickname,
                player.first_name,
                player.last_name,
                player.email,
                player.data_processing_consent,
                player.consent_at,
                player.club_access,
                player.user_id
           FROM players AS player
          WHERE player.club_id = $1`,
        [backfilledOwnerClubId],
      );
      expect(backfilledOwnerCountAfterFirstRun.rows).toEqual([{ count: 1 }]);
      expect(backfilledOwners.rows).toEqual([
        {
          id: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          ),
          nickname: "Owner",
          first_name: null,
          last_name: null,
          email: null,
          data_processing_consent: false,
          consent_at: null,
          club_access: "manager",
          user_id: backfilledOwnerUserId,
        },
      ]);

      expect(
        await isolatedPool.query(
          `SELECT role, access_player_id
             FROM club_memberships
            WHERE club_id = $1 AND user_id = $2`,
          [backfilledOwnerClubId, backfilledOwnerUserId],
        ),
      ).toMatchObject({ rows: [{ role: "manager", access_player_id: null }] });

      expect(
        await isolatedPool.query(
          `SELECT
             (SELECT COUNT(*)::int FROM game_sessions WHERE club_id = $1 AND id = $2) AS sessions,
             (SELECT COUNT(*)::int FROM game_session_mutations WHERE club_id = $1 AND game_id = $2) AS mutations,
             (SELECT COUNT(*)::int FROM game_session_players WHERE club_id = $1 AND game_id = $2) AS players,
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
            players: 1,
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
             (SELECT COUNT(*)::int FROM game_session_players WHERE game_id = $1) AS players,
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
            players: 2,
            results: 2,
            player_results: 2,
            tombstones: 2,
          },
        ],
      });
    } finally {
      await dropIsolatedPool(schemaName, isolatedPool);
    }
  });
});

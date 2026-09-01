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

interface IsolatedSchema {
  readonly name: string;
  readonly pool: Pool;
}

const withIsolatedSchema = async <T>(
  prefix: string,
  run: (schema: IsolatedSchema) => Promise<T>,
): Promise<T> => {
  const name = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  const isolatedPool = await createIsolatedPool(name);
  let result: { readonly value: T } | undefined;
  let runError: unknown;
  try {
    result = { value: await run({ name, pool: isolatedPool }) };
  } catch (error) {
    runError = error;
  }

  let cleanupError: unknown;
  try {
    await dropIsolatedPool(name, isolatedPool);
  } catch (error) {
    cleanupError = error;
  }
  const errors = [runError, cleanupError].filter((error) => error !== undefined);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, `Failed ${prefix} fixture and cleanup`);
  return result!.value;
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

describe("isolated schema lifecycle", () => {
  it("cleans the pool and schema when a fixture callback fails", async () => {
    let fixture: IsolatedSchema | undefined;
    try {
      await expect(
        withIsolatedSchema("cleanup_failure", async (schema) => {
          fixture = schema;
          await initializeSchema(schema.pool);
          throw new Error("fixture callback failed");
        }),
      ).rejects.toThrow("fixture callback failed");
      await expect(
        adminPool.query<{ schema_name: string | null }>(
          "SELECT to_regnamespace($1)::text AS schema_name",
          [fixture!.name],
        ),
      ).resolves.toMatchObject({ rows: [{ schema_name: null }] });
    } finally {
      if (fixture !== undefined) {
        await fixture.pool.end().catch(() => undefined);
        await adminPool.query(`DROP SCHEMA IF EXISTS "${fixture.name}" CASCADE`);
      }
    }
  });
});

describe("normalized game schema migration", () => {
  it("installs the fixed ruleset and database-enforced session assignment constraints", async () => {
    await withIsolatedSchema("normalized_game_fresh", async ({ pool }) => {
      await initializeSchema(pool);

      await expect(
        pool.query(
          `SELECT id, version, player_count, sheriff_count, citizen_count, mafia_count, don_count
             FROM game_rulesets`,
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

      const gameId = randomUUID();
      const playerId = randomUUID();
      await pool.query("INSERT INTO players (id, nickname) VALUES ($1, 'Constraint player')", [
        playerId,
      ]);
      await pool.query(
        `INSERT INTO game_sessions
           (id, name, revision, last_mutation_id, state, status)
         VALUES ($1, 'Ruleset session', 1, $2, '{}'::jsonb, 'active')`,
        [gameId, randomUUID()],
      );
      await expect(
        pool.query(
          `INSERT INTO game_sessions
             (id, name, revision, last_mutation_id, state, status, ruleset_id, ruleset_version)
           VALUES ($1, 'Unknown ruleset', 1, $2, '{}'::jsonb, 'active', 'unknown', 1)`,
          [randomUUID(), randomUUID()],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        pool.query(
          `INSERT INTO game_session_players (game_id, player_id, seat, is_host, role)
           VALUES ($1, $2, 1, FALSE, 'doctor')`,
          [gameId, playerId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          `INSERT INTO game_session_players (game_id, player_id, seat, is_host, role)
           VALUES ($1, $2, 1, TRUE, 'sheriff')`,
          [gameId, playerId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          `INSERT INTO game_session_players (game_id, player_id, seat, is_host, role)
           VALUES ($1, $2, NULL, FALSE, NULL)`,
          [gameId, playerId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("backfills representative populated sessions and converges idempotently", async () => {
    await withIsolatedSchema("normalized_game_populated", async ({ pool }) => {
      await initializeSchema(pool);
      await pool.query(`
        ALTER TABLE game_sessions DROP COLUMN IF EXISTS ruleset_id;
        ALTER TABLE game_sessions DROP COLUMN IF EXISTS ruleset_version;
        ALTER TABLE game_session_players DROP COLUMN IF EXISTS role;
        DROP TABLE IF EXISTS game_rulesets CASCADE;
      `);

      const canonicalGameId = randomUUID();
      const partialSetupId = randomUUID();
      const canonicalPlayerId = randomUUID();
      const partialPlayerId = randomUUID();
      const hostPlayerId = randomUUID();
      await pool.query(
        `INSERT INTO players (id, nickname)
         VALUES ($1, 'Canonical player'), ($2, 'Partial player'), ($3, 'Session host')`,
        [canonicalPlayerId, partialPlayerId, hostPlayerId],
      );
      const canonicalState = {
        game: { players: [{ id: canonicalPlayerId, seat: 1, role: "sheriff" }] },
        setup: {
          setup: {
            players: [{ id: canonicalPlayerId, seat: 1 }],
            assignments: { 1: "citizen" },
          },
        },
      };
      const partialState = {
        game: null,
        hostPlayerId,
        setup: {
          setup: {
            players: [{ id: partialPlayerId, seat: 2 }],
            assignments: { 2: "mafia" },
          },
        },
      };
      await pool.query(
        `INSERT INTO game_sessions
           (id, name, revision, last_mutation_id, state, status)
         VALUES ($1, 'Canonical migration', 1, $2, $3::jsonb, 'active'),
                ($4, 'Partial migration', 1, $5, $6::jsonb, 'active')`,
        [
          canonicalGameId,
          randomUUID(),
          JSON.stringify(canonicalState),
          partialSetupId,
          randomUUID(),
          JSON.stringify(partialState),
        ],
      );
      await pool.query(
        `INSERT INTO game_session_players (game_id, player_id, seat, is_host)
         VALUES ($1, $2, 1, FALSE), ($3, $4, 2, FALSE), ($3, $5, NULL, TRUE)`,
        [canonicalGameId, canonicalPlayerId, partialSetupId, partialPlayerId, hostPlayerId],
      );

      await initializeSchema(pool);
      const normalized = async () =>
        (
          await pool.query(
            `SELECT session.id, session.ruleset_id, session.ruleset_version, session.state,
                    player.player_id, player.seat, player.is_host, player.role
               FROM game_sessions AS session
               JOIN game_session_players AS player
                 ON player.club_id = session.club_id AND player.game_id = session.id
              WHERE session.id = ANY($1::uuid[])
              ORDER BY session.id, player.is_host, player.seat`,
            [[canonicalGameId, partialSetupId]],
          )
        ).rows;
      const afterFirstRun = await normalized();
      expect(afterFirstRun).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: canonicalGameId,
            player_id: canonicalPlayerId,
            ruleset_id: "club-mafia",
            ruleset_version: 1,
            state: canonicalState,
            role: "sheriff",
          }),
          expect.objectContaining({
            id: partialSetupId,
            player_id: partialPlayerId,
            state: partialState,
            role: "mafia",
          }),
          expect.objectContaining({
            id: partialSetupId,
            player_id: hostPlayerId,
            is_host: true,
            seat: null,
            role: null,
          }),
        ]),
      );

      await initializeSchema(pool);
      expect(await normalized()).toEqual(afterFirstRun);
    });
  });
});

describe("club authorization role migration", () => {
  it("reconciles fresh and populated schemas to manager/user access idempotently", async () => {
    await withIsolatedSchema("club_roles_fresh", async ({ pool: freshPool }) =>
      withIsolatedSchema("club_roles_populated", async ({ pool: populatedPool }) => {
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
      }),
    );
  });

  it("preserves canonical access constraint identities across repeated initialization", async () => {
    const schemaName = `access_constraint_identity_${randomUUID().replaceAll("-", "")}`;
    const isolatedPool = await createIsolatedPool(schemaName);
    const expectedDefinitions = [
      {
        conname: "club_memberships_access_player_fk",
        definition:
          "FOREIGN KEY (access_player_id, club_id, user_id) REFERENCES players(id, club_id, user_id) ON DELETE CASCADE",
      },
      {
        conname: "players_access_provenance_unique",
        definition: "UNIQUE (id, club_id, user_id)",
      },
      {
        conname: "players_access_requires_consent_ck",
        definition:
          "CHECK (((club_access = 'none'::text) OR data_processing_consent OR (user_id IS NOT NULL)))",
      },
      {
        conname: "players_club_access_ck",
        definition:
          "CHECK ((club_access = ANY (ARRAY['none'::text, 'user'::text, 'manager'::text])))",
      },
      {
        conname: "players_user_fk",
        definition: "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL",
      },
    ];
    const constraintRows = async () =>
      (
        await isolatedPool.query<{ conname: string; definition: string; oid: string }>(
          `SELECT conname, pg_get_constraintdef(oid) AS definition, oid::text
             FROM pg_constraint
            WHERE conname = ANY($1::text[])
              AND conrelid IN ('players'::regclass, 'club_memberships'::regclass)
            ORDER BY conname`,
          [expectedDefinitions.map(({ conname }) => conname)],
        )
      ).rows;

    try {
      await initializeSchema(isolatedPool);
      const canonicalConstraints = await constraintRows();
      expect(
        canonicalConstraints.map(({ conname, definition }) => ({ conname, definition })),
      ).toEqual(expectedDefinitions);

      await initializeSchema(isolatedPool);
      expect(await constraintRows()).toEqual(canonicalConstraints);

      await isolatedPool.query(`
        ALTER TABLE club_memberships DROP CONSTRAINT club_memberships_access_player_fk;
        ALTER TABLE players
          DROP CONSTRAINT players_access_provenance_unique,
          DROP CONSTRAINT players_access_requires_consent_ck,
          DROP CONSTRAINT players_club_access_ck,
          DROP CONSTRAINT players_user_fk,
          ADD CONSTRAINT players_access_provenance_unique UNIQUE (id, club_id),
          ADD CONSTRAINT players_access_requires_consent_ck CHECK (club_access <> ''),
          ADD CONSTRAINT players_club_access_ck CHECK (club_access <> ''),
          ADD CONSTRAINT players_user_fk FOREIGN KEY (user_id) REFERENCES users (id);
        ALTER TABLE club_memberships
          ADD CONSTRAINT club_memberships_access_player_fk
          FOREIGN KEY (club_id, user_id) REFERENCES club_memberships (club_id, user_id);
      `);
      const weakConstraintOids = (await constraintRows()).map(({ oid }) => oid);

      await initializeSchema(isolatedPool);
      const reconciledConstraints = await constraintRows();
      expect(
        reconciledConstraints.map(({ conname, definition }) => ({ conname, definition })),
      ).toEqual(expectedDefinitions);
      expect(reconciledConstraints.map(({ oid }) => oid)).not.toEqual(weakConstraintOids);

      await initializeSchema(isolatedPool);
      expect(await constraintRows()).toEqual(reconciledConstraints);
    } finally {
      await dropIsolatedPool(schemaName, isolatedPool);
    }
  });
});

describe("club settings schema migration", () => {
  it("adds constrained language and Best move defaults idempotently", async () => {
    await withIsolatedSchema("club_language_fresh", async ({ pool: freshPool }) =>
      withIsolatedSchema("club_language_legacy", async ({ pool: legacyPool }) => {
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
        ALTER TABLE clubs ALTER COLUMN best_move_enabled DROP NOT NULL;
        ALTER TABLE clubs ALTER COLUMN best_move_enabled DROP DEFAULT;
      `);
        await legacyPool.query(
          `INSERT INTO clubs (id, name, city, created_by, language_code, best_move_enabled)
         VALUES ($1, 'Partial migration club', 'Granada', $2, NULL, NULL)`,
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
              `SELECT data_type, is_nullable, column_default
               FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'clubs'
                AND column_name = 'best_move_enabled'`,
            ),
          ).resolves.toMatchObject({
            rows: [{ data_type: "boolean", is_nullable: "NO", column_default: "true" }],
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
          legacyPool.query(
            `SELECT id, language_code, best_move_enabled
               FROM clubs
              WHERE id IN ($1, $2)
              ORDER BY id`,
            [legacyClubId, partialClubId],
          ),
        ).resolves.toMatchObject({
          rows: expect.arrayContaining([
            { id: legacyClubId, language_code: "en", best_move_enabled: true },
            { id: partialClubId, language_code: "en", best_move_enabled: true },
          ]),
        });
        await expect(
          legacyPool.query("UPDATE clubs SET language_code = 'es' WHERE id = $1", [legacyClubId]),
        ).rejects.toMatchObject({ constraint: "clubs_language_code_ck" });
      }),
    );
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

  it("ignores oversized legacy replay numerics without aborting initialization", async () => {
    const schemaName = `replay_numeric_overflow_${randomUUID().replaceAll("-", "")}`;
    const isolatedPool = await createIsolatedPool(schemaName);
    const gameId = randomUUID();
    const eventId = randomUUID();
    const oversizedInteger = "99999999999999999999999999999999999999999999999999";
    try {
      await initializeSchema(isolatedPool);
      await isolatedPool.query(
        `INSERT INTO game_sessions
           (id, name, revision, last_mutation_id, state, status)
         VALUES ($1, 'Oversized legacy replay metadata', 1, $2, $3, 'active')`,
        [
          gameId,
          randomUUID(),
          {
            events: [
              {
                id: eventId,
                gameId,
                sequence: oversizedInteger,
                replayVersion: 1,
                phaseBefore: "day",
                phaseAfter: "day",
                dayBefore: oversizedInteger,
                dayAfter: oversizedInteger,
                stateHashAfter: "deadbeef",
              },
            ],
          },
        ],
      );
      await isolatedPool.query(
        `INSERT INTO game_events
           (id, game_id, sequence, idempotency_key, event_type, phase, payload)
         VALUES ($1::uuid, $2, 1, $1::text, 'legacy.replay', 'day', '{}'::jsonb)`,
        [eventId, gameId],
      );

      await initializeSchema(isolatedPool);
      await initializeSchema(isolatedPool);

      await expect(
        isolatedPool.query(
          `SELECT replay_sequence, day_before, day_after
             FROM game_events
            WHERE game_id = $1 AND id = $2`,
          [gameId, eventId],
        ),
      ).resolves.toMatchObject({
        rows: [{ replay_sequence: null, day_before: null, day_after: null }],
      });
    } finally {
      await dropIsolatedPool(schemaName, isolatedPool);
    }
  });

  it("replaces weak replay bounds once and preserves canonical constraint identities", async () => {
    const schemaName = `replay_constraint_reconciliation_${randomUUID().replaceAll("-", "")}`;
    const isolatedPool = await createIsolatedPool(schemaName);
    const expectedDefinitions = [
      {
        conname: "game_events_day_after_nonnegative_ck",
        definition: "CHECK ((day_after >= 0))",
      },
      {
        conname: "game_events_day_before_nonnegative_ck",
        definition: "CHECK ((day_before >= 0))",
      },
      {
        conname: "game_events_replay_metadata_ck",
        definition:
          "CHECK (((replay_sequence IS NULL) OR ((replay_version = 1) AND (phase_after IS NOT NULL) AND (day_before IS NOT NULL) AND (day_after IS NOT NULL) AND (state_hash_after ~ '^([0-9a-f]{8}|sha256:[0-9a-f]{64})$'::text))))",
      },
      {
        conname: "game_events_replay_sequence_positive_ck",
        definition: "CHECK ((replay_sequence > 0))",
      },
    ];
    const constraintRows = async () =>
      (
        await isolatedPool.query<{ conname: string; definition: string; oid: string }>(
          `SELECT conname, pg_get_constraintdef(oid) AS definition, oid::text
             FROM pg_constraint
            WHERE conrelid = 'game_events'::regclass
              AND conname = ANY($1::text[])
            ORDER BY conname`,
          [expectedDefinitions.map(({ conname }) => conname)],
        )
      ).rows;

    try {
      await initializeSchema(isolatedPool);
      await isolatedPool.query(`
        ALTER TABLE game_events
          DROP CONSTRAINT game_events_replay_sequence_positive_ck,
          DROP CONSTRAINT game_events_day_before_nonnegative_ck,
          DROP CONSTRAINT game_events_day_after_nonnegative_ck,
          DROP CONSTRAINT game_events_replay_metadata_ck,
          ADD CONSTRAINT game_events_replay_sequence_positive_ck CHECK (replay_sequence >= -1),
          ADD CONSTRAINT game_events_day_before_nonnegative_ck CHECK (day_before >= -1),
          ADD CONSTRAINT game_events_day_after_nonnegative_ck CHECK (day_after >= -1),
          ADD CONSTRAINT game_events_replay_metadata_ck CHECK (
            replay_sequence IS NULL
            OR state_hash_after ~ '^([0-9a-f]{8}|sha256:[0-9a-f]{64})$'
          );
      `);
      const weakConstraintOids = (await constraintRows()).map(({ oid }) => oid);

      await initializeSchema(isolatedPool);
      const canonicalConstraints = await constraintRows();
      expect(
        canonicalConstraints.map(({ conname, definition }) => ({ conname, definition })),
      ).toEqual(expectedDefinitions);
      expect(canonicalConstraints.map(({ oid }) => oid)).not.toEqual(weakConstraintOids);

      await initializeSchema(isolatedPool);
      expect(await constraintRows()).toEqual(canonicalConstraints);
    } finally {
      await dropIsolatedPool(schemaName, isolatedPool);
    }
  });

  it("does not rewrite canonical replay rows that already match legacy JSON", async () => {
    const schemaName = `canonical_replay_updates_${randomUUID().replaceAll("-", "")}`;
    const isolatedPool = await createIsolatedPool(schemaName);
    const gameId = randomUUID();
    const eventId = randomUUID();
    try {
      await initializeSchema(isolatedPool);
      await isolatedPool.query(
        `INSERT INTO game_sessions
           (id, name, revision, last_mutation_id, state, status)
         VALUES ($1, 'Canonical replay update probe', 1, $2, $3, 'active')`,
        [
          gameId,
          randomUUID(),
          {
            events: [
              {
                id: eventId,
                gameId,
                sequence: 1,
                replayVersion: 1,
                phaseBefore: "day",
                phaseAfter: "day",
                dayBefore: 0,
                dayAfter: 0,
                stateHashAfter: "deadbeef",
              },
            ],
          },
        ],
      );
      await isolatedPool.query(
        `INSERT INTO game_events
           (id, game_id, sequence, idempotency_key, event_type, phase, payload,
            replay_sequence, phase_after, day_before, day_after, state_hash_after)
         VALUES ($1::uuid, $2, 1, $1::text, 'game.started', 'day', '{}'::jsonb,
                 1, 'day', 0, 0, 'deadbeef')`,
        [eventId, gameId],
      );
      await isolatedPool.query(`
        CREATE TABLE game_event_update_audit (event_id UUID NOT NULL);
        CREATE FUNCTION record_game_event_update() RETURNS TRIGGER
          LANGUAGE plpgsql
          AS $trigger$
        BEGIN
          INSERT INTO game_event_update_audit (event_id) VALUES (NEW.id);
          RETURN NEW;
        END
        $trigger$;
        CREATE TRIGGER game_event_update_probe
          AFTER UPDATE ON game_events
          FOR EACH ROW EXECUTE FUNCTION record_game_event_update();
      `);

      await initializeSchema(isolatedPool);
      await initializeSchema(isolatedPool);

      await expect(
        isolatedPool.query(
          "SELECT COUNT(*)::int AS updates FROM game_event_update_audit WHERE event_id = $1",
          [eventId],
        ),
      ).resolves.toMatchObject({ rows: [{ updates: 0 }] });
    } finally {
      await dropIsolatedPool(schemaName, isolatedPool);
    }
  });

  it("removes the redundant event sequence index while retaining the unique constraint", async () => {
    const schemaName = `event_sequence_index_${randomUUID().replaceAll("-", "")}`;
    const isolatedPool = await createIsolatedPool(schemaName);
    try {
      await initializeSchema(isolatedPool);
      await isolatedPool.query(
        `CREATE INDEX IF NOT EXISTS game_events_club_game_sequence_idx
           ON game_events (club_id, game_id, sequence)`,
      );

      await initializeSchema(isolatedPool);

      await expect(
        isolatedPool.query(
          `SELECT index_relation.relname AS index_name,
                  index_row.indisunique AS is_unique,
                  constraint_row.conname AS constraint_name
             FROM pg_index AS index_row
             JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
             LEFT JOIN pg_constraint AS constraint_row ON constraint_row.conindid = index_row.indexrelid
            WHERE index_row.indrelid = 'game_events'::regclass
              AND index_relation.relname IN (
                'game_events_club_game_sequence_idx',
                'game_events_club_game_sequence_unique'
              )
            ORDER BY index_relation.relname`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            index_name: "game_events_club_game_sequence_unique",
            is_unique: true,
            constraint_name: "game_events_club_game_sequence_unique",
          },
        ],
      });

      await isolatedPool.query(
        `CREATE UNIQUE INDEX game_events_club_game_sequence_idx
           ON game_events (club_id, game_id, sequence)`,
      );
      await initializeSchema(isolatedPool);
      await expect(
        isolatedPool.query(
          `SELECT index_row.indisunique AS is_unique
             FROM pg_index AS index_row
            WHERE index_row.indexrelid = TO_REGCLASS('game_events_club_game_sequence_idx')`,
        ),
      ).resolves.toMatchObject({ rows: [{ is_unique: true }] });

      await isolatedPool.query("DROP INDEX game_events_club_game_sequence_idx");
      await isolatedPool.query(
        `CREATE INDEX game_events_club_game_sequence_idx
           ON game_events (club_id, game_id, id)`,
      );
      await initializeSchema(isolatedPool);
      await expect(
        isolatedPool.query(
          `SELECT PG_GET_INDEXDEF(index_row.indexrelid) AS definition
             FROM pg_index AS index_row
            WHERE index_row.indexrelid = TO_REGCLASS('game_events_club_game_sequence_idx')`,
        ),
      ).resolves.toMatchObject({
        rows: [{ definition: expect.stringMatching(/\(club_id, game_id, id\)$/) }],
      });
    } finally {
      await dropIsolatedPool(schemaName, isolatedPool);
    }
  });
});

type TenantMigrationConcern =
  | "composite-keys"
  | "consent-provenance"
  | "owner-backfill"
  | "replay-retention"
  | "cross-club-collisions";

const verifyTenantMigrationConcern = async (concern: TenantMigrationConcern): Promise<void> => {
  const schemaName = `tenant_game_keys_${randomUUID().replaceAll("-", "")}`;
  const isolatedPool = await createIsolatedPool(schemaName);
  try {
    await initializeSchema(isolatedPool);
    if (concern === "composite-keys") {
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
    }

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

    if (concern === "consent-provenance") {
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
    }

    if (concern === "owner-backfill") {
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
    }

    if (concern === "replay-retention") {
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
    }

    if (concern === "cross-club-collisions") {
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
    }
  } finally {
    await dropIsolatedPool(schemaName, isolatedPool);
  }
};

describe("tenant-composite game schema migration", () => {
  it.each<{ readonly name: string; readonly concern: TenantMigrationConcern }>([
    { name: "installs composite tenant keys", concern: "composite-keys" },
    { name: "preserves manager consent and provenance", concern: "consent-provenance" },
    { name: "backfills owner profiles idempotently", concern: "owner-backfill" },
    { name: "retains legacy replay rows", concern: "replay-retention" },
    { name: "allows cross-club identifier collisions", concern: "cross-club-collisions" },
  ])("$name", async ({ concern }) => verifyTenantMigrationConcern(concern));
});

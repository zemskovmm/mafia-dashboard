import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { initializeSchema } from "./initialize-schema.js";
import { createPostgresStores } from "./storage-contracts.js";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import { createStorageFixture } from "./test-helpers/storage-fixture.js";
import { AzureGameSessionStore } from "./azure-game-session-store.js";
import { AzureTournamentStore } from "./azure-tournament-store.js";
import {
  preparePostgresMigration,
  applyPostgresMigration,
  validatePostgresMigration,
  migrationTarget,
} from "./postgres-storage-migration.js";

const root = resolve(process.cwd(), "../..");
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Use npm run test:local with the owned PostgreSQL fixture");
const url = new URL(databaseUrl);
if (url.hostname !== "127.0.0.1" || url.pathname !== "/mafia_test")
  throw new Error("Only owned local PostgreSQL fixture permitted");
const withSchema = async (work: (pool: Pool, schema: string) => Promise<void>) => {
  const admin = new Pool({ connectionString: databaseUrl });
  const schema = `tournament_preservation_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await initializeSchema(pool);
    await work(pool, schema);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
};

it("preserves the exact preceding source catalog and its existing package format without initializing it", async () => {
  await withSchema(async (pool, schema) => {
    const stores = createPostgresStores(pool);
    const creationId = randomUUID();
    const input = {
      creationId,
      name: "Old source",
      state: { raw: { unchanged: "CASE-sensitive opaque hash" } },
      results: null,
    };
    const old = await stores.games.create(input);
    await pool.query("DROP TABLE game_tournaments; DROP TABLE tournaments");
    const before = (await pool.query("SELECT row_to_json(g)::text AS raw FROM game_sessions g"))
      .rows;
    const fixture = await createStorageFixture();
    try {
      const directory = join(root, ".AI", `tournament-preceding-import-${randomUUID()}`);
      const pkg = await preparePostgresMigration(pool, directory, {
        projectRoot: root,
        source: {
          database: "mafia_test",
          schema,
          serverAddress: "127.0.0.1",
          serverPort: Number(url.port),
        },
        target: migrationTarget(fixture.storage),
      });
      const raw = JSON.parse(await readFile(join(directory, "source.json"), "utf8")) as {
        relations: Record<string, unknown>;
      };
      expect(raw.relations).not.toHaveProperty("tournaments");
      expect(raw.relations).not.toHaveProperty("game_tournaments");
      expect(
        (await pool.query("SELECT row_to_json(g)::text AS raw FROM game_sessions g")).rows,
      ).toEqual(before);
      expect(
        (
          await pool.query(
            "SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename IN ('tournaments','game_tournaments')",
          )
        ).rows,
      ).toEqual([]);
      expect(await validatePostgresMigration(directory, { projectRoot: root })).toMatchObject({
        sha256: pkg.sha256,
      });
      await applyPostgresMigration(fixture.storage, directory, {
        projectRoot: root,
        sha256: pkg.sha256,
      });
      const games = new AzureGameSessionStore(fixture.storage);
      expect(await games.get(old.gameId)).toEqual(old);
      expect(await new AzureTournamentStore(fixture.storage).list(DEFAULT_CLUB_ID)).toEqual([]);
      expect((await games.create(input)).gameId).toBe(old.gameId);
      expect((await games.readStatisticsInputs()).games).toEqual([
        expect.objectContaining({ gameId: old.gameId, tournamentId: null, participants: null }),
      ]);
    } finally {
      await fixture.close();
    }
  });
}, 30000);

it("restores a native PostgreSQL archive and proves tournament rows through application readers", async () => {
  await withSchema(async (pool, schema) => {
    const stores = createPostgresStores(pool);
    const tournament = await stores.tournaments.create("Archive event", DEFAULT_CLUB_ID);
    const input = {
      creationId: randomUUID(),
      name: "Archive game",
      state: { raw: "not rewritten" },
      results: null,
      tournamentId: tournament.id,
    };
    const created = await stores.games.create(input);
    const source = await stores.games.readStatisticsInputs();
    const destination = `tournament_restore_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: databaseUrl });
    const targetUrl = new URL(url);
    targetUrl.pathname = `/${destination}`;
    const run = promisify(execFile);
    const { stdout: bin } = await run("pg_config", ["--bindir"]);
    const directoryRoot = join(root, ".AI/reports/club-statistics-20261015");
    await mkdir(directoryRoot, { recursive: true });
    const directory = await mkdtemp(join(directoryRoot, "postgres-backup-"));
    const archive = join(directory, "backup.dump");
    await run(join(bin.trim(), "pg_dump"), [
      "--dbname",
      databaseUrl!,
      "--schema",
      schema,
      "--format=custom",
      "--no-owner",
      "--no-acl",
      "--file",
      archive,
    ]);
    await admin.query(`CREATE DATABASE ${destination}`);
    const targetPool = new Pool({
      connectionString: targetUrl.href,
      options: `-c search_path=${schema}`,
    });
    try {
      await run(join(bin.trim(), "pg_restore"), [
        "--dbname",
        targetUrl.href,
        "--no-owner",
        "--no-acl",
        archive,
      ]);
      await initializeSchema(targetPool);
      const target = createPostgresStores(targetPool);
      expect(await target.tournaments.list(DEFAULT_CLUB_ID)).toEqual([tournament]);
      expect(await target.games.get(created.gameId)).toEqual(created);
      expect(await target.games.readStatisticsInputs()).toEqual(source);
      expect((await target.games.create(input)).tournamentId).toBe(tournament.id);
      await target.games.save({
        gameId: created.gameId,
        name: created.name,
        mutationId: randomUUID(),
        state: { later: true },
        results: null,
      });
      expect((await target.games.get(created.gameId))?.tournamentId).toBe(tournament.id);
      expect(await stores.games.get(created.gameId)).toEqual(created);
    } finally {
      await targetPool.end();
      await admin.query(`DROP DATABASE ${destination}`);
      await admin.end();
    }
  });
}, 30000);

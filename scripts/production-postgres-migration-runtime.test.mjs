import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { Pool } from "pg";
import { BlobServiceClient } from "@azure/storage-blob";
import { TableClient } from "@azure/data-tables";
import { startPostgres } from "./local-postgres.mjs";
import { startAzurite } from "./local-azurite.mjs";
import { initializeSchema } from "../apps/server/src/initialize-schema.ts";
import { DEFAULT_CLUB_ID } from "../apps/server/src/club-store.ts";
import { PlayerStore } from "../apps/server/src/player-store.ts";
import { GameSessionStore } from "../apps/server/src/game-session-store.ts";
import { TournamentStore } from "../apps/server/src/tournament-store.ts";
import { AzureStorage } from "../apps/server/src/azure-storage.ts";
import { AzurePlayerStore } from "../apps/server/src/azure-club-player-store.ts";
import { AzureGameSessionStore } from "../apps/server/src/azure-game-session-store.ts";
import { AzureTournamentStore } from "../apps/server/src/azure-tournament-store.ts";
import { runMigrationRuntime } from "./production-postgres-migration-runtime.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const sentinel = "PRIVATE-RUNTIME-SENTINEL-MUST-NOT-LEAK";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const freshArchive = () => `migration-${randomUUID().replaceAll("-", "")}`;
const names = async (container) => {
  const result = [];
  for await (const blob of container.listBlobsFlat()) result.push(blob.name);
  return result.sort();
};

test("standalone production main refuses invalid approval/args before I/O and emits only fixed failure fields", async () => {
  const path = join(root, "scripts/production-postgres-migration-runtime.mjs");
  for (const { args, approval, exportSecret } of [
    { args: [], approval: "F".repeat(64) },
    { args: [], approval: "f".repeat(64), exportSecret: sentinel },
    { args: ["--target-file", sentinel], approval: "f".repeat(64) },
  ]) {
    await assert.rejects(
      promisify(execFile)(process.execPath, [path, ...args], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          MIGRATION_MODE: "apply",
          MIGRATION_ARCHIVE: freshArchive(),
          MIGRATION_SHA256: approval,
          ...(exportSecret === undefined ? {} : { POSTGRES_PASSWORD: exportSecret }),
          PGHOST: sentinel,
          AZURE_STORAGE_CONNECTION_STRING: sentinel,
          AZURE_LOG_LEVEL: "verbose",
        },
        timeout: 10000,
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, 'MIGRATION_FAILURE {"stage":"input","code":"INVALID_INPUT"}\n');
        assert.equal(error.stderr, "");
        return true;
      },
    );
  }
});

// Self-owned fixtures only; inherited TEST_/Azure/PG credentials are not adopted.
test(
  "production runtime: real PostgreSQL/compiled CLI/Azurite archive roundtrip and refusal boundaries",
  { timeout: 180000 },
  async (t) => {
    await mkdir(join(root, ".AI"), { recursive: true, mode: 0o700 });
    const directory = join(root, ".AI", `migration-runtime-test-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    const pg = await startPostgres({ disposable: true });
    let emulator;
    let pool;
    const previous = {};
    try {
      emulator = await startAzurite({ mode: "test" });
      const url = new URL(pg.url);
      // Compare raw source rows using the same timestamp rendering as the exporter.
      pool = new Pool({ connectionString: pg.url, options: "-c timezone=UTC" });
      await initializeSchema(pool);
      const players = new PlayerStore(pool);
      const player = await players.create({
        nickname: sentinel,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
      });
      const games = new GameSessionStore(pool);
      const tournament = await new TournamentStore(pool).create("Runtime event", DEFAULT_CLUB_ID);
      const game = await games.create({
        creationId: randomUUID(),
        tournamentId: tournament.id,
        name: "Runtime fixture",
        state: {
          setup: { hostPlayerId: player.id, selectedPlayerIds: [], step: "players" },
          events: [],
        },
        results: null,
      });
      await pool.query("UPDATE clubs SET header_logo=$1 WHERE id=$2", [
        "data:image/png;base64,c3ludGhldGlj",
        DEFAULT_CLUB_ID,
      ]);
      const user = (await pool.query("SELECT id FROM users ORDER BY id LIMIT 1")).rows[0].id;
      await pool.query(
        "INSERT INTO user_sessions (id,token_hash,user_id,expires_at) VALUES ($1,$2,$3,NOW()+INTERVAL '1 day')",
        [randomUUID(), Buffer.from(sentinel), user],
      );
      await pool.query(
        "INSERT INTO youtube_oauth_credentials (user_id,access_token_encrypted,refresh_token_encrypted,expires_at,account_label,scope) VALUES ($1,$2,$2,NOW(),$3,$3)",
        [user, Buffer.from(sentinel), sentinel],
      );
      const role = `runtime_reader_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      await pool.query(`CREATE ROLE ${role} LOGIN`);
      await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      const relations = (
        await pool.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('user_sessions','youtube_oauth_credentials') ORDER BY tablename",
        )
      ).rows.map((row) => row.tablename);
      for (const relation of relations)
        await pool.query(`GRANT SELECT ON public.${relation} TO ${role}`);
      const compiled = join(directory, "compiled");
      await promisify(execFile)(
        process.execPath,
        [
          join(root, "node_modules/tsup/dist/cli-default.js"),
          "src/migrate-postgres-to-storage.ts",
          "--format",
          "esm",
          "--out-dir",
          compiled,
          "--no-splitting",
        ],
        {
          cwd: join(root, "apps/server"),
          env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
        },
      );
      const suffix = randomUUID().replaceAll("-", "");
      const target = {
        mode: "local",
        connectionString: emulator.environment.AZURE_STORAGE_CONNECTION_STRING,
        tableName: `Runtime${suffix}`,
        containerName: `runtime-${suffix}`,
        partitionKey: `runtime-${suffix}`,
      };
      const service = BlobServiceClient.fromConnectionString(target.connectionString, {
        retryOptions: { maxTries: 1 },
      });
      const table = TableClient.fromConnectionString(target.connectionString, target.tableName, {
        allowInsecureConnection: true,
      });
      const fixture = {
        source: {
          host: "127.0.0.1",
          port: Number(url.port),
          database: "mafia_test",
          user: role,
          password: "",
          ssl: false,
        },
        schema: "public",
        target,
        archiveService: service,
      };
      const readonly = new Pool({ ...fixture.source, password: () => "" });
      try {
        for (const relation of ["user_sessions", "youtube_oauth_credentials"])
          await assert.rejects(readonly.query(`SELECT * FROM ${relation}`), { code: "42501" });
      } finally {
        await readonly.end();
      }
      const before = (
        await pool.query("SELECT row_to_json(t)::text AS row FROM game_sessions t ORDER BY id")
      ).rows;
      const output = [];
      const options = {
        projectRoot: directory,
        cliPath: join(compiled, "migrate-postgres-to-storage.js"),
        fixture,
        emit: (line) => output.push(line),
      };
      // Both discovery and child CLI must ignore libpq configuration/passfile fallback.
      for (const key of [
        "PGHOST",
        "PGPASSWORD",
        "PGSSLNEGOTIATION",
        "PGOPTIONS",
        "DATABASE_URL",
        "AZURE_STORAGE_CONNECTION_STRING",
      ]) {
        previous[key] = process.env[key];
        process.env[key] = sentinel;
      }
      const archiveName = freshArchive();
      const exported = await runMigrationRuntime({ ...options, mode: "export", archiveName });
      assert.equal(
        exported.status,
        "archived",
        JSON.stringify({ stage: exported.stage, code: exported.code }),
      );
      assert.match(exported.sha256, /^[a-f0-9]{64}$/);
      assert.equal(
        exported.sourceRelationCounts.players,
        (await pool.query("SELECT COUNT(*)::int AS count FROM players")).rows[0].count,
      );
      assert.equal(exported.sourceRelationCounts.game_sessions, 1);
      assert.equal(exported.sourceRelationCounts.tournaments, 1);
      assert.equal(exported.sourceRelationCounts.game_tournaments, 1);
      assert.deepEqual(Object.keys(exported.sourceRelationCounts).sort(), relations.sort());
      const archive = service.getContainerClient(archiveName);
      assert.deepEqual(await names(archive), [
        "export-result.json",
        "package/manifest.json",
        "package/source.json",
      ]);
      assert.equal((await archive.getProperties()).blobPublicAccess, undefined);
      const sourceBytes = await archive
        .getBlockBlobClient("package/source.json")
        .downloadToBuffer();
      const source = JSON.parse(sourceBytes.toString("utf8"));
      assert.equal(Object.hasOwn(source.relations, "user_sessions"), false);
      assert.equal(Object.hasOwn(source.relations, "youtube_oauth_credentials"), false);
      assert.ok(sourceBytes.includes(Buffer.from(sentinel))); // private business data is preserved, never logged
      assert.equal(await service.getContainerClient(target.containerName).exists(), false);
      await assert.rejects(table.getEntity(target.partitionKey, "control"), { statusCode: 404 });

      await t.test(
        "invalid approval and mismatched archive refuse before target writes",
        async () => {
          for (const sha256 of [undefined, exported.sha256.toUpperCase(), "0".repeat(64)]) {
            const result = await runMigrationRuntime({
              ...options,
              mode: "apply",
              archiveName,
              sha256,
            });
            assert.equal(result.status, "failed");
          }
          assert.equal(await service.getContainerClient(target.containerName).exists(), false);
          await assert.rejects(table.getEntity(target.partitionKey, "control"), {
            statusCode: 404,
          });
          assert.deepEqual(await names(archive), [
            "export-result.json",
            "package/manifest.json",
            "package/source.json",
          ]);
        },
      );
      await t.test(
        "foreign archive path and corrupt source refuse without touching target",
        async () => {
          await archive
            .getBlockBlobClient("package/unapproved-config.json")
            .uploadData(Buffer.from(sentinel));
          const pathResult = await runMigrationRuntime({
            ...options,
            mode: "apply",
            archiveName,
            sha256: exported.sha256,
          });
          assert.equal(pathResult.status, "failed");
          assert.equal(pathResult.stage, "archive-download");
          await archive.getBlockBlobClient("package/unapproved-config.json").delete(); // owned fixture corruption only
          // SDK URL normalization prevents creating a literal ../ object via
          // uploadData; inject only that list response to test traversal refusal.
          const traversalService = {
            url: service.url,
            getContainerClient: (name) => {
              const container = service.getContainerClient(name);
              if (name === archiveName) {
                const list = container.listBlobsFlat.bind(container);
                container.listBlobsFlat = async function* () {
                  for await (const item of list()) yield item;
                  yield { name: "package/../source-config.json" };
                };
              }
              return container;
            },
          };
          const traversal = await runMigrationRuntime({
            ...options,
            fixture: { ...fixture, archiveService: traversalService },
            mode: "apply",
            archiveName,
            sha256: exported.sha256,
          });
          assert.equal(traversal.code, "ARCHIVE_PATH_INVALID");
          const manifestBlob = archive.getBlockBlobClient("package/manifest.json");
          const manifestBytes = await manifestBlob.downloadToBuffer();
          await manifestBlob.uploadData(Buffer.from("{}"), {
            metadata: { sha256: hash(Buffer.from("{}")) },
            blobHTTPHeaders: { blobContentType: "application/json" },
          });
          const wrongManifest = await runMigrationRuntime({
            ...options,
            mode: "apply",
            archiveName,
            sha256: exported.sha256,
          });
          assert.equal(wrongManifest.code, "SHA256_MISMATCH");
          await manifestBlob.uploadData(manifestBytes, {
            metadata: { sha256: hash(manifestBytes) },
            blobHTTPHeaders: { blobContentType: "application/json" },
          });
          await archive.getBlockBlobClient("package/source.json").uploadData(Buffer.from("{}"), {
            metadata: { sha256: hash(Buffer.from("{}")) },
            blobHTTPHeaders: { blobContentType: "application/json" },
          });
          const corrupt = await runMigrationRuntime({
            ...options,
            mode: "apply",
            archiveName,
            sha256: exported.sha256,
          });
          assert.equal(corrupt.status, "failed");
          assert.equal(await service.getContainerClient(target.containerName).exists(), false);
          await assert.rejects(table.getEntity(target.partitionKey, "control"), {
            statusCode: 404,
          });
          await archive.getBlockBlobClient("package/source.json").uploadData(sourceBytes, {
            metadata: { sha256: hash(sourceBytes) },
            blobHTTPHeaders: { blobContentType: "application/json" },
          });
        },
      );
      await t.test("create-only archive refuses adoption and retains old bytes", async () => {
        const oldManifest = await archive
          .getBlockBlobClient("package/manifest.json")
          .downloadToBuffer();
        const result = await runMigrationRuntime({ ...options, mode: "export", archiveName });
        assert.equal(result.status, "failed");
        assert.equal(result.stage, "archive-create");
        assert.deepEqual(
          await archive.getBlockBlobClient("package/manifest.json").downloadToBuffer(),
          oldManifest,
        );
      });
      await t.test("raw child CLI output and errors are not forwarded", async () => {
        const noisyCli = join(compiled, "noisy-cli.mjs");
        await writeFile(
          noisyCli,
          `console.log(${JSON.stringify(sentinel)}); console.error(${JSON.stringify(sentinel)}); process.exitCode = 1;`,
          { mode: 0o600 },
        );
        const result = await runMigrationRuntime({
          ...options,
          cliPath: noisyCli,
          mode: "export",
          archiveName: freshArchive(),
        });
        assert.deepEqual(result, {
          mode: "export",
          status: "failed",
          stage: "export",
          code: "CLI_FAILED",
        });
      });
      await t.test(
        "failed archive upload retains private container and verified earlier bytes",
        async () => {
          const partialArchive = freshArchive();
          const failingService = {
            url: service.url,
            getContainerClient: (name) => {
              const container = service.getContainerClient(name);
              if (name === partialArchive) {
                const getBlob = container.getBlockBlobClient.bind(container);
                container.getBlockBlobClient = (blobName) => {
                  const blob = getBlob(blobName);
                  if (blobName === "package/manifest.json")
                    blob.uploadData = async () => {
                      throw new Error(sentinel);
                    };
                  return blob;
                };
              }
              return container;
            },
          };
          const result = await runMigrationRuntime({
            ...options,
            fixture: { ...fixture, archiveService: failingService },
            mode: "export",
            archiveName: partialArchive,
          });
          assert.deepEqual(result, {
            mode: "export",
            status: "failed",
            stage: "archive-upload",
            code: "OPERATION_FAILED",
          });
          const partial = service.getContainerClient(partialArchive);
          assert.deepEqual(await names(partial), ["package/source.json"]);
          assert.deepEqual(
            await partial.getBlockBlobClient("package/source.json").downloadToBuffer(),
            sourceBytes,
          );
          assert.equal((await partial.getProperties()).blobPublicAccess, undefined);
          assert.equal(await service.getContainerClient(target.containerName).exists(), false);
        },
      );
      await t.test("populated destination is rejected without merge or overwrite", async () => {
        await table.createTable();
        const row = {
          partitionKey: target.partitionKey,
          rowKey: "foreign",
          privateValue: sentinel,
        };
        await table.createEntity(row);
        const before = await table.getEntity(target.partitionKey, "foreign");
        const result = await runMigrationRuntime({
          ...options,
          mode: "apply",
          archiveName,
          sha256: exported.sha256,
        });
        assert.equal(result.status, "failed");
        assert.equal(result.stage, "apply");
        assert.deepEqual(await table.getEntity(target.partitionKey, "foreign"), before);
        await assert.rejects(table.getEntity(target.partitionKey, "control"), { statusCode: 404 });
        assert.equal(await service.getContainerClient(target.containerName).exists(), false);
        await table.deleteTable(); // only this disposable fixture's table
      });
      const applied = await runMigrationRuntime({
        ...options,
        mode: "apply",
        archiveName,
        sha256: exported.sha256,
      });
      assert.equal(applied.status, "imported");
      assert.equal(applied.readback.entityCount, exported.entityCount);
      assert.equal(applied.readback.blobCount, exported.blobCount);
      assert.equal(applied.readback.controlRevision, 1);
      assert.equal(applied.readback.repeatStatus, "already-imported");
      const storage = new AzureStorage({
        connectionString: target.connectionString,
        tableName: target.tableName,
        containerName: target.containerName,
        partitionKey: target.partitionKey,
      });
      try {
        assert.deepEqual(await new AzurePlayerStore(storage).list(), await players.list());
        assert.deepEqual(
          await new AzureGameSessionStore(storage).get(game.gameId),
          await games.get(game.gameId),
        );
        assert.deepEqual(await new AzureTournamentStore(storage).list(DEFAULT_CLUB_ID), [
          tournament,
        ]);
        assert.deepEqual(
          await new AzureGameSessionStore(storage).readStatisticsInputs(),
          await games.readStatisticsInputs(),
        );
      } finally {
        await storage.end();
      }
      const repeated = await runMigrationRuntime({
        ...options,
        mode: "apply",
        archiveName,
        sha256: exported.sha256,
      });
      assert.equal(repeated.status, "already-imported");
      for (const relation of relations)
        assert.deepEqual(
          (
            await pool.query(
              `SELECT row_to_json(t)::text AS row FROM public.${relation} t ORDER BY row_to_json(t)::text`,
            )
          ).rows.map((row) => row.row),
          source.relations[relation],
          `Source relation changed: ${relation}`,
        );
      assert.deepEqual(
        (await pool.query("SELECT row_to_json(t)::text AS row FROM game_sessions t ORDER BY id"))
          .rows,
        before,
      );
      assert.deepEqual(await names(archive), [
        "apply-result.json",
        "export-result.json",
        "package/manifest.json",
        "package/source.json",
      ]);
      for (const receiptName of ["export-result.json", "apply-result.json"]) {
        const bytes = await archive.getBlockBlobClient(receiptName).downloadToBuffer();
        const value = JSON.parse(bytes.toString("utf8"));
        assert.deepEqual(value, receiptName === "export-result.json" ? exported : applied);
        assert.equal(bytes.includes(Buffer.from(sentinel)), false);
        assert.equal(bytes.includes(Buffer.from(target.connectionString)), false);
        assert.equal(bytes.includes(Buffer.from(role)), false);
        const properties = await archive.getBlockBlobClient(receiptName).getProperties();
        assert.equal(properties.metadata.sha256, hash(bytes));
      }
      const retained = (await readdir(join(directory, ".AI"))).filter((name) =>
        name.startsWith("production-migration-"),
      );
      assert.ok(retained.length > 0);
      for (const name of retained) {
        const path = join(directory, ".AI", name);
        assert.equal((await stat(path)).mode & 0o777, 0o700);
        for (const config of (await readdir(path)).filter((name) => name.endsWith("config.json")))
          assert.equal((await stat(join(path, config))).mode & 0o777, 0o600);
      }
      await t.test("compiled CLI also roundtrips the exact pre-tournament catalog", async () => {
        const schema = `runtime_preceding_${randomUUID().replaceAll("-", "")}`;
        await pool.query(`CREATE SCHEMA ${schema}`);
        const precedingPool = new Pool({
          connectionString: pg.url,
          options: `-c search_path=${schema}`,
        });
        try {
          await initializeSchema(precedingPool);
          const original = await new GameSessionStore(precedingPool).create({
            creationId: randomUUID(),
            name: "Pre-tournament fixture",
            state: { opaque: "Unchanged pre-tournament canonical material" },
            results: null,
          });
          // Reconstruct only the approved predecessor in this owned fixture.
          await precedingPool.query("DROP TABLE game_tournaments; DROP TABLE tournaments");
          const before = (
            await precedingPool.query("SELECT row_to_json(g)::text AS row FROM game_sessions g")
          ).rows;
          await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
          for (const relation of relations.filter(
            (name) => !["tournaments", "game_tournaments"].includes(name),
          ))
            await pool.query(`GRANT SELECT ON ${schema}.${relation} TO ${role}`);
          const suffix = randomUUID().replaceAll("-", "");
          const precedingTarget = {
            ...target,
            tableName: `Preceding${suffix}`,
            containerName: `preceding-${suffix}`,
            partitionKey: `preceding-${suffix}`,
          };
          const precedingOptions = {
            ...options,
            fixture: { ...fixture, schema, target: precedingTarget },
          };
          const archiveName = freshArchive();
          const exported = await runMigrationRuntime({
            ...precedingOptions,
            mode: "export",
            archiveName,
          });
          assert.equal(
            exported.status,
            "archived",
            JSON.stringify({ stage: exported.stage, code: exported.code }),
          );
          assert.deepEqual(
            Object.keys(exported.sourceRelationCounts).sort(),
            relations.filter((name) => !["tournaments", "game_tournaments"].includes(name)).sort(),
          );
          const applied = await runMigrationRuntime({
            ...precedingOptions,
            mode: "apply",
            archiveName,
            sha256: exported.sha256,
          });
          assert.equal(applied.status, "imported");
          assert.equal(applied.readback.repeatStatus, "already-imported");
          const storage = new AzureStorage(precedingTarget);
          try {
            assert.deepEqual(
              await new AzureGameSessionStore(storage).get(original.gameId),
              original,
            );
            assert.deepEqual(await new AzureTournamentStore(storage).list(DEFAULT_CLUB_ID), []);
          } finally {
            await storage.end();
          }
          assert.deepEqual(
            (await precedingPool.query("SELECT row_to_json(g)::text AS row FROM game_sessions g"))
              .rows,
            before,
          );
          assert.deepEqual(
            (
              await precedingPool.query(
                "SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename IN ('tournaments','game_tournaments')",
              )
            ).rows,
            [],
          );
        } finally {
          await precedingPool.end();
          await pool.query(`DROP SCHEMA ${schema} CASCADE`);
        }
      });
      t.diagnostic(
        `Verified ${applied.entityCount} imported entities plus one control row and ${applied.blobCount} private blobs; existing server readers matched SQL originals.`,
      );
      assert.equal(output.length > 0, true);
      assert.ok(output.every((line) => /^(?:MIGRATION_RESULT|MIGRATION_FAILURE) /.test(line)));
      assert.equal(output.join("\n").includes(sentinel), false);
      assert.equal(output.join("\n").includes(target.connectionString), false);
      assert.equal(output.join("\n").includes(role), false);
      assert.equal(
        (await readFile(join(compiled, "migrate-postgres-to-storage.js"))).length > 0,
        true,
      );
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      try {
        await pool?.end();
      } finally {
        try {
          await emulator?.stop();
        } finally {
          await pg.stop();
        }
      }
    }
  },
);

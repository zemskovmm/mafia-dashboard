// Standalone: node /app/apps/server/.AI/migration-runtime.mjs.
// This wrapper never changes app revisions, deletes storage, or changes SQL.
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { execFile } from "node:child_process";
import { promisify, isDeepStrictEqual } from "node:util";
import { Client } from "pg";
import { ManagedIdentityCredential } from "@azure/identity";
import { setLogLevel } from "@azure/logger";
import { BlobServiceClient } from "@azure/storage-blob";
import { TableClient } from "@azure/data-tables";

export const PRODUCTION_SOURCE = Object.freeze({
  host: "mafiadashboard-pg-6du4xvao4bfk2.postgres.database.azure.com",
  port: 5432,
  database: "mafia_current_20260930",
  user: "mafiaadmin",
  ssl: Object.freeze({ rejectUnauthorized: true }),
});
export const PRODUCTION_TARGET = Object.freeze({
  mode: "managed-identity",
  accountName: "mafiadata6du4xvao4bfk2",
  tableName: "MafiaEntities",
  containerName: "mafia-live",
  partitionKey: "production-v1",
  clientId: "bc57902a-221c-42fd-b551-c02e91927362",
});
const packageFiles = ["manifest.json", "source.json"];
const relations = [
  "club_memberships",
  "clubs",
  "deleted_clubs",
  "deleted_games",
  "game_daily_counters",
  "game_events",
  "game_player_results",
  "game_results",
  "game_rulesets",
  "game_session_creations",
  "game_session_mutations",
  "game_session_players",
  "game_sessions",
  "players",
  "users",
];
const hashPattern = /^[a-f0-9]{64}$/;
const maxFile = 67108864;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (code) => {
  throw new RuntimeRefusal(code);
};
class RuntimeRefusal extends Error {
  constructor(code) {
    super("Migration refused");
    this.safeCode = code;
  }
}
export const clearPostgresEnvironment = () => {
  for (const key of Object.keys(process.env))
    if (key.startsWith("PG") || key === "DATABASE_URL") delete process.env[key];
};
const realDirectory = async (directory) => {
  let current = parse(directory).root;
  for (const part of directory.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("UNSAFE_PATH");
  }
};
const privateWrite = async (path, bytes) => {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
};
const privateRead = async (path, max = maxFile) => {
  await realDirectory(dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid() ||
      info.mode & 0o077 ||
      info.size > max
    )
      fail("UNSAFE_FILE");
    const bytes = await handle.readFile();
    if (bytes.length !== info.size) fail("CHANGED_FILE");
    return bytes;
  } finally {
    await handle.close();
  }
};
const freshDirectory = async (root, mode) => {
  await realDirectory(root);
  const ai = join(root, ".AI");
  try {
    await mkdir(ai, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await realDirectory(ai);
  const directory = join(ai, `production-migration-${mode}-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  return directory;
};
const normalizeAddress = (address) => address?.replace(/^::ffff:/, "");
// Discover only identity, in an explicitly read-only session. The later CLI
// snapshot checks this exact backend identity again; no guessed backend address.
const discoverSource = async (connection, schema, local) => {
  clearPostgresEnvironment();
  const addresses = local
    ? [{ address: "127.0.0.1" }]
    : await lookup(connection.host, { all: true });
  const client = new Client({
    ...connection,
    password: () => connection.password,
    client_encoding: "UTF8",
    connectionTimeoutMillis: 15000,
    query_timeout: 60000,
    options: `-c search_path=${schema} -c default_transaction_read_only=on -c statement_timeout=60000`,
  });
  let sourceBroken = false;
  // A socket failure while idle must not become an uncaught raw pg error.
  client.on("error", () => {
    sourceBroken = true;
  });
  try {
    await client.connect();
    const stream = client.connection.stream;
    const resolved = addresses.map(({ address }) => normalizeAddress(address));
    if (!resolved.includes(normalizeAddress(stream.remoteAddress))) fail("SOURCE_DNS_MISMATCH");
    if (
      !local &&
      (!stream.encrypted ||
        !stream.authorized ||
        checkServerIdentity(connection.host, stream.getPeerCertificate()) !== undefined)
    )
      fail("SOURCE_TLS_MISMATCH");
    await client.query("BEGIN READ ONLY");
    const row = (
      await client.query(
        `SELECT current_database() AS database, current_schema() AS schema, host(inet_server_addr()) AS "serverAddress", inet_server_port() AS "serverPort", current_user AS username, current_setting('transaction_read_only') AS readonly`,
      )
    ).rows[0];
    if (
      !row ||
      row.database !== connection.database ||
      row.schema !== schema ||
      row.serverPort !== connection.port ||
      row.username !== connection.user ||
      row.readonly !== "on" ||
      !resolved.includes(normalizeAddress(row.serverAddress))
    )
      fail("SOURCE_IDENTITY_MISMATCH");
    await client.query("COMMIT");
    if (sourceBroken) fail("SOURCE_CONNECTION_FAILED");
    return {
      database: row.database,
      schema: row.schema,
      serverAddress: row.serverAddress,
      serverPort: row.serverPort,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
};
const clients = (target, local, archiveService) => {
  if (local) {
    const service =
      archiveService ??
      BlobServiceClient.fromConnectionString(target.connectionString, {
        retryOptions: { maxTries: 1, tryTimeoutInMs: 120000 },
      });
    const table = TableClient.fromConnectionString(target.connectionString, target.tableName, {
      allowInsecureConnection: true,
      retryOptions: { maxRetries: 0 },
    });
    return { service, table, blobs: service.getContainerClient(target.containerName) };
  }
  const credential = new ManagedIdentityCredential({ clientId: PRODUCTION_TARGET.clientId });
  const service = new BlobServiceClient(
    `https://${PRODUCTION_TARGET.accountName}.blob.core.windows.net`,
    credential,
    { retryOptions: { maxTries: 1, tryTimeoutInMs: 120000 } },
  );
  return {
    service,
    table: new TableClient(
      `https://${PRODUCTION_TARGET.accountName}.table.core.windows.net`,
      PRODUCTION_TARGET.tableName,
      credential,
      { retryOptions: { maxRetries: 0 } },
    ),
    blobs: service.getContainerClient(PRODUCTION_TARGET.containerName),
  };
};
const targetIdentity = (target, storage, local) => ({
  mode: target.mode,
  accountName: local ? new URL(storage.blobs.url).pathname.split("/")[1] : target.accountName,
  tableName: target.tableName,
  containerName: target.containerName,
  partitionKey: target.partitionKey,
  tableUrl: `${storage.table.url.replace(/\/$/, "")}/${storage.table.tableName}`,
  containerUrl: storage.blobs.url,
});
const runCli = async (cliPath, root, directory, command, extra = []) => {
  const environment = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "IDENTITY_ENDPOINT",
    "IDENTITY_HEADER",
    "MSI_ENDPOINT",
    "MSI_SECRET",
  ])
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  let stdout;
  try {
    // Fixed Node executable, no shell. Config paths, not secrets, go in argv.
    ({ stdout } = await promisify(execFile)(
      process.execPath,
      [cliPath, command, "--project-root", root, "--package", directory, ...extra],
      { cwd: root, env: environment, timeout: 480000, maxBuffer: 1048576 },
    ));
  } catch {
    fail("CLI_FAILED");
  }
  let result;
  try {
    result = JSON.parse(stdout.trim());
  } catch {
    fail("CLI_RESULT_INVALID");
  }
  const statuses = {
    export: ["exported"],
    validate: ["validated"],
    apply: ["imported", "already-imported"],
  };
  if (
    !statuses[command].includes(result?.status) ||
    !hashPattern.test(result?.sha256 ?? "") ||
    !Number.isSafeInteger(result.entityCount) ||
    result.entityCount < 1 ||
    !Number.isSafeInteger(result.blobCount) ||
    result.blobCount < 0
  )
    fail("CLI_RESULT_INVALID");
  return result; // never forward raw stdout, stderr, target, or arbitrary fields
};
const checkedPackage = async (directory, validation, expectedTarget, expectedSource, approved) => {
  if (!isDeepStrictEqual((await readdir(directory)).sort(), packageFiles))
    fail("PACKAGE_FILES_INVALID");
  const bytes = await privateRead(join(directory, "manifest.json"), 1048576);
  const sha256 = digest(bytes);
  if (validation.sha256 !== sha256 || (approved !== undefined && sha256 !== approved))
    fail("SHA256_MISMATCH");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (
    !isDeepStrictEqual(manifest.target, expectedTarget) ||
    manifest.source.database !== expectedSource.database ||
    manifest.source.schema !== expectedSource.schema ||
    manifest.source.serverPort !== expectedSource.port ||
    !isIP(manifest.source.serverAddress)
  )
    fail("PACKAGE_IDENTITY_MISMATCH");
  if (
    manifest.entityCount !== validation.entityCount ||
    manifest.blobCount !== validation.blobCount ||
    !isDeepStrictEqual(manifest.excluded, ["user_sessions", "youtube_oauth_credentials"])
  )
    fail("PACKAGE_PROOF_INVALID");
  const sourceBytes = await privateRead(join(directory, "source.json"));
  if (sourceBytes.length !== manifest.sourceLength || digest(sourceBytes) !== manifest.sourceSha256)
    fail("PACKAGE_PROOF_INVALID");
  const source = JSON.parse(sourceBytes.toString("utf8"));
  if (
    !isDeepStrictEqual(Object.keys(source.relations).sort(), relations) ||
    !isDeepStrictEqual(source.source, manifest.source)
  )
    fail("PACKAGE_PROOF_INVALID");
  const sourceRelationCounts = {};
  for (const relation of relations) {
    if (!Array.isArray(source.relations[relation])) fail("PACKAGE_PROOF_INVALID");
    sourceRelationCounts[relation] = source.relations[relation].length;
  }
  return { manifest, sha256, sourceRelationCounts };
};
const archiveInventory = async (archive) => {
  const names = [];
  for await (const item of archive.listBlobsFlat()) names.push(item.name);
  const packages = names.filter((name) => name.startsWith("package/")).sort();
  if (
    !isDeepStrictEqual(
      packages,
      packageFiles.map((name) => `package/${name}`),
    ) ||
    names.some(
      (name) =>
        ![
          "package/manifest.json",
          "package/source.json",
          "export-result.json",
          "apply-result.json",
        ].includes(name),
    )
  )
    fail("ARCHIVE_PATH_INVALID");
};
const archiveProperties = async (archive, sha256) => {
  const properties = await archive.getProperties();
  if (
    properties.blobPublicAccess !== undefined ||
    !isDeepStrictEqual(properties.metadata, { migrationmanifestsha256: sha256 })
  )
    fail("ARCHIVE_IDENTITY_MISMATCH");
};
const readBlob = async (client, max) => {
  const properties = await client.getProperties();
  if (
    !Number.isSafeInteger(properties.contentLength) ||
    properties.contentLength < 1 ||
    properties.contentLength > max ||
    properties.contentType !== "application/json" ||
    !hashPattern.test(properties.metadata?.sha256 ?? "")
  )
    fail("ARCHIVE_FILE_INVALID");
  const bytes = await client.downloadToBuffer(0, properties.contentLength, {
    conditions: { ifMatch: properties.etag },
  });
  if (bytes.length !== properties.contentLength || digest(bytes) !== properties.metadata.sha256)
    fail("ARCHIVE_HASH_MISMATCH");
  return bytes;
};
const uploadVerified = async (client, bytes) => {
  await client.uploadData(bytes, {
    conditions: { ifNoneMatch: "*" },
    blobHTTPHeaders: { blobContentType: "application/json" },
    metadata: { sha256: digest(bytes) },
    maxSingleShotSize: maxFile,
    concurrency: 1,
  });
  if (!(await readBlob(client, bytes.length)).equals(bytes)) fail("ARCHIVE_READBACK_MISMATCH");
};
const receipt = async (archive, result) => {
  const client = archive.getBlockBlobClient(result.receiptName);
  const bytes = Buffer.from(JSON.stringify(result));
  if (result.mode === "apply" && (await client.exists())) {
    // A rerun must not overwrite the first completion receipt. Accept only the
    // exact sanitized proof for this package (the first CLI status may differ).
    const old = await readBlob(client, 16384);
    const value = JSON.parse(old.toString("utf8"));
    if (
      !["imported", "already-imported"].includes(value.status) ||
      !isDeepStrictEqual(value, { ...result, status: value.status })
    )
      fail("RECEIPT_MISMATCH");
  } else await uploadVerified(client, bytes);
};
const independentReadback = async (storage, proof) => {
  const { manifest, sha256 } = proof;
  let count = 0;
  let control;
  const keys = new Set();
  for await (const row of storage.table.listEntities()) {
    if (row.partitionKey !== manifest.target.partitionKey || keys.has(row.rowKey))
      fail("TARGET_INVENTORY_MISMATCH");
    keys.add(row.rowKey);
    if (row.rowKey === "control") control = row;
    else count++;
  }
  const expected = {
    partitionKey: manifest.target.partitionKey,
    rowKey: "control",
    schemaVersion: 1,
    datasetId: manifest.datasetId,
    revision: 1,
    blobContainer: manifest.target.containerUrl,
    writeMode: "normal",
    migrationPackageSha256: sha256,
    migrationOwner: manifest.packageId,
  };
  const logical =
    control &&
    Object.fromEntries(
      Object.entries(control).filter(([key]) => !["etag", "timestamp"].includes(key)),
    );
  if (count !== manifest.entityCount || !isDeepStrictEqual(logical, expected))
    fail("TARGET_CONTROL_MISMATCH");
  const properties = await storage.blobs.getProperties();
  if (
    properties.blobPublicAccess !== undefined ||
    !isDeepStrictEqual(properties.metadata, { postgresmigrationowner: manifest.packageId })
  )
    fail("TARGET_OWNER_MISMATCH");
  let blobCount = 0;
  for await (const item of storage.blobs.listBlobsFlat()) {
    void item;
    blobCount++;
  }
  if (blobCount !== manifest.blobCount) fail("TARGET_INVENTORY_MISMATCH");
  return { entityCount: count, blobCount, controlRevision: control.revision };
};

/** Explicit local fixtures are a library-only seam, never a main/env override. */
export async function runMigrationRuntime({
  mode,
  archiveName,
  sha256,
  password,
  projectRoot = "/app/apps/server",
  cliPath = join(projectRoot, "dist/migrate-postgres-to-storage.js"),
  fixture,
  emit = (line) => console.log(line),
} = {}) {
  let stage = "input";
  // SDK diagnostics can contain request URLs and headers; never forward them.
  setLogLevel(undefined);
  try {
    if (
      !["export", "apply"].includes(mode) ||
      !/^migration-[a-f0-9]{32}$/.test(archiveName ?? "") ||
      (mode === "apply" && (!hashPattern.test(sha256 ?? "") || password !== undefined)) ||
      (mode === "export" && sha256 !== undefined)
    )
      fail("INVALID_INPUT");
    const local = fixture !== undefined;
    const target = local ? fixture.target : PRODUCTION_TARGET;
    const connection = local ? fixture.source : { ...PRODUCTION_SOURCE, password };
    const schema = local ? fixture.schema : "public";
    if (
      !/^[a-z_][a-z0-9_]{0,62}$/.test(schema ?? "") ||
      (mode === "export" && typeof connection.password !== "string")
    )
      fail("INVALID_INPUT");
    if (
      local &&
      (connection.host !== "127.0.0.1" ||
        connection.ssl !== false ||
        connection.database !== "mafia_test" ||
        target.mode !== "local")
    )
      fail("FIXTURE_REQUIRED");
    // Never consult inherited libpq settings, even before identity discovery.
    clearPostgresEnvironment();
    stage = "private-inputs";
    const root = resolve(projectRoot);
    const directory = await freshDirectory(root, mode);
    const pkg = join(directory, "package");
    const targetFile = join(directory, "target-config.json");
    await privateWrite(targetFile, Buffer.from(JSON.stringify(target)));
    const storage = clients(target, local, fixture?.archiveService);
    if (
      local &&
      (new URL(storage.blobs.url).hostname !== "127.0.0.1" ||
        new URL(storage.table.url).hostname !== "127.0.0.1" ||
        new URL(storage.service.url).hostname !== "127.0.0.1")
    )
      fail("FIXTURE_REQUIRED");
    const expectedTarget = targetIdentity(target, storage, local);
    const archive = storage.service.getContainerClient(archiveName);
    let exported;
    if (mode === "export") {
      stage = "source-identity";
      const identity = await discoverSource(connection, schema, local);
      const sourceFile = join(directory, "source-config.json");
      await privateWrite(sourceFile, Buffer.from(JSON.stringify({ identity, connection })));
      stage = "export";
      exported = await runCli(cliPath, root, pkg, "export", [
        "--source-file",
        sourceFile,
        "--target-file",
        targetFile,
      ]);
    } else {
      stage = "archive-download";
      await archiveProperties(archive, sha256);
      await archiveInventory(archive);
      await mkdir(pkg, { mode: 0o700 });
      for (const name of packageFiles)
        await privateWrite(
          join(pkg, name),
          await readBlob(
            archive.getBlockBlobClient(`package/${name}`),
            name === "manifest.json" ? 1048576 : maxFile,
          ),
        );
      if (digest(await privateRead(join(pkg, "manifest.json"), 1048576)) !== sha256)
        fail("SHA256_MISMATCH");
    }
    stage = "validate";
    const validation = await runCli(cliPath, root, pkg, "validate");
    const proof = await checkedPackage(
      pkg,
      validation,
      expectedTarget,
      { database: connection.database, schema, port: connection.port },
      mode === "apply" ? sha256 : exported.sha256,
    );
    const result = {
      mode,
      status: mode === "export" ? "archived" : "imported",
      sha256: proof.sha256,
      entityCount: proof.manifest.entityCount,
      blobCount: proof.manifest.blobCount,
      sourceRelationCounts: proof.sourceRelationCounts,
      receiptName: mode === "export" ? "export-result.json" : "apply-result.json",
    };
    if (mode === "export") {
      stage = "archive-create";
      // create(), never createIfNotExists(): an existing container is not ours.
      await archive.create({
        access: undefined,
        metadata: { migrationmanifestsha256: proof.sha256 },
      });
      stage = "archive-upload";
      for (const name of ["source.json", "manifest.json"])
        await uploadVerified(
          archive.getBlockBlobClient(`package/${name}`),
          await privateRead(join(pkg, name), name === "manifest.json" ? 1048576 : maxFile),
        );
      await archiveProperties(archive, proof.sha256);
      await archiveInventory(archive);
    } else {
      stage = "apply";
      const applied = await runCli(cliPath, root, pkg, "apply", [
        "--target-file",
        targetFile,
        "--sha256",
        sha256,
      ]);
      if (
        applied.sha256 !== proof.sha256 ||
        applied.entityCount !== result.entityCount ||
        applied.blobCount !== result.blobCount
      )
        fail("CLI_RESULT_INVALID");
      result.status = applied.status;
      stage = "target-readback";
      result.readback = await independentReadback(storage, proof);
      // Recognized completed control proved above: this branch of the unchanged
      // CLI performs a full typed-row/blob-byte comparison without any writes.
      const repeated = await runCli(cliPath, root, pkg, "apply", [
        "--target-file",
        targetFile,
        "--sha256",
        sha256,
      ]);
      if (
        repeated.status !== "already-imported" ||
        repeated.sha256 !== proof.sha256 ||
        repeated.entityCount !== result.entityCount ||
        repeated.blobCount !== result.blobCount
      )
        fail("TARGET_READBACK_MISMATCH");
      result.readback.repeatStatus = repeated.status;
    }
    stage = "receipt";
    await receipt(archive, result);
    await archiveProperties(archive, proof.sha256);
    await archiveInventory(archive);
    emit(`MIGRATION_RESULT ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    const code = error instanceof RuntimeRefusal ? error.safeCode : "OPERATION_FAILED";
    emit(`MIGRATION_FAILURE ${JSON.stringify({ stage, code })}`);
    return { mode, status: "failed", stage, code };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // No CLI arguments or arbitrary connection/resource environment overrides.
  const result =
    process.argv.length === 2
      ? await runMigrationRuntime({
          mode: process.env.MIGRATION_MODE,
          archiveName: process.env.MIGRATION_ARCHIVE,
          sha256: process.env.MIGRATION_SHA256,
          password: process.env.POSTGRES_PASSWORD,
        })
      : { status: "failed" };
  if (process.argv.length !== 2)
    console.log('MIGRATION_FAILURE {"stage":"input","code":"INVALID_INPUT"}');
  if (result.status === "failed") process.exitCode = 1;
}

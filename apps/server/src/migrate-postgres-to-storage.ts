import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { Pool } from "pg";
import { z } from "zod";
import {
  applyPostgresMigration,
  localMigrationStorage,
  managedIdentityMigrationStorage,
  migrationSourceSchema,
  migrationTarget,
  PostgresMigrationError,
  preparePostgresMigration,
  readProtectedMigrationFile,
  validatePostgresMigration,
} from "./postgres-storage-migration.js";

const usage = `Usage (explicit operator command, never application startup):
  migrate-postgres-to-storage export --project-root PATH --package PATH --source-file PATH --target-file PATH
  migrate-postgres-to-storage validate --project-root PATH --package PATH
  migrate-postgres-to-storage apply --project-root PATH --package PATH --target-file PATH --sha256 HASH
Credentials belong only in private files, never argv. No application environment is inherited.`;
const resources = {
  tableName: z.string().min(3),
  containerName: z.string().min(3),
  partitionKey: z.string().min(1),
};
const targetFile = z.discriminatedUnion("mode", [
  z
    .object({ mode: z.literal("local"), connectionString: z.string().min(1), ...resources })
    .strict(),
  z
    .object({
      mode: z.literal("managed-identity"),
      accountName: z.string().regex(/^[a-z0-9]{3,24}$/),
      clientId: z.string().uuid().optional(),
      ...resources,
    })
    .strict(),
]);
const sourceFile = z
  .object({
    identity: migrationSourceSchema,
    connection: z
      .object({
        host: z.string().min(1),
        port: z.number().int().min(1).max(65535),
        database: z.string().min(1),
        user: z.string().min(1),
        password: z.string(),
        ssl: z.union([
          z.literal(false),
          z
            .object({ rejectUnauthorized: z.literal(true), ca: z.string().min(1).optional() })
            .strict(),
        ]),
      })
      .strict(),
  })
  .strict();
const protectedJson = async (path: string): Promise<unknown> =>
  JSON.parse(
    (await readProtectedMigrationFile(resolve(path), 1048576)).toString("utf8"),
  ) as unknown;
const target = async (path: string) => {
  const parsed = targetFile.safeParse(await protectedJson(path));
  if (!parsed.success) throw new PostgresMigrationError("Invalid protected target configuration");
  const config = parsed.data;
  if (config.mode === "local")
    return localMigrationStorage({
      connectionString: config.connectionString,
      tableName: config.tableName,
      containerName: config.containerName,
      partitionKey: config.partitionKey,
    });
  return managedIdentityMigrationStorage(
    {
      accountName: config.accountName,
      tableName: config.tableName,
      containerName: config.containerName,
      partitionKey: config.partitionKey,
    },
    config.clientId,
  );
};
const run = async () => {
  const { values, positionals } = parseArgs({
    strict: true,
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      "project-root": { type: "string" },
      package: { type: "string" },
      "source-file": { type: "string" },
      "target-file": { type: "string" },
      sha256: { type: "string" },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const command = positionals[0];
  if (
    positionals.length !== 1 ||
    !["export", "validate", "apply"].includes(command ?? "") ||
    !values["project-root"] ||
    !values.package
  )
    throw new PostgresMigrationError(usage);
  const options = { projectRoot: resolve(values["project-root"]) };
  const directory = resolve(values.package);
  if (command === "validate") {
    if (values["source-file"] || values["target-file"] || values.sha256)
      throw new PostgresMigrationError("validate accepts only project-root and package");
    const proof = await validatePostgresMigration(directory, options);
    console.log(
      JSON.stringify({
        status: "validated",
        sha256: proof.sha256,
        entityCount: proof.manifest.entityCount,
        blobCount: proof.manifest.blobCount,
        target: proof.manifest.target,
      }),
    );
    return;
  }
  if (!values["target-file"]) throw new PostgresMigrationError("Explicit target-file is required");
  const storage = await target(values["target-file"]);
  if (command === "apply") {
    if (values["source-file"] || !values.sha256)
      throw new PostgresMigrationError(
        "apply requires package SHA-256 approval and never accepts source credentials",
      );
    const result = await applyPostgresMigration(storage, directory, {
      ...options,
      sha256: values.sha256,
    });
    console.log(
      JSON.stringify({
        status: result.status,
        sha256: result.sha256,
        entityCount: result.manifest.entityCount,
        blobCount: result.manifest.blobCount,
      }),
    );
    return;
  }
  if (!values["source-file"] || values.sha256)
    throw new PostgresMigrationError(
      "export requires source-file; SHA-256 approval belongs to apply",
    );
  const parsed = sourceFile.safeParse(await protectedJson(values["source-file"]));
  if (!parsed.success) throw new PostgresMigrationError("Invalid protected source configuration");
  const config = parsed.data;
  if (
    config.connection.database !== config.identity.database ||
    (config.connection.ssl === false && config.connection.host !== "127.0.0.1")
  )
    throw new PostgresMigrationError(
      "Source identity mismatch or nonloopback connection without verified TLS",
    );
  // pg treats an empty password as absent and otherwise consults PGPASSWORD
  // or ~/.pgpass. A callback is truthy even for an explicitly empty password.
  // Clear the remaining libpq variables so they cannot change protocol/options.
  for (const key of Object.keys(process.env))
    if (key.startsWith("PG") || key === "DATABASE_URL") delete process.env[key];
  const pool = new Pool({
    ...config.connection,
    password: () => config.connection.password,
    client_encoding: "UTF8",
    max: 1,
    connectionTimeoutMillis: 15000,
    options: `-c search_path=${config.identity.schema} -c default_transaction_read_only=on`,
  });
  try {
    const proof = await preparePostgresMigration(pool, directory, {
      ...options,
      source: config.identity,
      target: migrationTarget(storage),
    });
    console.log(
      JSON.stringify({
        status: "exported",
        sha256: proof.sha256,
        entityCount: proof.manifest.entityCount,
        blobCount: proof.manifest.blobCount,
        target: proof.manifest.target,
      }),
    );
  } finally {
    await pool.end();
  }
};
try {
  await run();
} catch (error) {
  // SDK/pg/parseArgs exceptions can carry signed requests, passwords or argv.
  console.error(
    error instanceof PostgresMigrationError
      ? error.message
      : "Migration failed; inspect protected configuration/package privately; no automatic recovery or cleanup",
  );
  process.exitCode = 1;
}

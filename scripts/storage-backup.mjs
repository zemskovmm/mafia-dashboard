import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { startAzurite } from "./local-azurite.mjs";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const backupRoot = resolve(projectRoot, ".AI/storage-backups");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const usage =
  "Usage: storage-backup --local (--output .AI/storage-backups/NAME | --status | --release-freeze UUID | --collect [--protect PACKAGE ...])";
const restoreUsage =
  "Usage: storage-restore --local --input .AI/storage-backups/NAME --target NEW-UUID";

const packagePath = (value) => {
  if (typeof value !== "string" || !value || value.startsWith("--")) throw new Error(usage);
  const path = resolve(projectRoot, value);
  const child = relative(backupRoot, path);
  if (
    !child ||
    child.startsWith(`..${sep}`) ||
    child === ".." ||
    resolve(backupRoot, child) !== path
  )
    throw new Error(usage);
  return path;
};
const options = (args, allowed, help) => {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!Object.hasOwn(allowed, key) || (key !== "--protect" && Object.hasOwn(result, key)))
      throw new Error(help);
    if (allowed[key]) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(help);
      if (key === "--protect") (result[key] ??= []).push(value);
      else result[key] = value;
    } else result[key] = true;
  }
  if (!result["--local"]) throw new Error(help);
  return result;
};
export function parseBackupArgs(args) {
  const parsed = options(
    args,
    {
      "--local": false,
      "--output": true,
      "--status": false,
      "--release-freeze": true,
      "--collect": false,
      "--protect": true,
    },
    usage,
  );
  const selected = ["--output", "--status", "--release-freeze", "--collect"].filter((key) =>
    Object.hasOwn(parsed, key),
  );
  if (selected.length !== 1 || (parsed["--protect"] && !parsed["--collect"]))
    throw new Error(usage);
  if (parsed["--output"])
    return { operation: "capture", directory: packagePath(parsed["--output"]) };
  if (parsed["--status"]) return { operation: "status" };
  if (parsed["--collect"])
    return {
      operation: "collect",
      protectedDirectories: (parsed["--protect"] ?? []).map(packagePath),
    };
  if (!uuid.test(parsed["--release-freeze"])) throw new Error(usage);
  return { operation: "release", owner: parsed["--release-freeze"] };
}
export function parseRestoreArgs(args) {
  const parsed = options(
    args,
    { "--local": false, "--input": true, "--target": true },
    restoreUsage,
  );
  if (!parsed["--input"] || !uuid.test(parsed["--target"] ?? "")) throw new Error(restoreUsage);
  const targetId = parsed["--target"];
  const suffix = targetId.replaceAll("-", "");
  return {
    directory: packagePath(parsed["--input"]),
    targetId,
    tableName: `MafiaRestore${suffix}`,
    containerName: `mafia-restore-${suffix}`,
  };
}

// Do not follow a link out of the private project-local package tree.
export async function ensureBackupRoot() {
  for (const directory of [resolve(projectRoot, ".AI"), backupRoot]) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe backup root");
  }
}
export const fixtureOptions = (environment) => ({
  connectionString: environment.AZURE_STORAGE_CONNECTION_STRING,
  tableName: environment.AZURE_STORAGE_TABLE_NAME,
  containerName: environment.AZURE_STORAGE_CONTAINER_NAME,
  partitionKey: environment.AZURE_STORAGE_PARTITION_KEY,
});

export async function runBackupCommand(args, openFixture = () => startAzurite({ mode: "dev" })) {
  const command = parseBackupArgs(args);
  await ensureBackupRoot();
  const { AzureStorage } = await import("../apps/server/src/azure-storage.ts");
  const { captureStorageBackup, validateStorageBackup } =
    await import("../apps/server/src/storage-backup.ts");
  const protectedReferences = [];
  if (command.operation === "collect") {
    for (const directory of command.protectedDirectories) {
      const manifest = await validateStorageBackup(directory);
      protectedReferences.push(
        ...manifest.blobs.map(({ name, sha256, length }) => ({ name, sha256, length })),
      );
    }
  }
  // Never use inherited connection strings or load .env; only this owned fixture.
  const fixture = await openFixture();
  const storage = new AzureStorage(fixtureOptions(fixture.environment));
  try {
    await storage.initialize(false);
    if (command.operation === "status") {
      const control = await storage.getControl();
      return {
        operation: "status",
        datasetId: control.datasetId,
        writeMode: control.writeMode,
        freezeOwner: control.freezeOwner ?? null,
        revision: control.revision,
      };
    }
    if (command.operation === "release") {
      await storage.releaseFreeze(command.owner);
      return { operation: "release", writeMode: (await storage.getControl()).writeMode };
    }
    if (command.operation === "collect") {
      const { collectStorageGarbage } =
        await import("../apps/server/src/azure-storage-maintenance.ts");
      return {
        operation: "collect",
        ...(await collectStorageGarbage(storage, protectedReferences)),
      };
    }
    const { version } = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
    const applicationCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim();
    const dirty =
      execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
        cwd: projectRoot,
        encoding: "utf8",
      }).trim() !== "";
    const manifest = await captureStorageBackup(storage, command.directory, {
      applicationVersion: version,
      applicationCommit: `${applicationCommit}${dirty ? "-dirty" : ""}`,
    });
    return {
      operation: "capture",
      directory: command.directory,
      captureId: manifest.captureId,
      entityCount: manifest.entityCount,
      blobCount: manifest.blobCount,
      applicationCommit: manifest.applicationCommit,
    };
  } finally {
    try {
      await storage.end();
    } finally {
      await fixture.stop();
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runBackupCommand(process.argv.slice(2)), null, 2));
  } catch (error) {
    // SDK errors can include signed headers and payloads; never echo them.
    console.error(
      error.message.startsWith("Usage:")
        ? error.message
        : "Storage operation failed; no success claimed. Preserve the package and inspect --local --status before owner-checked recovery. Stop normal local development before using this tool.",
    );
    process.exitCode = 1;
  }
}

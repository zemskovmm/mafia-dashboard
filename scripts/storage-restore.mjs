import { fileURLToPath } from "node:url";
import { startAzurite } from "./local-azurite.mjs";
import { ensureBackupRoot, fixtureOptions, parseRestoreArgs } from "./storage-backup.mjs";

export async function runRestoreCommand(args, openFixture = () => startAzurite({ mode: "dev" })) {
  const command = parseRestoreArgs(args);
  await ensureBackupRoot();
  const { AzureStorage } = await import("../apps/server/src/azure-storage.ts");
  const { restoreStorageBackup, validateStorageBackup } =
    await import("../apps/server/src/storage-backup.ts");
  const manifest = await validateStorageBackup(command.directory);
  const fixture = await openFixture();
  const storage = new AzureStorage({
    ...fixtureOptions(fixture.environment),
    tableName: command.tableName,
    containerName: command.containerName,
    partitionKey: manifest.partitionKey,
  });
  try {
    // The restore library alone reserves a previously empty target; never initialize it here.
    const result = await restoreStorageBackup(storage, command.directory, {
      musicEncryptionKey: process.env.RECOVERY_MUSIC_ENCRYPTION_KEY,
    });
    await storage.ready();
    return {
      operation: "restore",
      tableName: command.tableName,
      containerName: command.containerName,
      partitionKey: manifest.partitionKey,
      datasetId: manifest.datasetId,
      dataEpoch: result.dataEpoch,
      invalidatedSessions: result.invalidatedSessions,
      entityCount: result.manifest.entityCount,
      blobCount: result.manifest.blobCount,
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
    console.log(JSON.stringify(await runRestoreCommand(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(
      error.message.startsWith("Usage:")
        ? error.message
        : "Storage restore failed; no success claimed. Preserve the input and partial target. No reset or overwrite is attempted. A separate protected music key may be required.",
    );
    process.exitCode = 1;
  }
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { AzureStorage } from "../apps/server/src/azure-storage.ts";
import { startAzurite } from "./local-azurite.mjs";
import { runBackupCommand, fixtureOptions, projectRoot } from "./storage-backup.mjs";
import { runRestoreCommand } from "./storage-restore.mjs";

test("backup and restore command handlers use owned storage and read back the isolated target", async () => {
  const fixture = await startAzurite({ mode: "test" });
  const storage = new AzureStorage(fixtureOptions(fixture.environment));
  const open = async () => ({ environment: fixture.environment, stop: async () => {} });
  const directory = resolve(projectRoot, ".AI/storage-backups", `cli-${randomUUID()}`);
  try {
    await storage.initialize(true);
    await storage.mutate(async (tx) => {
      const ref = await tx.writeBlob({ exact: "snapshot Ω", revision: 1 });
      await tx.set("probe", { blobName: ref.name, blobSha256: ref.sha256, blobLength: ref.length });
    });
    const status = await runBackupCommand(["--local", "--status"], open);
    assert.equal(status.writeMode, "normal");
    const captured = await runBackupCommand(["--local", "--output", directory], open);
    assert.equal(captured.operation, "capture");
    assert.equal(captured.blobCount, 1);
    assert.ok(captured.entityCount > 0);
    const targetId = randomUUID();
    const restored = await runRestoreCommand(
      ["--local", "--input", directory, "--target", targetId],
      open,
    );
    assert.equal(restored.operation, "restore");
    assert.equal(restored.datasetId, status.datasetId);
    assert.equal(restored.invalidatedSessions, 0);
    const target = new AzureStorage({
      ...fixtureOptions(fixture.environment),
      tableName: restored.tableName,
      containerName: restored.containerName,
      partitionKey: restored.partitionKey,
    });
    await target.ready();
    assert.deepEqual(
      await target.read(async (tx) => {
        const ref = await tx.get("probe");
        return tx.readBlob({ name: ref.blobName, sha256: ref.blobSha256, length: ref.blobLength });
      }),
      { exact: "snapshot Ω", revision: 1 },
    );
    await assert.rejects(
      runRestoreCommand(["--local", "--input", directory, "--target", targetId], open),
    );
    await target.end();
    const owner = randomUUID();
    await storage.acquireFreeze(owner);
    assert.equal((await runBackupCommand(["--local", "--status"], open)).freezeOwner, owner);
    await assert.rejects(runBackupCommand(["--local", "--release-freeze", randomUUID()], open));
    assert.equal(
      (await runBackupCommand(["--local", "--release-freeze", owner], open)).writeMode,
      "normal",
    );
    const garbage = await runBackupCommand(["--local", "--collect", "--protect", directory], open);
    assert.equal(garbage.operation, "collect");
    assert.equal(garbage.deletedBlobs, 0);
  } finally {
    try {
      await storage.end();
    } finally {
      await fixture.stop();
    }
  }
});

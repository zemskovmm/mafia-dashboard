import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runStorageRecoveryDrill } from "./storage-recovery-drill.js";

it("recovers an authenticated application from its retained private Azure backup", async () => {
  const summary = await runStorageRecoveryDrill();
  expect(summary).toMatchObject({
    backend: "owned-local-azurite",
    invalidatedSessions: 2,
    checks: {
      authenticatedRecovery: true,
      exactSnapshots: true,
      canonicalReplay: true,
      projectionsAndFilters: true,
      secretRedaction: true,
      retiredIdentity: true,
      deletedGame: true,
      subsequentSave: true,
      sourceUnchanged: true,
      tournamentMetadata: true,
      statisticsSource: true,
    },
  });
  expect(summary.entityCount).toBeGreaterThan(30);
  expect(summary.blobCount).toBeGreaterThanOrEqual(2);
  expect(summary.frozenRevision).toBeGreaterThan(0);
  expect(summary.captureId).toMatch(/^[0-9a-f-]{36}$/);
  expect(summary.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(summary.backupDirectory).toMatch(/^\.AI\/storage-backups\/drills\/[0-9a-f-]{36}$/);
  for (const elapsed of [
    summary.captureMs,
    summary.freezeMs,
    summary.restoreMs,
    summary.elapsedMs,
  ]) {
    expect(Number.isFinite(elapsed)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(0);
  }
  expect(summary.elapsedMs).toBeGreaterThan(summary.captureMs + summary.restoreMs);
  const directory = fileURLToPath(new URL(`../../../${summary.backupDirectory}/`, import.meta.url));
  expect((await lstat(directory)).mode & 0o077).toBe(0);
  const manifest = await readFile(`${directory}/manifest.json`);
  expect(createHash("sha256").update(manifest).digest("hex")).toBe(summary.manifestSha256);
  expect((await lstat(`${directory}/manifest.json`)).mode & 0o077).toBe(0);
  // Deliberately do not delete the package: it is the actual independent recovery input.
  expect(JSON.stringify(summary)).not.toMatch(
    /example\.test|sessionToken|connectionString|AccountKey|encryptionKey/,
  );
}, 120_000);

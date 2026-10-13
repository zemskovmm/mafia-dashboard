import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { spawnSync } from "node:child_process";
import { parseBackupArgs, parseRestoreArgs } from "./storage-backup.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const archive = resolve(root, ".AI/storage-backups/example");
const target = "00000000-0000-4000-8000-000000000002";

test("local capture and maintenance commands require an explicit bounded operation", () => {
  assert.deepEqual(parseBackupArgs(["--local", "--output", archive]), {
    operation: "capture",
    directory: archive,
  });
  assert.deepEqual(parseBackupArgs(["--local", "--status"]), { operation: "status" });
  assert.deepEqual(parseBackupArgs(["--local", "--release-freeze", target]), {
    operation: "release",
    owner: target,
  });
  assert.deepEqual(parseBackupArgs(["--local", "--collect"]), {
    operation: "collect",
    protectedDirectories: [],
  });
  assert.deepEqual(parseBackupArgs(["--local", "--collect", "--protect", archive]), {
    operation: "collect",
    protectedDirectories: [archive],
  });
  for (const args of [
    [],
    ["--output", archive],
    ["--local"],
    ["--local", "--status", "--collect"],
    ["--local", "--release-freeze", "other"],
    ["--local", "--collect", "--account", "remote"],
    ["--local", "--local", "--status"],
  ]) {
    assert.throws(() => parseBackupArgs(args));
  }
});

test("restore requires a separate explicit namespace and project-local package", () => {
  assert.deepEqual(parseRestoreArgs(["--local", "--input", archive, "--target", target]), {
    directory: archive,
    targetId: target,
    tableName: "MafiaRestore00000000000040008000000000000002",
    containerName: "mafia-restore-00000000000040008000000000000002",
  });
  for (const args of [
    ["--local", "--input", archive],
    ["--input", archive, "--target", target],
    ["--local", "--input", archive, "--target", "mafia-dev"],
    ["--local", "--input", archive, "--target", target, "--force"],
  ]) {
    assert.throws(() => parseRestoreArgs(args));
  }
  for (const path of [
    root,
    "/tmp/package",
    resolve(root, ".AI/storage-backups/../other"),
    resolve(root, ".AI/storage-backups"),
  ]) {
    assert.throws(() => parseBackupArgs(["--local", "--output", path]));
    assert.throws(() => parseRestoreArgs(["--local", "--input", path, "--target", target]));
  }
});

test("invalid CLI input refuses before emulator startup and never echoes inherited secrets", () => {
  for (const file of ["storage-backup.mjs", "storage-restore.mjs", "verify-storage-backup.mjs"]) {
    const child = spawnSync(
      process.execPath,
      [resolve(root, "scripts", file), "--account", "remote"],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          AZURE_STORAGE_CONNECTION_STRING: "synthetic-secret-sentinel",
        },
      },
    );
    assert.equal(child.status, 1);
    assert.doesNotMatch(
      child.stdout + child.stderr,
      /synthetic-secret-sentinel|AccountKey=|SharedKey/,
    );
    assert.match(child.stderr, /Usage:/);
  }
});

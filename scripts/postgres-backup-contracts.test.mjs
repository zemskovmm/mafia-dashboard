/* global URL */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectories = [];

test("the real backup drill seeds current canonical game data", async () => {
  const drill = await readFile(join(root, "scripts/verify-postgres-backup.mjs"), "utf8");
  const hasCurrentCanonicalFixture =
    !/deadbeef|speech\.started/.test(drill) &&
    /createGame\(/.test(drill) &&
    /createGameLogEntry/.test(drill) &&
    /replayGameLog/.test(drill) &&
    /legacyLog: \[\]/.test(drill);
  assert.equal(hasCurrentCanonicalFixture, true);
});

const fakePostgresTool = `#!/bin/sh
set -eu
tool=\${0##*/}
printf '%s %s\\n' "$tool" "$*" >> "$FAKE_PG_LOG"
if [ "\${1:-}" = "--version" ]; then
  printf '%s (PostgreSQL) %s%s\\n' "$tool" "\${FAKE_CLIENT_VERSION:-17.9}" "\${FAKE_VERSION_SUFFIX:-}"
  exit 0
fi
case "$tool" in
  psql)
    case "$*" in
      *server_version_num*) printf '%s\\n' "\${FAKE_SERVER_VERSION_NUM:-170009}" ;;
      *current_database*) printf '%s\\n' "\${FAKE_CURRENT_DATABASE:-mafia}" ;;
      *pg_database*) [ "\${FAKE_TARGET_EXISTS:-0}" = 1 ] && printf '1\\n' || true ;;
      *) printf '%s\\n' "\${FAKE_PSQL_OUTPUT:-}" ;;
    esac
    ;;
  pg_dump)
    [ "\${FAKE_DUMP_FAIL:-0}" = 0 ] || exit 23
    destination=
    for argument do
      case "$argument" in --file=*) destination=\${argument#--file=} ;; esac
    done
    [ -n "$destination" ] || exit 24
    printf 'fake custom archive\\n' > "$destination"
    ;;
  pg_restore)
    case " $* " in
      *' --list '*) [ "\${FAKE_ARCHIVE_INVALID:-0}" = 0 ] || exit 25 ;;
      *) [ "\${FAKE_RESTORE_FAIL:-0}" = 0 ] || exit 28 ;;
    esac
    ;;
  createdb)
    [ "\${FAKE_CREATEDB_FAIL:-0}" = 0 ] || exit 26
    ;;
  dropdb)
    [ "\${FAKE_DROPDB_FAIL:-0}" = 0 ] || exit 27
    ;;
esac
`;

const createHarness = async () => {
  const directory = await mkdtemp(join(tmpdir(), "mafia-backup-contract-"));
  temporaryDirectories.push(directory);
  const tools = join(directory, "tools");
  const backups = join(directory, "backups");
  const log = join(directory, "postgres-tools.log");
  await Promise.all([mkdir(tools), mkdir(backups), writeFile(log, "")]);
  for (const tool of ["psql", "pg_dump", "pg_restore", "createdb", "dropdb"]) {
    const path = join(tools, tool);
    await writeFile(path, fakePostgresTool);
    await chmod(path, 0o700);
  }
  return {
    backups,
    directory,
    log,
    tools,
    run(script, extraEnvironment = {}, args = []) {
      return spawnSync(join(root, "scripts", script), args, {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          BACKUP_DIR: backups,
          BACKUP_FAILURE_HOOK: "",
          BACKUP_OFFSITE_DIR: "",
          BACKUP_OFFSITE_RETENTION_DAYS: "30",
          BACKUP_PREFIX: "mafia-dashboard",
          BACKUP_RETENTION_DAYS: "14",
          FAKE_PG_LOG: log,
          PATH: `${tools}:${process.env.PATH}`,
          PGDATABASE: "mafia",
          PG_TOOL_DIR: tools,
          ...extraEnvironment,
        },
      });
    },
  };
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("repository exposes gated PostgreSQL 17 backup operations", async () => {
  const [compose, packageSource] = await Promise.all([
    readFile(join(root, "compose.postgres-tools.yaml"), "utf8"),
    readFile(join(root, "package.json"), "utf8"),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(compose, /image: postgres:17-alpine/);
  assert.match(compose, /profiles: \[postgres-tools\]/);
  assert.match(compose, /\.\/scripts:\/opt\/mafia\/scripts:ro/);
  assert.match(compose, /BACKUP_LOCAL_DIR.*:\/backups\/local/);
  assert.match(compose, /BACKUP_OFFSITE_DIR.*:\/backups\/offsite/);
  assert.match(compose, /condition: service_healthy/);
  assert.equal(
    packageJson.scripts["test:backup-contracts"],
    "node --test scripts/postgres-backup-contracts.test.mjs",
  );
  assert.equal(packageJson.scripts["verify:backup"], "node scripts/verify-postgres-backup.mjs");
  assert.match(packageJson.scripts.test, /test:backup-contracts/);
});

test("real backup drill seeds a schema-valid terminal result", async () => {
  const verifier = await readFile(join(root, "scripts/verify-postgres-backup.mjs"), "utf8");
  const hasTerminalProjection =
    /INSERT INTO game_results\s+\(game_id, club_id, outcome, winner, reason, played_at, host_player_id\)/.test(
      verifier,
    ) &&
    /outcome: "red"/.test(verifier) &&
    /winner: "red"/.test(verifier);
  assert.equal(hasTerminalProjection, true);
});

test("backup publishes one private validated timestamped archive", async () => {
  const harness = await createHarness();

  const result = harness.run("postgres-backup.sh");

  assert.equal(result.status, 0, result.stderr ?? result.error?.message ?? "backup failed");
  const entries = await readdir(harness.backups);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^mafia-dashboard-\d{8}T\d{6}Z\.dump$/);
  const archive = join(harness.backups, entries[0]);
  assert.equal(await readFile(archive, "utf8"), "fake custom archive\n");
  assert.equal((await stat(archive)).mode & 0o777, 0o600);
  const log = await readFile(harness.log, "utf8");
  assert.match(log, /^pg_dump --no-password --format=custom/m);
  assert.match(log, /^pg_restore --list /m);
});

test("backup publication lock refuses a timestamp collision without disturbing its owner", async () => {
  const harness = await createHarness();
  const timestamp = "20260901T120000Z";
  const fakeDate = join(harness.tools, "date");
  const lockName = `mafia-dashboard-${timestamp}.dump.lock`;
  await writeFile(fakeDate, `#!/bin/sh\nprintf '${timestamp}\\n'\n`);
  await chmod(fakeDate, 0o700);
  await mkdir(join(harness.backups, lockName));

  const result = harness.run("postgres-backup.sh");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /publication is already in progress/);
  assert.deepEqual(await readdir(harness.backups), [lockName]);
  assert.doesNotMatch(await readFile(harness.log, "utf8"), /^pg_dump .*--format=custom/m);
});

test("PostgreSQL tool versions accept Homebrew and distribution suffixes", async () => {
  for (const suffix of [" (Homebrew)", " (Ubuntu 17.10-1.pgdg24.04+1)"]) {
    const harness = await createHarness();

    const result = harness.run("postgres-backup.sh", {
      FAKE_CLIENT_VERSION: "17.10",
      FAKE_VERSION_SUFFIX: suffix,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readdir(harness.backups)).length, 1);
  }
});

test("dump and archive-validation failures publish nothing", async () => {
  for (const environment of [{ FAKE_DUMP_FAIL: "1" }, { FAKE_ARCHIVE_INVALID: "1" }]) {
    const harness = await createHarness();

    const result = harness.run("postgres-backup.sh", environment);

    assert.notEqual(result.status, 0);
    assert.deepEqual(await readdir(harness.backups), []);
  }
});

test("backup failure preserves retained archives and invokes a redacted alert hook", async () => {
  const harness = await createHarness();
  const retainedArchive = join(harness.backups, "mafia-dashboard-20000101T000000Z.dump");
  const hookLog = join(harness.directory, "hook.log");
  const hook = join(harness.directory, "failure-hook.sh");
  await writeFile(retainedArchive, "retained\n");
  const old = new Date("2000-01-01T00:00:00Z");
  await utimes(retainedArchive, old, old);
  await writeFile(hook, `#!/bin/sh\nprintf '%s|%s\\n' "$1" "$2" > "${hookLog}"\n`);
  await chmod(hook, 0o700);

  const result = harness.run("postgres-backup.sh", {
    BACKUP_FAILURE_HOOK: hook,
    BACKUP_RETENTION_DAYS: "0",
    FAKE_DUMP_FAIL: "1",
  });

  assert.notEqual(result.status, 0);
  assert.deepEqual(await readdir(harness.backups), ["mafia-dashboard-20000101T000000Z.dump"]);
  assert.equal(await readFile(hookLog, "utf8"), "dump|23\n");
});

test("version mismatch fails before pg_dump creates an artifact", async () => {
  const harness = await createHarness();

  const result = harness.run("postgres-backup.sh", { FAKE_CLIENT_VERSION: "16.8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match required PostgreSQL major 17/);
  assert.deepEqual(await readdir(harness.backups), []);
  assert.doesNotMatch(await readFile(harness.log, "utf8"), /^pg_dump .*--format=custom/m);
});

test("server major mismatch fails before pg_dump creates an artifact", async () => {
  const harness = await createHarness();

  const result = harness.run("postgres-backup.sh", { FAKE_SERVER_VERSION_NUM: "160000" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /server major 16 does not match required PostgreSQL major 17/);
  assert.deepEqual(await readdir(harness.backups), []);
  assert.doesNotMatch(await readFile(harness.log, "utf8"), /^pg_dump .*--format=custom/m);
});

test("off-server copy failure preserves the validated local archive", async () => {
  const harness = await createHarness();
  const offsite = join(harness.directory, "offsite");
  await mkdir(offsite);
  const failingCopy = join(harness.tools, "cp");
  await writeFile(failingCopy, "#!/bin/sh\nexit 29\n");
  await chmod(failingCopy, 0o700);

  const result = harness.run("postgres-backup.sh", { BACKUP_OFFSITE_DIR: offsite });

  assert.notEqual(result.status, 0);
  assert.equal((await readdir(harness.backups)).length, 1);
  assert.deepEqual(await readdir(offsite), []);
});

test("successful off-server copy precedes narrowly scoped independent retention", async () => {
  const harness = await createHarness();
  const offsite = join(harness.directory, "offsite");
  await mkdir(offsite);
  const localOld = join(harness.backups, "mafia-dashboard-20000101T000000Z.dump");
  const offsiteOld = join(offsite, "mafia-dashboard-20000101T000000Z.dump");
  const unrelated = join(offsite, "another-product-20000101T000000Z.dump");
  await Promise.all([
    writeFile(localOld, "old"),
    writeFile(offsiteOld, "old"),
    writeFile(unrelated, "keep"),
  ]);
  const old = new Date("2000-01-01T00:00:00Z");
  await Promise.all([
    utimes(localOld, old, old),
    utimes(offsiteOld, old, old),
    utimes(unrelated, old, old),
  ]);

  const result = harness.run("postgres-backup.sh", {
    BACKUP_OFFSITE_DIR: offsite,
    BACKUP_OFFSITE_RETENTION_DAYS: "0",
    BACKUP_RETENTION_DAYS: "0",
  });

  assert.equal(result.status, 0, result.stderr);
  const localEntries = await readdir(harness.backups);
  const offsiteEntries = await readdir(offsite);
  assert.equal(localEntries.length, 1);
  assert.deepEqual(
    offsiteEntries.sort(),
    ["another-product-20000101T000000Z.dump", localEntries[0]].sort(),
  );
  assert.equal(
    await readFile(join(harness.backups, localEntries[0]), "utf8"),
    await readFile(join(offsite, localEntries[0]), "utf8"),
  );
});

test("restore refuses the source database and existing targets before creation", async () => {
  const harness = await createHarness();
  const archive = join(harness.directory, "valid.dump");
  await writeFile(archive, "fake custom archive\n");

  const sourceResult = harness.run("postgres-restore.sh", {}, [archive, "mafia"]);
  assert.notEqual(sourceResult.status, 0);
  assert.match(sourceResult.stderr ?? sourceResult.error?.message ?? "", /source database/i);

  const existingResult = harness.run("postgres-restore.sh", { FAKE_TARGET_EXISTS: "1" }, [
    archive,
    "mafia_restore",
  ]);
  assert.notEqual(existingResult.status, 0);
  assert.match(existingResult.stderr ?? existingResult.error?.message ?? "", /already exists/i);

  const log = await readFile(harness.log, "utf8");
  assert.doesNotMatch(log, /^createdb --no-password --template=/m);
});

test("restore creates a fresh target and uses fail-closed archive options", async () => {
  const harness = await createHarness();
  const archive = join(harness.directory, "valid.dump");
  await writeFile(archive, "fake custom archive\n");

  const result = harness.run("postgres-restore.sh", {}, [archive, "mafia_restore"]);

  assert.equal(result.status, 0, result.stderr ?? result.error?.message ?? "restore failed");
  const log = await readFile(harness.log, "utf8");
  assert.match(log, /^pg_restore --list /m);
  assert.match(log, /^createdb --no-password --template=template0 mafia_restore$/m);
  assert.match(
    log,
    /^pg_restore --no-password --exit-on-error --single-transaction --no-owner --no-privileges --dbname=mafia_restore /m,
  );
  assert.match(log, /^psql .*--dbname=mafia_restore .*ANALYZE/m);
});

test("generic restore preserves a failed target unless cleanup is explicitly requested", async () => {
  const harness = await createHarness();
  const archive = join(harness.directory, "valid.dump");
  await writeFile(archive, "fake custom archive\n");

  const result = harness.run("postgres-restore.sh", { FAKE_RESTORE_FAIL: "1" }, [
    archive,
    "mafia_restore",
  ]);

  assert.notEqual(result.status, 0);
  const log = await readFile(harness.log, "utf8");
  assert.match(log, /^createdb --no-password --template=template0 mafia_restore$/m);
  assert.doesNotMatch(log, /^dropdb --no-password --if-exists --force mafia_restore$/m);
});

test("restore test never drops a pre-existing colliding target", async () => {
  const harness = await createHarness();
  const archive = join(harness.directory, "valid.dump");
  await writeFile(archive, "fake custom archive\n");

  const result = harness.run("postgres-restore-test.sh", { FAKE_TARGET_EXISTS: "1" }, [archive]);

  assert.notEqual(result.status, 0);
  const log = await readFile(harness.log, "utf8");
  assert.doesNotMatch(log, /^createdb --no-password --template=/m);
  assert.doesNotMatch(log, /^dropdb --no-password --if-exists --force /m);
});

test("restore test drops only a target it created when restore fails", async () => {
  const harness = await createHarness();
  const archive = join(harness.directory, "valid.dump");
  await writeFile(archive, "fake custom archive\n");

  const result = harness.run("postgres-restore-test.sh", { FAKE_RESTORE_FAIL: "1" }, [archive]);

  assert.notEqual(result.status, 0);
  const log = await readFile(harness.log, "utf8");
  const created = log.match(
    /^createdb --no-password --template=template0 (mafia_restore_test_[a-z0-9_]+)$/m,
  );
  assert.ok(created, log);
  assert.match(log, new RegExp(`^dropdb --no-password --if-exists --force ${created[1]}$`, "m"));
});

test("restore test validates a representative game and drops its isolated database", async () => {
  const harness = await createHarness();
  const archive = join(harness.directory, "valid.dump");
  const gameId = "00000000-0000-4000-8000-000000000901";
  await writeFile(archive, "fake custom archive\n");

  const result = harness.run(
    "postgres-restore-test.sh",
    {
      FAKE_PSQL_OUTPUT: `${gameId}|active|7|2|11|0`,
      RESTORE_TEST_GAME_ID: gameId,
    },
    [archive],
  );

  assert.equal(result.status, 0, result.stderr ?? result.error?.message ?? "restore test failed");
  assert.match(result.stdout, /restore_test_status=ok/);
  assert.match(result.stdout, new RegExp(`game_id=${gameId}`));
  const log = await readFile(harness.log, "utf8");
  const created = log.match(
    /^createdb --no-password --template=template0 (mafia_restore_test_[a-z0-9_]+)$/m,
  );
  assert.ok(created, log);
  assert.match(log, new RegExp(`^dropdb --no-password --if-exists --force ${created[1]}$`, "m"));
});

test("restore test cleans its isolated database when semantic validation fails", async () => {
  const harness = await createHarness();
  const archive = join(harness.directory, "valid.dump");
  await writeFile(archive, "fake custom archive\n");

  const result = harness.run(
    "postgres-restore-test.sh",
    { RESTORE_TEST_GAME_ID: "00000000-0000-4000-8000-000000000901" },
    [archive],
  );

  assert.notEqual(result.status, 0);
  const log = await readFile(harness.log, "utf8");
  const created = log.match(
    /^createdb --no-password --template=template0 (mafia_restore_test_[a-z0-9_]+)$/m,
  );
  assert.ok(created, log);
  assert.match(log, new RegExp(`^dropdb --no-password --if-exists --force ${created[1]}$`, "m"));
});

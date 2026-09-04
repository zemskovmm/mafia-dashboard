/* global URL */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const scriptsDirectory = join(root, "scripts");
const schema = readFileSync(join(root, "apps/server/src/schema.sql"));
const temporaryRoot = mkdtempSync(join(tmpdir(), "mafia-postgres-drill-"));
const drillDirectory = join(temporaryRoot, "drill");
const backupDirectory = join(drillDirectory, "backups");
const offsiteDirectory = join(drillDirectory, "offsite");
const environmentFile = join(temporaryRoot, "container.env");
const container = `mafia-postgres-drill-${process.pid}-${randomUUID().slice(0, 8)}`;
const databaseUser = "mafia";
const databaseName = "mafia";
const gameId = "00000000-0000-4000-8000-000000000901";
const playerId = "00000000-0000-4000-8000-000000000902";
const clubId = "00000000-0000-4000-8000-000000000101";
const eventOne = "00000000-0000-4000-8000-000000000903";
const eventTwo = "00000000-0000-4000-8000-000000000904";
const evidence = [];

mkdirSync(backupDirectory, { recursive: true });
mkdirSync(offsiteDirectory);
writeFileSync(
  environmentFile,
  `POSTGRES_USER=${databaseUser}\nPOSTGRES_DB=${databaseName}\nPOSTGRES_PASSWORD=${randomUUID()}\n`,
  { mode: 0o600 },
);
chmodSync(environmentFile, 0o600);

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status ?? result.error?.message ?? "unknown"}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
};

const runDocker = (args, options) => run("docker", args, options);
const runInDatabase = (args, options = {}) =>
  runDocker(
    [
      "exec",
      "-e",
      "PGHOST=/var/run/postgresql",
      "-e",
      `PGUSER=${databaseUser}`,
      "-e",
      `PGDATABASE=${databaseName}`,
      ...args,
    ],
    options,
  );

const waitForDatabase = async () => {
  let consecutiveReadyChecks = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync("docker", [
      "exec",
      container,
      "pg_isready",
      "-U",
      databaseUser,
      "-d",
      databaseName,
    ]);
    if (result.status === 0) {
      consecutiveReadyChecks += 1;
      if (consecutiveReadyChecks === 3) return;
    } else {
      consecutiveReadyChecks = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("PostgreSQL drill container did not become ready");
};

let failure;
try {
  runDocker([
    "run",
    "--detach",
    "--name",
    container,
    "--env-file",
    environmentFile,
    "--volume",
    `${scriptsDirectory}:/opt/mafia/scripts:ro`,
    "--volume",
    `${drillDirectory}:/drill`,
    "postgres:17-alpine",
  ]);
  await waitForDatabase();

  runInDatabase(["-i", container, "psql", "-X", "-v", "ON_ERROR_STOP=1"], { input: schema });
  const seed = `
    INSERT INTO players (id, club_id, nickname)
    VALUES ('${playerId}', '${clubId}', 'Backup drill player');

    INSERT INTO game_sessions
      (id, club_id, name, revision, last_mutation_id, state, results, status, initial_game, head_event_id)
    VALUES (
      '${gameId}',
      '${clubId}',
      'Backup drill game',
      7,
      '00000000-0000-4000-8000-000000000905',
      '{"game":{"players":[{"id":"${playerId}","seat":1,"role":"citizen"}]}}'::jsonb,
      '{"winner":"red"}'::jsonb,
      'completed',
      '{}'::jsonb,
      '${eventTwo}'
    );

    INSERT INTO game_events
      (id, club_id, game_id, sequence, idempotency_key, event_type, phase, payload,
       parent_event_id, replay_sequence, phase_after, day_before, day_after, state_hash_after)
    VALUES
      ('${eventOne}', '${clubId}', '${gameId}', 1, 'backup-drill-1', 'game.started', 'day', '{}'::jsonb,
       NULL, 1, 'day', 0, 0, 'deadbeef'),
      ('${eventTwo}', '${clubId}', '${gameId}', 2, 'backup-drill-2', 'speech.started', 'day', '{}'::jsonb,
       '${eventOne}', 2, 'day', 0, 0, 'deadbeef');

    INSERT INTO game_session_players (club_id, game_id, player_id, seat, is_host, role)
    VALUES ('${clubId}', '${gameId}', '${playerId}', 1, FALSE, 'citizen');

    INSERT INTO game_results (game_id, club_id, outcome, winner, played_at)
    VALUES ('${gameId}', '${clubId}', 'red', 'red', '2026-09-01T00:00:00Z');

    INSERT INTO game_player_results
      (club_id, game_id, player_id, seat, role, team, final_status, fouls, won)
    VALUES (
      '${clubId}', '${gameId}', '${playerId}', 1, 'citizen', 'red', 'active', 0, TRUE
    );
  `;
  runInDatabase(["-i", container, "psql", "-X", "-v", "ON_ERROR_STOP=1"], { input: seed });

  const clientVersion = runDocker(["exec", container, "pg_dump", "--version"]);
  const serverVersion = runInDatabase([
    container,
    "psql",
    "-XAtv",
    "ON_ERROR_STOP=1",
    "-c",
    "SHOW server_version",
  ]);
  evidence.push(`postgres_client=${clientVersion}`);
  evidence.push(`postgres_server=${serverVersion}`);

  runInDatabase([
    "-e",
    "BACKUP_DIR=/drill/backups",
    "-e",
    "BACKUP_OFFSITE_DIR=/drill/offsite",
    "-e",
    "BACKUP_RETENTION_DAYS=14",
    "-e",
    "BACKUP_OFFSITE_RETENTION_DAYS=30",
    container,
    "/opt/mafia/scripts/postgres-backup.sh",
  ]);

  const archives = readdirSync(backupDirectory).filter((name) => name.endsWith(".dump"));
  assert.equal(archives.length, 1, "backup drill must publish exactly one local archive");
  const archiveName = archives[0];
  const localArchive = join(backupDirectory, archiveName);
  const offsiteArchive = join(offsiteDirectory, archiveName);
  assert.deepEqual(readFileSync(localArchive), readFileSync(offsiteArchive));
  evidence.push(`archive=${archiveName}`);
  evidence.push(`archive_bytes=${statSync(localArchive).size}`);
  evidence.push("offsite_copy=byte_verified");

  const restoreTestOutput = runInDatabase([
    "-e",
    `RESTORE_TEST_GAME_ID=${gameId}`,
    "-e",
    `RESTORE_TEST_CLUB_ID=${clubId}`,
    container,
    "/opt/mafia/scripts/postgres-restore-test.sh",
    `/drill/backups/${archiveName}`,
  ]);
  assert.match(restoreTestOutput, /restore_test_status=ok/);
  assert.match(restoreTestOutput, /game_status=completed/);
  assert.match(restoreTestOutput, /canonical_event_count=2/);
  assert.match(restoreTestOutput, /participant_count=1/);
  assert.match(restoreTestOutput, /result_count=1/);
  evidence.push("isolated_restore_test=semantic_checks_passed");

  const independentTarget = "mafia_restore_verify";
  try {
    runInDatabase([
      container,
      "/opt/mafia/scripts/postgres-restore.sh",
      `/drill/backups/${archiveName}`,
      independentTarget,
    ]);
    const semanticCheck = runInDatabase([
      container,
      "psql",
      "-XAtv",
      "ON_ERROR_STOP=1",
      `--dbname=${independentTarget}`,
      "-c",
      `SELECT CONCAT_WS('|', session.id, session.revision,
          (SELECT COUNT(*) FROM game_events AS event
            WHERE event.club_id = session.club_id AND event.game_id = session.id),
          (SELECT COUNT(*) FROM game_session_players AS player
            WHERE player.club_id = session.club_id AND player.game_id = session.id),
          result.winner, player_result.player_id, player_result.seat, player_result.role,
          player_result.team, player_result.final_status, player_result.fouls, player_result.won)
         FROM game_sessions AS session
         JOIN game_results AS result
           ON result.club_id = session.club_id AND result.game_id = session.id
         JOIN game_player_results AS player_result
           ON player_result.club_id = session.club_id AND player_result.game_id = session.id
        WHERE session.club_id = '${clubId}' AND session.id = '${gameId}'`,
    ]);
    assert.equal(semanticCheck, `${gameId}|7|2|1|red|${playerId}|1|citizen|red|active|0|t`);
    const [restoredGameId, restoredRevision, restoredEvents, restoredParticipants, restoredWinner] =
      semanticCheck.split("|");
    evidence.push(
      `representative_game=${restoredGameId} revision=${restoredRevision} canonical_events=${restoredEvents} participants=${restoredParticipants} winner=${restoredWinner} result_rows=1`,
    );
  } finally {
    runInDatabase([container, "dropdb", "--if-exists", "--force", independentTarget]);
  }

  const leakedTestDatabases = runInDatabase([
    container,
    "psql",
    "-XAtv",
    "ON_ERROR_STOP=1",
    "-c",
    "SELECT COUNT(*) FROM pg_database WHERE datname LIKE 'mafia_restore_test_%'",
  ]);
  assert.equal(leakedTestDatabases, "0");
  evidence.push("isolated_database_cleanup=verified");

  runInDatabase([
    container,
    "psql",
    "-Xv",
    "ON_ERROR_STOP=1",
    "-c",
    `UPDATE game_events
        SET parent_event_id = '${eventTwo}'
      WHERE club_id = '${clubId}' AND game_id = '${gameId}' AND id = '${eventOne}'`,
  ]);
  runInDatabase([
    "-e",
    "BACKUP_DIR=/drill/backups",
    "-e",
    "BACKUP_PREFIX=mafia-invalid-chain",
    container,
    "/opt/mafia/scripts/postgres-backup.sh",
  ]);
  const invalidArchive = readdirSync(backupDirectory).find((name) =>
    name.startsWith("mafia-invalid-chain-"),
  );
  assert.ok(invalidArchive, "invalid-chain fixture backup must be published");
  const invalidRestoreTest = spawnSync(
    "docker",
    [
      "exec",
      "-e",
      "PGHOST=/var/run/postgresql",
      "-e",
      `PGUSER=${databaseUser}`,
      "-e",
      `PGDATABASE=${databaseName}`,
      "-e",
      `RESTORE_TEST_GAME_ID=${gameId}`,
      "-e",
      `RESTORE_TEST_CLUB_ID=${clubId}`,
      container,
      "/opt/mafia/scripts/postgres-restore-test.sh",
      `/drill/backups/${invalidArchive}`,
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(invalidRestoreTest.status, 0);
  assert.match(invalidRestoreTest.stderr, /no valid representative game/);
  assert.equal(
    runInDatabase([
      container,
      "psql",
      "-XAtv",
      "ON_ERROR_STOP=1",
      "-c",
      "SELECT COUNT(*) FROM pg_database WHERE datname LIKE 'mafia_restore_test_%'",
    ]),
    "0",
  );
  evidence.push("semantic_failure_path=invalid_parent_chain_rejected");

  const failedBackup = spawnSync(
    "docker",
    [
      "exec",
      "-e",
      "PGHOST=/var/run/postgresql",
      "-e",
      `PGUSER=${databaseUser}`,
      "-e",
      "PGDATABASE=missing_backup_drill",
      "-e",
      "BACKUP_DIR=/drill/backups",
      "-e",
      "BACKUP_PREFIX=mafia-drill-failure",
      container,
      "/opt/mafia/scripts/postgres-backup.sh",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(failedBackup.status, 0);
  assert.equal(
    readdirSync(backupDirectory).filter((name) => name.startsWith("mafia-drill-failure-")).length,
    0,
  );
  evidence.push("failure_path=no_finalized_artifact");
} catch (error) {
  failure = error;
} finally {
  const removeContainer = spawnSync("docker", ["rm", "--force", "--volumes", container], {
    encoding: "utf8",
  });
  const inspectContainer = spawnSync("docker", ["inspect", container], { encoding: "utf8" });
  if (inspectContainer.status === 0 && failure === undefined) {
    failure = new Error(
      `drill container cleanup failed (${removeContainer.status ?? "unknown"}): ${removeContainer.stderr || removeContainer.stdout}`,
    );
  }
  try {
    rmSync(temporaryRoot, { recursive: true, force: true });
  } catch (error) {
    if (failure === undefined) failure = error;
  }
}

if (failure) throw failure;
evidence.push("cleanup=container_and_temporary_files_removed");
for (const line of evidence) console.log(line);
console.log("backup_restore_drill=ok");

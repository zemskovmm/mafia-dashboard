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

run("npm", ["run", "build", "-w", "@mafia/game-domain"], { cwd: root });
const {
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createGameLogEntry,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  replayGameLog,
} = await import("@mafia/game-domain");

const databaseUser = "mafia";
const databaseName = "mafia";
const gameId = "00000000-0000-4000-8000-000000000901";
const hostPlayerId = "00000000-0000-4000-8000-000000000902";
const clubId = "00000000-0000-4000-8000-000000000101";
const eventOne = "00000000-0000-4000-8000-000000000903";
const eventTwo = "00000000-0000-4000-8000-000000000904";
const mutationId = "00000000-0000-4000-8000-000000000905";
const playerIds = Array.from(
  { length: 10 },
  (_, index) => `00000000-0000-4000-8000-${String(index + 910).padStart(12, "0")}`,
);
let roleDraw = beginRoleDraw(
  createSetup(
    playerIds.map((id, index) => ({
      id,
      name: `Backup drill player ${String(index + 1).padStart(2, "0")}`,
      seat: index + 1,
    })),
  ),
  createSeededRandom(52),
);
for (let seat = 1; seat <= 10; seat += 1) roleDraw = drawRoleForSeat(roleDraw, seat);
const seededGame = createGame(completeRoleDraw(roleDraw));
const terminalGame = {
  ...seededGame,
  day: 1,
  phase: "finished",
  players: seededGame.players.map((player) =>
    player.team === "black" ? { ...player, status: "eliminated" } : player,
  ),
  winner: "red",
};
const initialGame = { replayVersion: 1, game: terminalGame };
const checkpoint = createGameLogEntry({
  gameId,
  id: eventOne,
  sequence: 1,
  parentEventId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  before: initialGame.game,
  draft: { type: "game.checkpointed", payload: {} },
});
const completion = createGameLogEntry({
  gameId,
  id: eventTwo,
  sequence: 2,
  parentEventId: checkpoint.entry.id,
  createdAt: "2026-09-01T00:00:00.000Z",
  before: checkpoint.after,
  draft: { type: "game.completed", payload: { winner: "red" } },
});
const canonicalEvents = [checkpoint.entry, completion.entry];
assert.match(completion.entry.stateHashAfter, /^sha256:[0-9a-f]{64}$/);
assert.deepEqual(replayGameLog(initialGame, canonicalEvents, gameId).game, completion.after);

const results = {
  hostPlayerId,
  outcome: "red",
  winner: "red",
  reason: null,
  playedAt: completion.entry.createdAt,
  players: completion.after.players.map((player) => ({
    playerId: player.id,
    seat: player.seat,
    role: player.role,
    team: player.team,
    status: player.status,
    fouls: player.fouls,
    bestMoveHits: null,
  })),
};
const state = {
  setup: null,
  game: completion.after,
  hostPlayerId,
  hostName: "Backup drill host",
  playlistId: "",
  log: [],
  initialGame,
  events: canonicalEvents,
  headEventId: completion.entry.id,
  resetReturnEventId: null,
  legacyLog: [],
  undoHistory: [],
  undoBudget: 0,
};
const temporaryRoot = mkdtempSync(join(tmpdir(), "mafia-postgres-drill-"));
const drillDirectory = join(temporaryRoot, "drill");
const backupDirectory = join(drillDirectory, "backups");
const offsiteDirectory = join(drillDirectory, "offsite");
const environmentFile = join(temporaryRoot, "container.env");
const container = `mafia-postgres-drill-${process.pid}-${randomUUID().slice(0, 8)}`;
const evidence = [];

mkdirSync(backupDirectory, { recursive: true });
mkdirSync(offsiteDirectory);
writeFileSync(
  environmentFile,
  `POSTGRES_USER=${databaseUser}\nPOSTGRES_DB=${databaseName}\nPOSTGRES_PASSWORD=${randomUUID()}\n`,
  { mode: 0o600 },
);
chmodSync(environmentFile, 0o600);

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
  const playerRows = [
    `('${hostPlayerId}', '${clubId}', 'Backup drill host')`,
    ...completion.after.players.map((player) => `('${player.id}', '${clubId}', '${player.name}')`),
  ].join(",\n      ");
  const eventRows = canonicalEvents
    .map(
      (entry) => `('${entry.id}', '${clubId}', '${gameId}', ${entry.sequence},
        'backup-drill-${entry.sequence}', '${entry.type}', '${entry.phaseBefore}',
        '${JSON.stringify(entry.payload)}'::jsonb, ${entry.parentEventId === null ? "NULL" : `'${entry.parentEventId}'`},
        ${entry.replayVersion}, ${entry.sequence}, '${entry.phaseAfter}', ${entry.dayBefore},
        ${entry.dayAfter}, '${entry.stateHashAfter}', '${entry.createdAt}')`,
    )
    .join(",\n      ");
  const sessionPlayerRows = [
    `('${clubId}', '${gameId}', '${hostPlayerId}', NULL, TRUE, NULL)`,
    ...completion.after.players.map(
      (player) =>
        `('${clubId}', '${gameId}', '${player.id}', ${player.seat}, FALSE, '${player.role}')`,
    ),
  ].join(",\n      ");
  const playerResultRows = results.players
    .map(
      (player) =>
        `('${clubId}', '${gameId}', '${player.playerId}', ${player.seat}, '${player.role}',
          '${player.team}', '${player.status}', ${player.fouls}, ${player.team === "red"}, NULL)`,
    )
    .join(",\n      ");
  const seed = `
    INSERT INTO players (id, club_id, nickname)
    VALUES ${playerRows};

    INSERT INTO game_sessions
      (id, club_id, ruleset_id, ruleset_version, name, revision, last_mutation_id, state, results,
       status, initial_game, replay_base_event_id, head_event_id, reset_return_event_id,
       reset_return_was_completed, replay_version)
    VALUES (
      '${gameId}', '${clubId}', 'club-mafia', 1, 'Backup drill game', 7, '${mutationId}',
      '${JSON.stringify(state)}'::jsonb, '${JSON.stringify(results)}'::jsonb, 'completed',
      '${JSON.stringify(initialGame)}'::jsonb, NULL, '${completion.entry.id}', NULL, FALSE, 1
    );

    INSERT INTO game_events
      (id, club_id, game_id, sequence, idempotency_key, event_type, phase, payload,
       parent_event_id, replay_version, replay_sequence, phase_after, day_before, day_after,
       state_hash_after, created_at)
    VALUES ${eventRows};

    INSERT INTO game_session_players (club_id, game_id, player_id, seat, is_host, role)
    VALUES ${sessionPlayerRows};

    INSERT INTO game_results
      (game_id, club_id, outcome, winner, reason, played_at, host_player_id)
    VALUES ('${gameId}', '${clubId}', 'red', 'red', NULL, '${results.playedAt}', '${hostPlayerId}');

    INSERT INTO game_player_results
      (club_id, game_id, player_id, seat, role, team, final_status, fouls, won, best_move_hits)
    VALUES ${playerResultRows};
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
  assert.match(restoreTestOutput, /participant_count=11/);
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
    const expectedSnapshot = {
      session: {
        id: gameId,
        clubId,
        rulesetId: "club-mafia",
        rulesetVersion: 1,
        name: "Backup drill game",
        revision: 7,
        lastMutationId: mutationId,
        state,
        results,
        status: "completed",
        initialGame,
        replayBaseEventId: null,
        headEventId: completion.entry.id,
        resetReturnEventId: null,
        resetReturnWasCompleted: false,
        replayVersion: 1,
      },
      events: canonicalEvents.map((entry) => ({
        ...entry,
        idempotencyKey: `backup-drill-${entry.sequence}`,
      })),
      sessionPlayers: [
        { playerId: hostPlayerId, seat: null, isHost: true, role: null },
        ...completion.after.players.map((player) => ({
          playerId: player.id,
          seat: player.seat,
          isHost: false,
          role: player.role,
        })),
      ],
      result: {
        outcome: results.outcome,
        winner: results.winner,
        reason: results.reason,
        playedAt: results.playedAt,
        hostPlayerId,
      },
      playerResults: results.players.map((player) => ({
        ...player,
        won: player.team === "red",
      })),
    };
    const restoredSnapshot = JSON.parse(
      runInDatabase([
        container,
        "psql",
        "-XAtv",
        "ON_ERROR_STOP=1",
        `--dbname=${independentTarget}`,
        "-c",
        `SELECT jsonb_build_object(
          'session', jsonb_build_object(
            'id', session.id,
            'clubId', session.club_id,
            'rulesetId', session.ruleset_id,
            'rulesetVersion', session.ruleset_version,
            'name', session.name,
            'revision', session.revision,
            'lastMutationId', session.last_mutation_id,
            'state', session.state,
            'results', session.results,
            'status', session.status,
            'initialGame', session.initial_game,
            'replayBaseEventId', session.replay_base_event_id,
            'headEventId', session.head_event_id,
            'resetReturnEventId', session.reset_return_event_id,
            'resetReturnWasCompleted', session.reset_return_was_completed,
            'replayVersion', session.replay_version
          ),
          'events', COALESCE((
            SELECT jsonb_agg(
              jsonb_build_object(
                'replayVersion', event.replay_version,
                'id', event.id,
                'gameId', event.game_id,
                'sequence', event.replay_sequence,
                'parentEventId', event.parent_event_id,
                'type', event.event_type,
                'payload', event.payload,
                'phaseBefore', event.phase,
                'phaseAfter', event.phase_after,
                'dayBefore', event.day_before,
                'dayAfter', event.day_after,
                'stateHashAfter', event.state_hash_after,
                'createdAt', to_char(
                  event.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                ),
                'idempotencyKey', event.idempotency_key
              ) ORDER BY event.replay_sequence
            )
            FROM game_events AS event
            WHERE event.club_id = session.club_id AND event.game_id = session.id
          ), '[]'::jsonb),
          'sessionPlayers', COALESCE((
            SELECT jsonb_agg(
              jsonb_build_object(
                'playerId', player.player_id,
                'seat', player.seat,
                'isHost', player.is_host,
                'role', player.role
              ) ORDER BY player.is_host DESC, player.seat
            )
            FROM game_session_players AS player
            WHERE player.club_id = session.club_id AND player.game_id = session.id
          ), '[]'::jsonb),
          'result', jsonb_build_object(
            'outcome', result.outcome,
            'winner', result.winner,
            'reason', result.reason,
            'playedAt', to_char(
              result.played_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ),
            'hostPlayerId', result.host_player_id
          ),
          'playerResults', COALESCE((
            SELECT jsonb_agg(
              jsonb_build_object(
                'playerId', player_result.player_id,
                'seat', player_result.seat,
                'role', player_result.role,
                'team', player_result.team,
                'status', player_result.final_status,
                'fouls', player_result.fouls,
                'bestMoveHits', player_result.best_move_hits,
                'won', player_result.won
              ) ORDER BY player_result.seat
            )
            FROM game_player_results AS player_result
            WHERE player_result.club_id = session.club_id AND player_result.game_id = session.id
          ), '[]'::jsonb)
        )::text
         FROM game_sessions AS session
         JOIN game_results AS result
           ON result.club_id = session.club_id AND result.game_id = session.id
        WHERE session.club_id = '${clubId}' AND session.id = '${gameId}'`,
      ]),
    );
    assert.deepEqual(restoredSnapshot, expectedSnapshot);
    const restoredEvents = restoredSnapshot.events.map((stored) => {
      const event = { ...stored };
      delete event.idempotencyKey;
      return event;
    });
    assert.deepEqual(
      replayGameLog(restoredSnapshot.session.initialGame, restoredEvents, gameId).game,
      restoredSnapshot.session.state.game,
    );
    evidence.push(
      `representative_game=${gameId} revision=7 canonical_events=2 participants=11 seated_players=10 winner=red result_rows=1 player_result_rows=10`,
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

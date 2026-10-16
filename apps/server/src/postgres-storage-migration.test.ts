import { randomUUID, createHash } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  beginRoleDraw,
  createGame,
  createSetup,
  createSeededRandom,
  drawRoleForSeat,
  completeRoleDraw,
  createGameLogEntry,
  replayGameLog,
  type InitialGameBaseline,
  type GameLogEntry,
} from "@mafia/game-domain";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_CLUB_ID, ClubStore } from "./club-store.js";
import { initializeSchema } from "./initialize-schema.js";
import { GameSessionStore } from "./game-session-store.js";
import { PlayerStore } from "./player-store.js";
import { TournamentStore } from "./tournament-store.js";
import { AzureTournamentStore } from "./azure-tournament-store.js";
import { EventStore } from "./event-store.js";
import { AzureGameSessionStore, AzureEventStore } from "./azure-game-session-store.js";
import { AzureAccountStore } from "./azure-account-store.js";
import { AzureClubStore, AzurePlayerStore } from "./azure-club-player-store.js";
import { AzureStorage, blobReference, digest } from "./azure-storage.js";
import { collectStorageGarbage } from "./azure-storage-maintenance.js";
import { createStorageFixture } from "./test-helpers/storage-fixture.js";
import {
  preparePostgresMigration,
  validatePostgresMigration,
  applyPostgresMigration,
  migrationTarget,
} from "./postgres-storage-migration.js";

const root = resolve(process.cwd(), "../..");
const inputs = join(root, ".AI", `migration-test-${randomUUID()}`);
const schema = `migration_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Run this suite through scripts/test-local.mjs --postgres");
const url = new URL(databaseUrl);
if (
  url.hostname !== "127.0.0.1" ||
  url.pathname !== "/mafia_test" ||
  !url.port ||
  url.search ||
  url.hash
)
  throw new Error("Only an owned disposable PostgreSQL test fixture is permitted");
const admin = new Pool({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
const source = {
  database: "mafia_test",
  schema,
  serverAddress: "127.0.0.1",
  serverPort: Number(url.port),
};
let fixture: Awaited<ReturnType<typeof createStorageFixture>>;
const destination = () => {
  const suffix = randomUUID().replaceAll("-", "");
  return new AzureStorage({
    ...fixture.options,
    tableName: `Migration${suffix}`,
    containerName: `migration-${suffix}`,
  });
};
const archive = async (target: AzureStorage, name = randomUUID()) => {
  const directory = join(inputs, name);
  const proof = await preparePostgresMigration(pool, directory, {
    projectRoot: root,
    source,
    target: migrationTarget(target),
  });
  return { directory, ...proof };
};
const apply = (target: AzureStorage, pkg: Awaited<ReturnType<typeof archive>>) =>
  applyPostgresMigration(target, pkg.directory, { projectRoot: root, sha256: pkg.sha256 });

beforeAll(async () => {
  await mkdir(inputs, { mode: 0o700, recursive: true });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await initializeSchema(pool);
  fixture = await createStorageFixture();
}, 30000);
afterAll(async () => {
  await fixture?.close();
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

describe("one-time PostgreSQL migration (real disposable stores)", () => {
  it("exports read-only and imports identities, snapshots, projections, exclusions and exact completion", async () => {
    const target = destination();
    const sqlGames = new GameSessionStore(pool);
    const tournament = await new TournamentStore(pool).create("Imported event", DEFAULT_CLUB_ID);
    const players = new PlayerStore(pool);
    const host = await players.create({
      nickname: "Host",
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const member = await players.create({
      nickname: "Consented",
      consent: true,
      firstName: "Test",
      lastName: "Member",
      email: "member@example.invalid",
      clubAccess: "user",
    });
    const userId = randomUUID();
    await pool.query(
      "INSERT INTO users (id, google_subject, email, display_name) VALUES ($1, 'migration-subject', 'member@example.invalid', 'Test Member')",
      [userId],
    );
    await pool.query("UPDATE players SET user_id=$1 WHERE id=$2", [userId, member.id]);
    await pool.query(
      "INSERT INTO club_memberships (club_id,user_id,role,access_player_id) VALUES ($1,$2,'user',$3)",
      [DEFAULT_CLUB_ID, userId, member.id],
    );
    await pool.query("UPDATE clubs SET header_logo=$1, card_logo=$2 WHERE id=$3", [
      "data:image/png;base64,c3ludGhldGlj",
      "synthetic logo".repeat(9000),
      DEFAULT_CLUB_ID,
    ]);
    const cookie = createHash("sha256").update("synthetic-old-cookie").digest();
    await pool.query(
      "INSERT INTO user_sessions (id,token_hash,user_id,expires_at) VALUES ($1,$2,$3,NOW()+INTERVAL '1 day')",
      [randomUUID(), cookie, userId],
    );
    await pool.query(
      "INSERT INTO youtube_oauth_credentials (user_id,access_token_encrypted,refresh_token_encrypted,expires_at,account_label,scope) VALUES ($1,$2,$2,NOW(),'synthetic','synthetic')",
      [userId, Buffer.from("SYNTHETIC-CREDENTIAL-MUST-NOT-EXPORT")],
    );
    const partial = await sqlGames.create({
      creationId: randomUUID(),
      tournamentId: tournament.id,
      name: "Partial",
      state: {
        setup: { hostPlayerId: host.id, selectedPlayerIds: [member.id], step: "players" },
        events: [],
      },
      results: null,
    });
    const creationId = randomUUID();
    const done = await sqlGames.create({
      creationId,
      name: "Completed",
      state: {
        hostPlayerId: host.id,
        game: {
          phase: "finished",
          day: 3,
          players: [{ id: member.id, seat: 1, role: "sheriff", team: "red" }],
        },
        events: [],
      },
      results: {
        hostPlayerId: host.id,
        outcome: "red",
        winner: "red",
        reason: null,
        playedAt: "2026-01-02T12:00:00.000Z",
        players: [
          {
            playerId: member.id,
            seat: 1,
            role: "sheriff",
            team: "red",
            status: "active",
            fouls: 2,
            bestMoveHits: 1,
          },
        ],
      },
    });
    const deletedCreation = randomUUID();
    const removed = await sqlGames.create({
      creationId: deletedCreation,
      name: "Deleted",
      state: {},
      results: null,
    });
    await sqlGames.clear({ gameId: removed.gameId });
    await pool.query("INSERT INTO deleted_clubs (club_id) VALUES ($1)", [randomUUID()]);
    await pool.query(
      "INSERT INTO game_daily_counters (club_id,game_date,last_number) VALUES ($1,'2026-01-02',19)",
      [DEFAULT_CLUB_ID],
    );
    await pool.query(
      "INSERT INTO game_session_mutations (club_id,game_id,mutation_id,revision,request) VALUES ($1,$2,$3,1,$4)",
      [
        DEFAULT_CLUB_ID,
        done.gameId,
        randomUUID(),
        JSON.stringify({ name: "retained mutation", state: {}, results: null }),
      ],
    );
    const before = await pool.query(
      "SELECT row_to_json(t)::text AS row FROM game_sessions t ORDER BY id",
    );
    const pkg = await archive(target);
    expect(await readFile(join(pkg.directory, "source.json"), "utf8")).not.toContain(
      "SYNTHETIC-CREDENTIAL",
    );
    expect(await validatePostgresMigration(pkg.directory, { projectRoot: root })).toMatchObject({
      sha256: pkg.sha256,
    });
    expect(await apply(target, pkg)).toMatchObject({ status: "imported" });
    expect(await apply(target, pkg)).toMatchObject({ status: "already-imported" });
    expect(
      (await pool.query("SELECT row_to_json(t)::text AS row FROM game_sessions t ORDER BY id"))
        .rows,
    ).toEqual(before.rows);
    const games = new AzureGameSessionStore(target);
    for (const game of [partial, done])
      expect(await games.get(game.gameId)).toEqual(await sqlGames.get(game.gameId));
    expect(await new AzureTournamentStore(target).list(DEFAULT_CLUB_ID)).toEqual([tournament]);
    expect(await games.readStatisticsInputs()).toEqual(await sqlGames.readStatisticsInputs());
    expect(
      await games.listCompleted(DEFAULT_CLUB_ID, {
        from: "2026-01-02",
        to: "2026-01-02",
        playerId: member.id,
      }),
    ).toEqual(
      await sqlGames.listCompleted(DEFAULT_CLUB_ID, {
        from: "2026-01-02",
        to: "2026-01-02",
        playerId: member.id,
      }),
    );
    expect(await new AzurePlayerStore(target).list()).toEqual(await players.list());
    expect(await new AzureEventStore(target).read(done.gameId)).toEqual(
      await new EventStore(pool).read(done.gameId),
    );
    const accounts = new AzureAccountStore(target);
    expect(await accounts.findSession(cookie, new Date())).toBeNull();
    expect(await accounts.getCredential(userId)).toBeNull();
    expect(await new AzureClubStore(target).getRole(userId, DEFAULT_CLUB_ID)).toBe("user");
    expect(await new AzureClubStore(target).listForUser(userId)).toEqual(
      await new ClubStore(pool).listForUser(userId),
    );
    expect(await games.get(done.gameId, randomUUID())).toBeNull();
    await expect(
      target.runAuthorized(userId, randomUUID(), false, () => games.get(done.gameId)),
    ).rejects.toMatchObject({ code: "club_access_denied" });
    await expect(
      games.create({ creationId: deletedCreation, name: "retry", state: {}, results: null }),
    ).rejects.toMatchObject({ code: "game_deleted" });
    await expect(
      games.save({
        gameId: removed.gameId,
        name: "resurrect",
        mutationId: randomUUID(),
        state: {},
        results: null,
      }),
    ).rejects.toMatchObject({ code: "game_session_not_found" });
    expect(
      await accounts.upsertUser({
        id: randomUUID(),
        subject: "migration-subject",
        email: "member@example.invalid",
        name: "Test Member",
        picture: null,
      }),
    ).toMatchObject({ id: userId });
    await expect(apply(target, pkg)).rejects.toThrow(/changed|nonempty/);
    const key = `club:${DEFAULT_CLUB_ID}:game:${partial.gameId}`;
    const importedRow = (await target.getEntity(key))!;
    const createdAtProperty = (
      await target.table.getEntity<Record<string, unknown>>(target.options.partitionKey, key, {
        disableTypeConversion: true,
      })
    ).createdAt;
    const imported = await target.read((tx) =>
      tx.readBlob<{ postgres: Record<string, unknown> }>(blobReference(importedRow)),
    );
    const mutationId = randomUUID();
    const failed = vi
      .spyOn(target.table, "submitTransaction")
      .mockRejectedValueOnce(new Error("synthetic SDK failure with secret fixture detail"));
    try {
      await expect(
        games.save({
          gameId: partial.gameId,
          name: "Unpublished",
          mutationId,
          state: partial.state,
          results: null,
        }),
      ).rejects.toThrow("Storage publication failed");
    } finally {
      failed.mockRestore();
    }
    expect(await target.getEntity(key)).toEqual(importedRow);
    expect(
      await target.read((tx) =>
        tx.readBlob<{ postgres: Record<string, unknown> }>(blobReference(importedRow)),
      ),
    ).toEqual(imported);
    for (const [index, name] of ["Later", "Last-commit-wins"].entries()) {
      const saved = await games.save({
        gameId: partial.gameId,
        name,
        mutationId,
        state: partial.state,
        results: null,
      });
      expect(saved).toMatchObject({ revision: index + 2, duplicate: false });
      expect(saved).not.toHaveProperty("postgres");
      const row = (await target.getEntity(key))!;
      expect(row.createdAt).toEqual(importedRow.createdAt);
      expect(
        (
          await target.table.getEntity<Record<string, unknown>>(target.options.partitionKey, key, {
            disableTypeConversion: true,
          })
        ).createdAt,
      ).toEqual(createdAtProperty);
      expect(row.lastMutationId).toBe(mutationId);
      const snapshot = await target.read((tx) =>
        tx.readBlob<{ postgres: Record<string, unknown> }>(blobReference(row)),
      );
      expect(snapshot.postgres).toEqual({
        ...imported.postgres,
        lastMutationId: mutationId,
        updatedAt: saved.updatedAt.toISOString(),
      });
      expect(saved.state).toEqual(partial.state);
    }
    expect(
      (await pool.query("SELECT row_to_json(t)::text AS row FROM game_sessions t ORDER BY id"))
        .rows,
    ).toEqual(before.rows);
  }, 60000);

  it("refuses foreign/nonempty targets and leaves an interrupted target unservable without reset", async () => {
    const target = destination();
    const pkg = await archive(target);
    await expect(apply(destination(), pkg)).rejects.toThrow(/target/);
    await target.initialize(true);
    await target.mutate((tx) => tx.set("first-business-row", { value: "must survive" }));
    await expect(apply(target, pkg)).rejects.toThrow(/nonempty/);
    const interrupted = destination();
    const pending = await archive(interrupted);
    const original = interrupted.table.createEntity.bind(interrupted.table);
    const create = vi.spyOn(interrupted.table, "createEntity");
    create.mockImplementation(async (entity, ...args) => {
      if (entity.rowKey !== "control") throw new Error("synthetic interruption");
      return original(entity, ...args);
    });
    await expect(apply(interrupted, pending)).rejects.toThrow(/failed|interrupted/);
    create.mockRestore();
    await expect(interrupted.ready()).rejects.toThrow();
    await expect(apply(interrupted, pending)).rejects.toThrow(/incomplete|nonempty/);
  }, 30000);

  it("imports into a recognized initialized empty destination without merging business data", async () => {
    const target = destination();
    await target.initialize(true);
    const original = await target.getControl();
    expect(await target.read((tx) => tx.list("club:"))).toEqual([]);
    const pkg = await archive(target);
    expect(await apply(target, pkg)).toMatchObject({ status: "imported" });
    expect(await target.getControl()).toMatchObject({
      datasetId: pkg.manifest.datasetId,
      revision: 1,
      writeMode: "normal",
    });
    expect((await target.getControl()).datasetId).not.toBe(original.datasetId);
    expect(await new AzurePlayerStore(target).list()).toEqual(await new PlayerStore(pool).list());
    expect(await apply(target, pkg)).toMatchObject({ status: "already-imported" });
  }, 30000);

  it("refuses initialized-empty reservation when a concurrent first business write wins its control CAS", async () => {
    const target = destination();
    await target.initialize(true);
    const original = await target.getControl();
    const pkg = await archive(target);
    const update = target.table.updateEntity.bind(target.table);
    let raced = false;
    const reservation = vi
      .spyOn(target.table, "updateEntity")
      .mockImplementation(async (entity, mode, options) => {
        if (entity.rowKey === "control") {
          raced = true;
          await target.mutate((tx) =>
            tx.set("concurrent-first-write", { value: "accepted application data" }),
          );
        }
        return update(entity, mode, options);
      });
    try {
      await expect(apply(target, pkg)).rejects.toThrow(/failed|changed|nonempty/);
    } finally {
      reservation.mockRestore();
    }
    expect(raced).toBe(true);
    expect(await target.getControl()).toMatchObject({
      datasetId: original.datasetId,
      schemaVersion: 1,
      revision: 1,
      writeMode: "normal",
    });
    expect(await target.getEntity("concurrent-first-write")).toMatchObject({
      value: "accepted application data",
    });
    expect(await target.read((tx) => tx.list("migration:"))).toEqual([]);
    expect((await target.blobs.getProperties()).metadata ?? {}).toEqual({});
    expect((await target.blobs.listBlobsFlat().next()).done).toBe(true);
    await target.ready();
  }, 30000);

  it("refuses unknown initialized controls and any other rows, Blobs or container metadata without alteration", async () => {
    const controlChanges: Record<string, unknown>[] = [
      { schemaVersion: -1 },
      { revision: 1 },
      { writeMode: "backup-frozen", freezeOwner: randomUUID() },
      { datasetId: "not-a-uuid" },
      { blobContainer: "https://foreign.invalid/container" },
      { dataEpoch: randomUUID() },
      { foreignMetadata: "keep exact" },
    ];
    const scenarios = [
      ...controlChanges.map((changes) => async (target: AzureStorage) => {
        const control = await target.getControl();
        await target.table.updateEntity(
          {
            partitionKey: target.options.partitionKey,
            rowKey: "control",
            ...changes,
          },
          "Merge",
          { etag: control.etag },
        );
      }),
      async (target: AzureStorage) => {
        await target.table.createEntity({
          partitionKey: "foreign-partition",
          rowKey: "foreign",
          value: "keep",
        });
      },
      async (target: AzureStorage) => {
        await target.blobs
          .getBlockBlobClient("unreferenced-business-input")
          .uploadData(Buffer.from("keep"));
      },
      async (target: AzureStorage) => {
        await target.blobs.setMetadata({ foreignowner: "keep" });
      },
    ];
    for (const change of scenarios) {
      const target = destination();
      await target.initialize(true);
      const pkg = await archive(target);
      await change(target);
      const before = await target.getEntity("control");
      await expect(apply(target, pkg)).rejects.toThrow(/nonempty|foreign|incomplete|reserved/);
      expect(await target.getEntity("control")).toEqual(before);
      expect(await target.getEntity("migration:source")).toBeUndefined();
    }
  }, 60000);

  it("preserves canonical case/hash/replay and retired history through real readers", async () => {
    const players = new PlayerStore(pool);
    const host = await players.create({
      nickname: `Replay host ${randomUUID()}`,
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const roster = [];
    for (let n = 0; n < 10; n++)
      roster.push(
        await players.create({
          nickname: `Replay ${n} ${randomUUID()}`,
          consent: false,
          firstName: null,
          lastName: null,
          email: null,
        }),
      );
    let setup = beginRoleDraw(
      createSetup(roster.map((p, n) => ({ id: p.id.toUpperCase(), seat: n + 1 }))),
      createSeededRandom(13),
    );
    for (let seat = 1; seat <= 10; seat++) setup = drawRoleForSeat(setup, seat);
    const baseline = createGame(completeRoleDraw(setup));
    const sqlGames = new GameSessionStore(pool);
    const creationId = randomUUID();
    const game = await sqlGames.create({ creationId, name: "Canonical", state: {}, results: null });
    const { entry } = createGameLogEntry({
      gameId: game.gameId,
      id: randomUUID().toUpperCase(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-01-03T12:00:00.000Z",
      before: baseline,
      draft: { type: "game.started", payload: {} },
    });
    const state = {
      hostPlayerId: host.id,
      game: baseline,
      initialGame: { replayVersion: 1, game: baseline },
      events: [entry],
      headEventId: entry.id,
    };
    const results = {
      hostPlayerId: host.id,
      outcome: "red",
      winner: "red",
      reason: null,
      playedAt: "2026-01-03T12:00:00.000Z",
      players: baseline.players.map((p) => ({
        playerId: p.id,
        seat: p.seat,
        role: p.role,
        team: p.team,
        status: p.status,
        fouls: p.fouls,
        bestMoveHits: null,
      })),
    };
    await sqlGames.save({
      gameId: game.gameId,
      name: "Canonical",
      mutationId: randomUUID(),
      state,
      results,
    });
    await pool.query(
      "UPDATE game_events SET parent_event_id=NULL,replay_sequence=1,phase_after=$1,day_before=$2,day_after=$2,state_hash_after=$3 WHERE game_id=$4",
      [entry.phaseAfter, entry.dayBefore, entry.stateHashAfter, game.gameId],
    );
    expect(await players.delete(roster[0]!.id)).toBe("deleted");
    const target = destination();
    const pkg = await archive(target);
    await apply(target, pkg);
    const migrated = (await new AzureGameSessionStore(target).get(game.gameId))!;
    expect(migrated.state).toEqual(state);
    expect((migrated.state.events as GameLogEntry[])[0]?.id).toBe(entry.id);
    expect((migrated.state.events as GameLogEntry[])[0]?.stateHashAfter).toBe(entry.stateHashAfter);
    expect(
      replayGameLog(
        migrated.state.initialGame as InitialGameBaseline,
        migrated.state.events as GameLogEntry[],
        game.gameId,
      ).game,
    ).toEqual(baseline);
    expect(await new AzureEventStore(target).read(game.gameId)).toEqual(
      await new EventStore(pool).read(game.gameId),
    );
    expect(await new AzurePlayerStore(target).get(roster[0]!.id)).toBeNull();
    expect(await new AzurePlayerStore(target).list()).toEqual(await players.list());
    expect(await target.getEntity(`club:${DEFAULT_CLUB_ID}:player:${roster[0]!.id}`)).toMatchObject(
      { id: roster[0]!.id, retiredAt: expect.any(Date) },
    );
    expect(
      await new AzureGameSessionStore(target).create({
        creationId,
        name: "old",
        state: {},
        results: null,
      }),
    ).toMatchObject({ gameId: game.gameId, duplicate: true, state });
  }, 60000);

  it("imports more than 100 entities, retains counters/mutations and refuses incomplete readback", async () => {
    for (let n = 0; n < 115; n++)
      await pool.query("INSERT INTO players (id,club_id,nickname) VALUES ($1,$2,$3)", [
        randomUUID(),
        DEFAULT_CLUB_ID,
        `Chunk ${n}`,
      ]);
    const target = destination();
    const pkg = await archive(target);
    expect(pkg.manifest.entityCount).toBeGreaterThan(100);
    await apply(target, pkg);
    expect(
      await target.getEntity(`club:${DEFAULT_CLUB_ID}:daily-counter:2026-01-02`),
    ).toMatchObject({ lastNumber: 19 });
    const mutation = (
      await pool.query<{ game_id: string; mutation_id: string; request: unknown }>(
        "SELECT game_id,mutation_id,request FROM game_session_mutations",
      )
    ).rows[0]!;
    expect(
      await target.getEntity(
        `club:${DEFAULT_CLUB_ID}:mutation:${mutation.game_id}:${mutation.mutation_id}`,
      ),
    ).toMatchObject({ mutationId: mutation.mutation_id, revision: 1 });
    const interrupted = destination();
    const pending = await archive(interrupted);
    const original = interrupted.table.createEntity.bind(interrupted.table);
    const spy = vi.spyOn(interrupted.table, "createEntity");
    spy.mockImplementation(async (entity, ...args) =>
      entity.rowKey?.includes(":nickname:") ? {} : original(entity, ...args),
    );
    await expect(apply(interrupted, pending)).rejects.toThrow(/readback/);
    spy.mockRestore();
    await expect(interrupted.ready()).rejects.toThrow();
  }, 60000);

  it("supports a current schema with zero business data and never initializes its source", async () => {
    const empty = `empty_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${empty}`);
    const emptyPool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${empty}`,
    });
    try {
      await initializeSchema(emptyPool);
      await emptyPool.query("TRUNCATE users,clubs,players,club_memberships,game_rulesets CASCADE");
      const readonly = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${empty} -c default_transaction_read_only=on`,
      });
      try {
        const target = destination();
        const directory = join(inputs, "empty");
        const pkg = await preparePostgresMigration(readonly, directory, {
          projectRoot: root,
          source: { ...source, schema: empty },
          target: migrationTarget(target),
        });
        await applyPostgresMigration(target, directory, { projectRoot: root, sha256: pkg.sha256 });
        expect(
          await new AzureClubStore(target).listForUser("00000000-0000-4000-8000-000000000001"),
        ).toEqual([]);
        expect((await emptyPool.query("SELECT COUNT(*)::int AS n FROM users")).rows[0]?.n).toBe(0);
      } finally {
        await readonly.end();
      }
    } finally {
      await emptyPool.end();
      await admin.query(`DROP SCHEMA ${empty} CASCADE`);
    }
  }, 30000);

  it("executes the exact CLI export/validate/apply interface without environment inheritance", async () => {
    const target = destination();
    const sourceConfig = join(inputs, "source-config.json");
    const targetConfig = join(inputs, "target-config.json");
    await writeFile(
      sourceConfig,
      JSON.stringify({
        identity: source,
        connection: {
          host: "127.0.0.1",
          port: Number(url.port),
          database: "mafia_test",
          user: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
          ssl: false,
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(targetConfig, JSON.stringify({ mode: "local", ...target.options }), {
      mode: 0o600,
    });
    const directory = join(inputs, "cli");
    const compiled = join(inputs, "compiled");
    await promisify(execFile)(
      process.execPath,
      [
        resolve(root, "node_modules/tsup/dist/cli-default.js"),
        "src/migrate-postgres-to-storage.ts",
        "--format",
        "esm",
        "--out-dir",
        compiled,
        "--no-splitting",
      ],
      {
        cwd: resolve(root, "apps/server"),
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
      },
    );
    const run = async (command: string, extra: string[] = []) => {
      const result = await promisify(execFile)(
        process.execPath,
        [
          join(compiled, "migrate-postgres-to-storage.js"),
          command,
          "--project-root",
          root,
          "--package",
          directory,
          ...extra,
        ],
        {
          cwd: resolve(root, "apps/server"),
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            DATABASE_URL: "THIS-MUST-NOT-BE-READ",
            PGPASSWORD: "THIS-MUST-NOT-BE-READ",
            PGSSLNEGOTIATION: "THIS-MUST-NOT-BE-READ",
            PGOPTIONS: "-c search_path=THIS_MUST_NOT_BE_READ",
            PGHOST: "THIS-MUST-NOT-BE-READ",
            PGDATABASE: "THIS-MUST-NOT-BE-READ",
            PGUSER: "THIS-MUST-NOT-BE-READ",
            AZURE_STORAGE_CONNECTION_STRING: "THIS-MUST-NOT-BE-READ",
          },
        },
      );
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain("THIS-MUST-NOT");
      return JSON.parse(result.stdout) as { status: string; sha256: string };
    };
    const exported = await run("export", [
      "--source-file",
      sourceConfig,
      "--target-file",
      targetConfig,
    ]);
    expect(exported.status).toBe("exported");
    expect(await run("validate")).toMatchObject({ status: "validated", sha256: exported.sha256 });
    expect(
      await run("apply", ["--target-file", targetConfig, "--sha256", exported.sha256]),
    ).toMatchObject({ status: "imported" });
    expect(
      await run("apply", ["--target-file", targetConfig, "--sha256", exported.sha256]),
    ).toMatchObject({ status: "already-imported" });
  }, 60000);

  it("uses a source role with SELECT only on business tables and no credential access", async () => {
    const role = `migration_reader_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    await admin.query(`CREATE ROLE ${role} LOGIN`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    const tableNames = (
      await pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename NOT IN ('user_sessions','youtube_oauth_credentials') ORDER BY tablename",
        [schema],
      )
    ).rows.map((r) => r.tablename);
    for (const table of tableNames)
      await admin.query(`GRANT SELECT ON ${schema}.${table} TO ${role}`);
    const readonlyUrl = new URL(databaseUrl!);
    readonlyUrl.username = role;
    readonlyUrl.password = "";
    const readonly = new Pool({
      connectionString: readonlyUrl.href,
      options: `-c search_path=${schema} -c default_transaction_read_only=on`,
    });
    try {
      await expect(readonly.query("SELECT * FROM user_sessions")).rejects.toMatchObject({
        code: "42501",
      });
      await expect(readonly.query("SELECT * FROM youtube_oauth_credentials")).rejects.toMatchObject(
        { code: "42501" },
      );
      const target = destination();
      const directory = join(inputs, "read-only");
      const pkg = await preparePostgresMigration(readonly, directory, {
        projectRoot: root,
        source,
        target: migrationTarget(target),
      });
      await applyPostgresMigration(target, directory, { projectRoot: root, sha256: pkg.sha256 });
      expect(await new AzurePlayerStore(target).list()).toEqual(await new PlayerStore(pool).list());
    } finally {
      await readonly.end();
      await admin.query(`DROP OWNED BY ${role}`);
      await admin.query(`DROP ROLE ${role}`);
    }
  }, 60000);

  it("rejects name-bearing/unknown replay/rounded JSON source without repair or target writes", async () => {
    const sourceGame = (
      await pool.query<{ id: string; state: unknown }>(
        "SELECT id,state FROM game_sessions ORDER BY id LIMIT 1",
      )
    ).rows[0]!;
    const originals = JSON.stringify(sourceGame.state);
    const invalids = [
      JSON.stringify({ setup: { hostName: "Unsupported copied source name" } }),
      JSON.stringify({ initialGame: { replayVersion: 9, game: {} } }),
      '{"decimal":1.0000000000000001}',
    ];
    await writeFile(join(inputs, "rejected-synthetic-source.json"), JSON.stringify(invalids), {
      mode: 0o600,
    });
    try {
      for (const value of invalids) {
        await pool.query("UPDATE game_sessions SET state=$1::jsonb WHERE id=$2", [
          value,
          sourceGame.id,
        ]);
        const target = destination();
        const before = (
          await pool.query("SELECT state::text AS state FROM game_sessions WHERE id=$1", [
            sourceGame.id,
          ])
        ).rows;
        await expect(archive(target)).rejects.toThrow(/Unsupported|failed|rounding/);
        expect(
          (
            await pool.query("SELECT state::text AS state FROM game_sessions WHERE id=$1", [
              sourceGame.id,
            ])
          ).rows,
        ).toEqual(before);
        expect(await target.blobs.exists()).toBe(false);
      }
    } finally {
      await pool.query("UPDATE game_sessions SET state=$1::jsonb WHERE id=$2", [
        originals,
        sourceGame.id,
      ]);
    }
  }, 30000);

  it("resumes tombstoned cleanup of unbounded imported mutations without losing shared request Blobs", async () => {
    const sqlGames = new GameSessionStore(pool);
    const creationId = randomUUID();
    const game = await sqlGames.create({
      creationId,
      name: "Many retries",
      state: {},
      results: null,
    });
    const sibling = await sqlGames.create({
      creationId: randomUUID(),
      name: "Shared request owner",
      state: {},
      results: null,
    });
    const sharedRequest = { name: "Shared", state: {}, results: null };
    await pool.query("UPDATE game_sessions SET revision=125 WHERE id=$1", [game.gameId]);
    for (let index = 0; index < 125; index++)
      await pool.query(
        "INSERT INTO game_session_mutations (club_id,game_id,mutation_id,revision,request) VALUES ($1,$2,$3,$4,$5)",
        [
          DEFAULT_CLUB_ID,
          game.gameId,
          randomUUID(),
          index + 1,
          index === 124
            ? null
            : JSON.stringify(index === 0 ? sharedRequest : { ...sharedRequest, state: { index } }),
        ],
      );
    const siblingMutationId = randomUUID();
    await pool.query(
      "INSERT INTO game_session_mutations (club_id,game_id,mutation_id,revision,request) VALUES ($1,$2,$3,1,$4)",
      [DEFAULT_CLUB_ID, sibling.gameId, siblingMutationId, JSON.stringify(sharedRequest)],
    );
    const sourceBefore = (
      await pool.query(
        "SELECT row_to_json(t)::text AS row FROM game_session_mutations t ORDER BY mutation_id",
      )
    ).rows;
    const target = destination();
    await apply(target, await archive(target));
    const games = new AzureGameSessionStore(target);
    const key = `club:${DEFAULT_CLUB_ID}:game:${game.gameId}`;
    const prefix = `club:${DEFAULT_CLUB_ID}:mutation:${game.gameId}:`;
    const tombstoneKey = `club:${DEFAULT_CLUB_ID}:deleted-game:${game.gameId}`;
    const rows = await target.read((tx) => tx.list<Record<string, unknown>>(prefix));
    expect(rows).toHaveLength(125);
    const refs = rows.filter((row) => row.blobName !== undefined).map(blobReference);
    expect(refs).toHaveLength(124);
    const snapshotRef = blobReference((await target.getEntity(key))!);
    const siblingKey = `club:${DEFAULT_CLUB_ID}:mutation:${sibling.gameId}:${siblingMutationId}`;
    const sharedRef = blobReference((await target.getEntity(siblingKey))!);
    expect(refs.some((ref) => ref.name === sharedRef.name)).toBe(true);
    const submit = target.table.submitTransaction.bind(target.table);
    let cleanupChunks = 0;
    const publication = vi
      .spyOn(target.table, "submitTransaction")
      .mockImplementation(async (actions, options) => {
        if (
          actions.some(
            ([operation, entity]) => operation === "delete" && entity.rowKey.startsWith(prefix),
          )
        ) {
          cleanupChunks++;
          expect(await games.get(game.gameId)).toBeNull();
          expect(await target.getEntity(tombstoneKey)).toBeDefined();
          if (cleanupChunks === 2)
            throw new Error("synthetic SDK failure with secret fixture detail");
        }
        return submit(actions, options);
      });
    try {
      await expect(games.clear({ gameId: game.gameId })).rejects.toThrow(
        "Storage publication failed",
      );
      expect(publication.mock.calls.every(([actions]) => actions.length <= 100)).toBe(true);
    } finally {
      publication.mockRestore();
    }
    expect(cleanupChunks).toBe(2);
    expect(await games.get(game.gameId)).toBeNull();
    const remaining = await target.read((tx) => tx.list(prefix));
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining.length).toBeLessThan(125);
    const tombstone = (await target.getEntity(tombstoneKey))!;
    for (const ref of [snapshotRef, ...refs])
      expect(await target.blobs.getBlockBlobClient(ref.name).exists()).toBe(true);
    const batches = vi.spyOn(target.table, "submitTransaction");
    try {
      await games.clear({ gameId: game.gameId });
      expect(
        batches.mock.calls.filter(([actions]) =>
          actions.some(
            ([operation, entity]) => operation === "delete" && entity.rowKey.startsWith(prefix),
          ),
        ).length,
      ).toBeGreaterThan(1);
      expect(batches.mock.calls.every(([actions]) => actions.length <= 100)).toBe(true);
    } finally {
      batches.mockRestore();
    }
    expect(await target.read((tx) => tx.list(prefix))).toEqual([]);
    expect((await target.getEntity(tombstoneKey))!.deletedAt).toEqual(tombstone.deletedAt);
    for (const ref of [snapshotRef, ...refs])
      expect(await target.getEntity(`cleanup:${digest(ref.name)}`)).toMatchObject({
        kind: "retired-blob",
        blobName: ref.name,
      });
    expect(await target.getEntity(siblingKey)).toBeDefined();
    expect(await games.get(sibling.gameId)).toMatchObject({ gameId: sibling.gameId });
    await expect(
      games.save({
        gameId: game.gameId,
        mutationId: randomUUID(),
        name: "Stale",
        state: {},
        results: null,
      }),
    ).rejects.toMatchObject({ code: "game_session_not_found" });
    await expect(
      games.create({ creationId, name: "Stale", state: {}, results: null }),
    ).rejects.toMatchObject({ code: "game_deleted" });
    await collectStorageGarbage(target);
    for (const ref of [snapshotRef, ...refs])
      expect(await target.blobs.getBlockBlobClient(ref.name).exists()).toBe(
        ref.name === sharedRef.name,
      );
    expect(await games.get(sibling.gameId)).not.toBeNull();
    await games.clear({ gameId: sibling.gameId });
    await collectStorageGarbage(target);
    expect(await target.blobs.getBlockBlobClient(sharedRef.name).exists()).toBe(false);
    expect(
      (
        await pool.query(
          "SELECT row_to_json(t)::text AS row FROM game_session_mutations t ORDER BY mutation_id",
        )
      ).rows,
    ).toEqual(sourceBefore);
    expect(await sqlGames.get(game.gameId)).not.toBeNull();
  }, 60000);

  it("rejects corrupt packages and unsupported source before target writes", async () => {
    const target = destination();
    const pkg = await archive(target);
    await writeFile(join(pkg.directory, "source.json"), "{}", { mode: 0o600 });
    await expect(apply(target, pkg)).rejects.toThrow(/hash|checksum/);
    expect(await target.blobs.exists()).toBe(false);
    await pool.query("ALTER TABLE users ADD COLUMN unexpected TEXT");
    await expect(archive(destination())).rejects.toThrow(/schema/);
    await pool.query("ALTER TABLE users DROP COLUMN unexpected");
  }, 30000);
});

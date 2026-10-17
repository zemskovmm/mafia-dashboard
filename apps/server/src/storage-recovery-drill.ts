import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { odata } from "@azure/data-tables";
import {
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createGameLogEntry,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  hashGameState,
  isSecretGameEventType,
  replayGameLog,
  type CanonicalGameEventDraft,
  type GameLogEntry,
  type InitialGameBaseline,
} from "@mafia/game-domain";
import { startAzurite } from "../../../scripts/local-azurite.mjs";
import { buildApp } from "./app.js";
import { AzureStorage, type AzureStorageOptions } from "./azure-storage.js";
import { createAzureStores } from "./azure-stores.js";
import { GoogleAuthService } from "./google-auth.js";
import { captureStorageBackup, restoreStorageBackup } from "./storage-backup.js";
import { createStorageFixture } from "./test-helpers/storage-fixture.js";

export interface StorageRecoveryDrillSummary {
  readonly backend: "owned-local-azurite";
  readonly backupDirectory: string;
  readonly manifestSha256: string;
  readonly captureId: string;
  readonly frozenRevision: number;
  readonly entityCount: number;
  readonly blobCount: number;
  readonly invalidatedSessions: number;
  readonly captureMs: number;
  readonly freezeMs: number;
  readonly restoreMs: number;
  readonly elapsedMs: number;
  readonly checks: {
    readonly authenticatedRecovery: true;
    readonly exactSnapshots: true;
    readonly canonicalReplay: true;
    readonly projectionsAndFilters: true;
    readonly secretRedaction: true;
    readonly retiredIdentity: true;
    readonly deletedGame: true;
    readonly subsequentSave: true;
    readonly sourceUnchanged: true;
    readonly tournamentMetadata: true;
    readonly statisticsSource: true;
  };
}

type App = Awaited<ReturnType<typeof buildApp>>;
type Stores = ReturnType<typeof createAzureStores>;
type Fixture = Awaited<ReturnType<typeof createStorageFixture>>;
type Row = Record<string, unknown>;
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const check = (condition: unknown, label: string): void => {
  // Never attach response bodies, profiles, cookies or credential values to diagnostics.
  if (!condition) throw new Error(`Recovery drill verification failed: ${label}`);
};
const equal = (actual: unknown, expected: unknown, label: string): void =>
  check(isDeepStrictEqual(actual, expected), label);

/** Provider-only fixture: every application/account/session operation remains real. */
const createAuth = (stores: Stores): GoogleAuthService => {
  let subject: "owner" | "outsider" | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    if (input === "https://oauth2.googleapis.com/token") {
      const code = new URLSearchParams(String(init?.body)).get("code");
      check(code === "owner" || code === "outsider", "local provider authorization code");
      subject = code as "owner" | "outsider";
      return new Response(JSON.stringify({ access_token: "synthetic-provider-token" }));
    }
    check(
      input === "https://openidconnect.googleapis.com/v1/userinfo",
      "no external provider fetch",
    );
    check(subject !== undefined, "provider exchange precedes profile read");
    return new Response(
      JSON.stringify({
        sub: `recovery-drill-${subject}`,
        email: `${subject}@example.test`,
        email_verified: true,
        name: subject === "owner" ? "Recovery Owner" : "Recovery Outsider",
      }),
    );
  };
  return new GoogleAuthService(
    stores.auth,
    {
      clientId: "local-recovery-drill",
      clientSecret: "synthetic-provider-secret",
      redirectUri: "https://example.test/callback",
    },
    fetcher,
  );
};

/** A second process/account, with no initialized table or container. */
const createRecoveryTarget = async (source: AzureStorageOptions): Promise<Fixture> => {
  const emulator = await startAzurite({ mode: "test" });
  try {
    const suffix = randomUUID().replaceAll("-", "");
    const options: AzureStorageOptions = {
      connectionString: emulator.environment.AZURE_STORAGE_CONNECTION_STRING,
      tableName: `MafiaRestore${suffix}`,
      containerName: `mafia-restore-${suffix}`,
      // Blob paths carry the partition digest; only resources/account must differ.
      partitionKey: source.partitionKey,
    };
    const storage = new AzureStorage(options);
    let closed = false;
    return {
      storage,
      options,
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await storage.end();
        } finally {
          await emulator.stop();
        }
      },
    };
  } catch (error) {
    await emulator.stop();
    throw error;
  }
};

const backupDestination = async (): Promise<{ absolute: string; relative: string }> => {
  // Existing project artifacts are never removed/adopted through a symlink.
  let directory = repo;
  for (const component of [".AI", "storage-backups", "drills"]) {
    directory = join(directory, component);
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
        throw error;
    });
    const stat = await lstat(directory);
    check(stat.isDirectory() && !stat.isSymbolicLink(), "real backup ancestor");
    check(process.getuid === undefined || stat.uid === process.getuid(), "owned backup ancestor");
    if (component !== ".AI") check((stat.mode & 0o077) === 0, "private backup ancestor");
  }
  const id = randomUUID();
  // Capture owns creation and manifest-last publication of this new leaf.
  return { absolute: join(directory, id), relative: `.AI/storage-backups/drills/${id}` };
};

const rows = async (storage: AzureStorage): Promise<Row[]> => {
  const result: Row[] = [];
  for await (const row of storage.table.listEntities({
    queryOptions: {
      filter: odata`PartitionKey eq ${storage.options.partitionKey}`,
    },
  })) {
    result.push(
      Object.fromEntries(
        Object.entries(row).filter(([key]) => key !== "etag" && key !== "timestamp"),
      ),
    );
  }
  return result.sort((a, b) => String(a.rowKey).localeCompare(String(b.rowKey)));
};
const blobInventory = async (storage: AzureStorage) => {
  const result: Array<{ name: string; length: number; sha256: string }> = [];
  for await (const blob of storage.blobs.listBlobsFlat()) {
    const bytes = await storage.blobs.getBlockBlobClient(blob.name).downloadToBuffer();
    result.push({
      name: blob.name,
      length: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
};
const request = async (
  app: App,
  token: string,
  clubId: string | undefined,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  expectedStatus: number,
  payload?: object,
): Promise<Row> => {
  const response = await app.inject({
    method,
    url,
    headers: { cookie: `mafia_session=${token}`, ...(clubId ? { "x-club-id": clubId } : {}) },
    ...(payload === undefined ? {} : { payload }),
  });
  check(
    response.statusCode === expectedStatus,
    `${method} application endpoint expected ${expectedStatus}, received ${response.statusCode}`,
  );
  return response.statusCode === 204 ? {} : response.json<Row>();
};

/**
 * One bounded real application recovery proof. No environment/CLI target is accepted.
 * Only the fixtures created here are stopped; the private recovery package is retained.
 */
export const runStorageRecoveryDrill = async (): Promise<StorageRecoveryDrillSummary> => {
  const started = performance.now();
  const sourceFixture = await createStorageFixture();
  let targetFixture: Fixture | undefined;
  let sourceApp: App | undefined;
  let targetApp: App | undefined;
  let source: Stores | undefined;
  let target: Stores | undefined;
  try {
    source = createAzureStores(sourceFixture.options);
    const sourceAuth = createAuth(source);
    const owner = await sourceAuth.completeAuthorization("owner");
    await sourceAuth.completeAuthorization("outsider");
    sourceApp = await buildApp({ stores: source.stores, googleAuth: sourceAuth });
    const clubResponse = await request(
      sourceApp,
      owner.sessionToken,
      undefined,
      "POST",
      "/api/clubs",
      201,
      {
        name: "Synthetic recovery club",
        city: "London",
        language: "en",
        ownerConsent: true,
        headerLogo: null,
        cardLogo: null,
      },
    );
    const clubId = (clubResponse.club as { id: string }).id;
    const sourceRequest = (
      method: "GET" | "POST" | "PUT" | "DELETE",
      url: string,
      status: number,
      payload?: object,
    ) => request(sourceApp!, owner.sessionToken, clubId, method, url, status, payload);
    const roster: string[] = [];
    for (let index = 0; index < 10; index++) {
      const response = await sourceRequest("POST", "/api/players", 201, {
        nickname: `Synthetic seat ${index + 1}`,
        consent: false,
      });
      roster.push((response.player as { id: string }).id);
    }
    const sourceProfiles = (await sourceRequest("GET", "/api/players", 200)).players as Array<{
      id: string;
      nickname: string;
    }>;
    const host = sourceProfiles.find(({ nickname }) => nickname === "Owner");
    check(host, "club manager profile created through API");
    const hostId = host!.id;
    const partialState = {
      setup: {
        step: "players",
        hostPlayerId: hostId,
        selectedPlayerIds: ["", roster[1]!, "", "", "", "", "", "", "", ""],
        setup: null,
        bestMoveEnabled: false,
      },
      hostPlayerId: hostId,
      game: null,
      playlistId: "synthetic-playlist",
      initialGame: null,
      events: [],
      log: [],
      undoHistory: [],
      undoBudget: 0,
      headEventId: null,
      resetReturnEventId: null,
      legacyLog: [],
    };
    const partialCreation = randomUUID();
    const partial = await sourceRequest("POST", "/api/game-sessions", 201, {
      creationId: partialCreation,
      name: "Partial setup",
      state: partialState,
      results: null,
    });
    const partialId = partial.gameId as string;
    let setup = beginRoleDraw(
      createSetup(roster.map((id, index) => ({ id, seat: index + 1 }))),
      createSeededRandom(41),
    );
    for (let seat = 1; seat <= 10; seat++) setup = drawRoleForSeat(setup, seat);
    setup = completeRoleDraw(setup);
    const baseline: InitialGameBaseline = { replayVersion: 3, game: createGame(setup) };
    const initialState = {
      hostPlayerId: hostId,
      setup: { hostPlayerId: hostId, selectedPlayerIds: roster, setup },
      game: baseline.game,
      initialGame: baseline,
      events: [],
      log: [],
    };
    const completed = await sourceRequest("POST", "/api/game-sessions", 201, {
      creationId: randomUUID(),
      name: "Canonical recovery",
      state: initialState,
      results: null,
    });
    const completedId = completed.gameId as string;
    let game = baseline.game;
    const events: GameLogEntry[] = [];
    const append = (draft: CanonicalGameEventDraft) => {
      const next = createGameLogEntry({
        gameId: completedId,
        id: randomUUID(),
        sequence: events.length + 1,
        parentEventId: events.at(-1)?.id ?? null,
        createdAt: "2026-09-26T12:00:00.000Z",
        before: game,
        draft,
      });
      events.push(next.entry);
      game = next.after;
    };
    append({ type: "game.started", payload: {} });
    for (const to of [
      "mafia-sleep",
      "don-identification",
      "sheriff-identification",
      "free-seating",
      "day",
    ] as const)
      append({ type: "phase.changed", payload: { to } });
    append({ type: "phase.changed", payload: { to: "night-mafia" } });
    append({ type: "mafia.shots-resolved", payload: { shots: [], result: { kind: "miss" } } });
    append({ type: "phase.changed", payload: { to: "night-don" } });
    append({ type: "don.check-skipped", payload: {} });
    const blackSeat = game.players.find(({ team }) => team === "black")!.seat;
    append({ type: "sheriff.checked", payload: { targetSeat: blackSeat, match: true } });
    append({ type: "phase.changed", payload: { to: "night-resolution" } });
    append({ type: "phase.changed", payload: { to: "day" } });
    append({ type: "phase.changed", payload: { to: "night-mafia" } });
    append({ type: "mafia.shots-resolved", payload: { shots: [], result: { kind: "miss" } } });
    append({ type: "phase.changed", payload: { to: "night-don" } });
    append({ type: "don.check-skipped", payload: {} });
    append({ type: "sheriff.check-skipped", payload: {} });
    append({ type: "phase.changed", payload: { to: "draw" } });
    const state = { ...initialState, game, events, headEventId: events.at(-1)!.id };
    const results = {
      hostPlayerId: hostId,
      outcome: "draw",
      winner: null,
      reason: "MAFGAME 6.5.6: three consecutive game nights without a departure",
      playedAt: "2026-09-26T12:00:00.000Z",
      players: game.players.map(({ id, seat, role, team, status, fouls }) => ({
        playerId: id,
        seat,
        role,
        team,
        status,
        fouls,
        bestMoveHits: null,
      })),
    };
    await sourceRequest("PUT", `/api/game-sessions/${completedId}`, 200, {
      mutationId: randomUUID(),
      name: "Canonical recovery",
      state,
      results,
    });
    await sourceRequest("DELETE", `/api/players/${roster[0]!}`, 204);
    const deletedCreation = randomUUID();
    const deletedPayload = {
      creationId: deletedCreation,
      name: "Deleted recovery game",
      state: { events: [] },
      results: null,
    };
    const deleted = await sourceRequest("POST", "/api/game-sessions", 201, deletedPayload);
    const deletedId = deleted.gameId as string;
    await sourceRequest("DELETE", `/api/game-sessions/${deletedId}`, 204);

    const tournament = await source.stores.tournaments.create(
      "Retained recovery tournament",
      clubId,
    );
    await source.stores.tournaments.assign(completedId, tournament.id, clubId);
    await source.stores.tournaments.assign(partialId, tournament.id, clubId);
    const statisticsSource = await source.stores.games.readStatisticsInputs(clubId);
    // Record precise API projections and complete source authority before freezing.
    const readbacks = [
      "/api/clubs",
      "/api/players",
      "/api/tournaments",
      "/api/statistics",
      "/api/game-sessions",
      "/api/game-sessions?status=completed",
      `/api/game-sessions/${partialId}`,
      `/api/game-sessions/${completedId}`,
      `/api/games/${completedId}/events`,
      `/api/games/${completedId}/events?visibility=public`,
    ];
    const expected = new Map<string, Row>();
    for (const url of readbacks) expected.set(url, await sourceRequest("GET", url, 200));
    const sourceRows = await rows(sourceFixture.storage);
    const sourceBlobs = await blobInventory(sourceFixture.storage);
    const projectionPrefix = `club:${clubId}:`;
    const sourceProjections = sourceRows.filter(
      (row) =>
        String(row.rowKey).startsWith(projectionPrefix) &&
        (String(row.rowKey).includes(":participant:") || String(row.rowKey).includes(":result:")),
    );
    check(
      sourceProjections.filter((row) => row.gameId === completedId).length === 22 &&
        sourceProjections.filter((row) => row.gameId === partialId).length === 1,
      "full completed host/participant and partial host projections seeded",
    );
    const seededCanonical = expected.get(`/api/game-sessions/${completedId}`)!.session as {
      state: typeof state;
      results: typeof results;
    };
    equal(
      seededCanonical.state,
      JSON.parse(JSON.stringify(state)),
      "canonical source wire snapshot",
    );
    equal(seededCanonical.results, results, "canonical source result snapshot");
    equal(
      hashGameState(
        replayGameLog(seededCanonical.state.initialGame, seededCanonical.state.events, completedId)
          .game,
      ),
      hashGameState(game),
      "canonical source replay seeded",
    );
    const destination = await backupDestination();
    const packageJson = JSON.parse(await readFile(join(repo, "package.json"), "utf8")) as {
      version: string;
    };
    const { stdout } = await promisify(execFile)("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      timeout: 5_000,
    });
    const { stdout: status } = await promisify(execFile)(
      "git",
      ["status", "--porcelain", "--untracked-files=normal"],
      { cwd: repo, timeout: 5_000 },
    );
    const captureStart = performance.now();
    const manifest = await captureStorageBackup(sourceFixture.storage, destination.absolute, {
      applicationVersion: packageJson.version,
      applicationCommit: `${stdout.trim()}${status.trim() ? "-dirty" : ""}`,
    });
    const captureMs = performance.now() - captureStart;
    const freezeMs = Date.parse(manifest.completedAt) - Date.parse(manifest.startedAt);
    check(Number.isFinite(freezeMs) && freezeMs >= 0, "measured frozen capture interval");
    const manifestBytes = await readFile(join(destination.absolute, "manifest.json"));
    const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    const afterCaptureRows = await rows(sourceFixture.storage);
    const originalSourceRows = sourceRows.filter((row) => row.rowKey !== "control");
    const originalKeys = new Set(originalSourceRows.map((row) => row.rowKey));
    equal(
      afterCaptureRows.filter((row) => originalKeys.has(row.rowKey)),
      originalSourceRows,
      "capture preserves every original source entity",
    );
    const freezeReceipts = afterCaptureRows.filter(
      (row) => row.rowKey !== "control" && !originalKeys.has(row.rowKey),
    );
    equal(
      freezeReceipts.map((row) => row.kind).sort(),
      ["freeze-acquire", "freeze-release"],
      "capture adds only its two durable freeze receipts",
    );
    check(
      freezeReceipts.every(
        (row) => String(row.rowKey).startsWith("commit:") && row.freezeOwner === manifest.captureId,
      ),
      "capture receipts belong only to the captured freeze",
    );
    equal(
      await blobInventory(sourceFixture.storage),
      sourceBlobs,
      "capture preserves source blob bytes",
    );
    const sourceControl = sourceRows.find((row) => row.rowKey === "control")!;
    const releasedControl = afterCaptureRows.find((row) => row.rowKey === "control")!;
    equal(
      Object.fromEntries(
        Object.entries(releasedControl).filter(([property]) => property !== "revision"),
      ),
      Object.fromEntries(
        Object.entries(sourceControl).filter(([property]) => property !== "revision"),
      ),
      "capture preserves source control except its fenced revision",
    );
    equal(
      manifest.frozenRevision,
      Number(sourceControl.revision) + 1,
      "frozen revision fenced from source",
    );
    equal(
      releasedControl.revision,
      Number(sourceControl.revision) + 2,
      "release advances only freeze metadata",
    );
    check(releasedControl.writeMode === "normal", "capture releases only its freeze");

    targetFixture = await createRecoveryTarget(sourceFixture.options);
    const restoreStart = performance.now();
    const restored = await restoreStorageBackup(targetFixture.storage, destination.absolute, {});
    const restoreMs = performance.now() - restoreStart;
    equal(restored.manifest, manifest, "restore used the retained package manifest");
    check(restored.invalidatedSessions === 2, "both source web sessions intentionally omitted");
    const targetRows = await rows(targetFixture.storage);
    check(
      !targetRows.some((row) => String(row.rowKey).startsWith("session:")),
      "no source login session restored",
    );
    equal(
      targetRows.filter(
        (row) =>
          String(row.rowKey).startsWith(projectionPrefix) &&
          (String(row.rowKey).includes(":participant:") || String(row.rowKey).includes(":result:")),
      ),
      sourceProjections,
      "exact restored participant/result projections",
    );
    const targetControl = await targetFixture.storage.getEntity("control");
    check(
      typeof restored.dataEpoch === "string" && restored.dataEpoch.length > 0,
      "restore allocated data epoch",
    );
    equal(targetControl?.dataEpoch, restored.dataEpoch, "restored data epoch activated");
    check(
      restored.dataEpoch !== sourceRows.find((row) => row.rowKey === "control")?.dataEpoch,
      "restored epoch differs from source",
    );
    target = createAzureStores(targetFixture.options);
    await target.ready();
    const targetAuth = createAuth(target);
    targetApp = await buildApp({ stores: target.stores, googleAuth: targetAuth });
    await request(targetApp, owner.sessionToken, clubId, "GET", "/api/players", 401);
    const recoveredOwner = await targetAuth.completeAuthorization("owner");
    equal(
      recoveredOwner.user.id,
      owner.user.id,
      "same Google subject retains original opaque account ID",
    );
    const recoveredOutsider = await targetAuth.completeAuthorization("outsider");
    await request(targetApp, recoveredOutsider.sessionToken, clubId, "GET", "/api/players", 403);
    await request(
      targetApp,
      recoveredOutsider.sessionToken,
      clubId,
      "GET",
      `/api/game-sessions/${completedId}`,
      403,
    );
    const targetRequest = (
      method: "GET" | "POST" | "PUT" | "DELETE",
      url: string,
      status: number,
      payload?: object,
    ) => request(targetApp!, recoveredOwner.sessionToken, clubId, method, url, status, payload);
    check((await targetApp.inject("/health/ready")).statusCode === 200, "restored readiness");
    for (const [url, data] of expected)
      equal(await targetRequest("GET", url, 200), data, "exact authenticated API readback");
    equal(
      await target.stores.tournaments.list(clubId),
      [tournament],
      "restored tournament metadata through real application reader",
    );
    equal(
      await target.stores.games.readStatisticsInputs(clubId),
      statisticsSource,
      "restored coherent statistics input including retired participants",
    );
    equal(
      (await target.stores.games.get(completedId, clubId))?.tournamentId,
      tournament.id,
      "restored completed-game assignment",
    );
    const canonical = (await targetRequest("GET", `/api/game-sessions/${completedId}`, 200))
      .session as { state: typeof state; results: typeof results };
    equal(
      canonical.state,
      JSON.parse(JSON.stringify(state)),
      "canonical snapshot retains exact accepted wire IDs/history/settings",
    );
    equal(canonical.results, results, "exact accepted result snapshot");
    equal(
      hashGameState(
        replayGameLog(canonical.state.initialGame, canonical.state.events, completedId).game,
      ),
      hashGameState(game),
      "real canonical replay",
    );
    equal(
      hashGameState(canonical.state.game),
      events.at(-1)!.stateHashAfter,
      "canonical state hash retained",
    );
    const hostEvents = (await targetRequest("GET", `/api/games/${completedId}/events`, 200))
      .events as Array<Row>;
    const publicEvents = (
      await targetRequest("GET", `/api/games/${completedId}/events?visibility=public`, 200)
    ).events as Array<Row>;
    equal(
      hostEvents.map((event) => event.payload),
      events.map((event) => event.payload),
      "host sees exact secret payloads",
    );
    equal(
      publicEvents.map((event) => event.payload),
      events.map((event) =>
        isSecretGameEventType(event.type) ? { redacted: true } : event.payload,
      ),
      "public secret payload redaction",
    );
    check(
      publicEvents.every((event) => event.stateHashAfter === null),
      "public projection hides replay hashes",
    );
    const history = await targetRequest(
      "GET",
      `/api/game-sessions?status=completed&from=2026-09-26&to=2026-09-26&playerId=${roster[1]!}&outcome=draw`,
      200,
    );
    equal(
      (history.sessions as Array<Row>).map((row) => row.gameId),
      [completedId],
      "inclusive UTC/player/outcome history filters",
    );
    equal(
      (await targetRequest("GET", "/api/game-sessions?status=completed&to=2026-09-25", 200))
        .sessions,
      [],
      "exclusive earlier-date history",
    );
    const profiles = (await targetRequest("GET", "/api/players", 200)).players as Array<{
      id: string;
      lastPlayedAt: string | null;
      statistics: Row;
    }>;
    const peer = profiles.find((row) => row.id === roster[1]);
    check(
      peer?.statistics.gamesPlayed === 1 &&
        peer.statistics.wins === 0 &&
        peer.statistics.losses === 0,
      "restored surviving-player draw statistics",
    );
    equal(peer?.lastPlayedAt, results.playedAt, "restored last-played timestamp");
    check(
      profiles.find((row) => row.id === hostId)?.statistics.hostedGames === 1,
      "restored host statistics",
    );
    check(
      !profiles.some((row) => row.id === roster[0]),
      "retired identity absent from player directory",
    );
    const retiredRow = await targetFixture.storage.getEntity(
      `${projectionPrefix}player:${roster[0]!}`,
    );
    check(
      retiredRow?.retiredAt instanceof Date &&
        retiredRow.nickname === undefined &&
        retiredRow.email === undefined,
      "retired opaque identity retained without erased profile",
    );
    await targetRequest("POST", "/api/game-sessions", 409, {
      creationId: randomUUID(),
      name: "No retired reactivation",
      state: { setup: { selectedPlayerIds: [roster[0]!] }, events: [] },
      results: null,
    });
    const replacement = await targetRequest("POST", "/api/players", 201, {
      nickname: "Synthetic seat 1",
      consent: false,
    });
    check(
      (replacement.player as { id: string }).id !== roster[0],
      "nickname reuse allocates new identity",
    );
    await targetRequest("GET", `/api/game-sessions/${deletedId}`, 404);
    await targetRequest("PUT", `/api/game-sessions/${deletedId}`, 404, {
      mutationId: randomUUID(),
      name: "No resurrection",
      state: { events: [] },
      results: null,
    });
    await targetRequest("POST", "/api/game-sessions", 410, deletedPayload);
    const savedState = {
      ...partialState,
      playlistId: "restored-new-playlist",
      setup: {
        ...partialState.setup,
        selectedPlayerIds: [roster[2]!, "", "", "", "", "", "", "", "", ""],
      },
    };
    const saved = await targetRequest("PUT", `/api/game-sessions/${partialId}`, 200, {
      mutationId: randomUUID(),
      name: "Resumed after restore",
      state: savedState,
      results: null,
    });
    equal(saved.revision, 2, "new restored-target save increments original revision");
    const savedReadback = (await targetRequest("GET", `/api/game-sessions/${partialId}`, 200))
      .session as Row;
    equal(savedReadback.state, savedState, "new write durably readable");
    const creationRetry = await targetRequest("POST", "/api/game-sessions", 200, {
      creationId: partialCreation,
      name: "Old creation retry",
      state: partialState,
      results: null,
    });
    check(
      creationRetry.gameId === partialId &&
        creationRetry.duplicate === true &&
        creationRetry.revision === 2,
      "restored creation mapping preserves latest snapshot",
    );
    equal(creationRetry.state, savedState, "creation retry cannot revert new save");
    equal(
      creationRetry.tournamentId,
      tournament.id,
      "restored initial retry and ordinary save retain tournament metadata",
    );
    equal(
      await rows(sourceFixture.storage),
      afterCaptureRows,
      "restore and all target APIs leave source entities untouched",
    );
    equal(
      await blobInventory(sourceFixture.storage),
      sourceBlobs,
      "target writes leave source blobs untouched",
    );
    equal(
      (await sourceRequest("GET", `/api/game-sessions/${partialId}`, 200)).session,
      expected.get(`/api/game-sessions/${partialId}`)!.session,
      "source session still usable and original snapshot unchanged",
    );
    equal(
      createHash("sha256")
        .update(await readFile(join(destination.absolute, "manifest.json")))
        .digest("hex"),
      manifestSha256,
      "retained independent backup manifest unchanged",
    );
    return {
      backend: "owned-local-azurite",
      backupDirectory: destination.relative,
      manifestSha256,
      captureId: manifest.captureId,
      frozenRevision: manifest.frozenRevision,
      entityCount: manifest.entityCount,
      blobCount: manifest.blobCount,
      invalidatedSessions: restored.invalidatedSessions,
      captureMs,
      freezeMs,
      restoreMs,
      elapsedMs: performance.now() - started,
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
    };
  } finally {
    // Nested finally guarantees both owned emulators are closed even after a close error.
    try {
      await targetApp?.close();
    } finally {
      try {
        await sourceApp?.close();
      } finally {
        try {
          await target?.end();
        } finally {
          try {
            await source?.end();
          } finally {
            try {
              await targetFixture?.close();
            } finally {
              await sourceFixture.close();
            }
          }
        }
      }
    }
  }
};

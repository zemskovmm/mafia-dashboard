/* global URL, structuredClone */
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import * as contracts from "./session-verifier-contracts.mjs";
import {
  assertEnvelopeMatchesSession,
  assertSessionPostcondition,
  createAsyncTracker,
  runCleanupActions,
} from "./session-verifier-contracts.mjs";

const ids = {
  game: "00000000-0000-4000-8000-000000000001",
  root: "00000000-0000-4000-8000-000000000002",
  turn: "00000000-0000-4000-8000-000000000003",
  mutation: "00000000-0000-4000-8000-000000000004",
};

const baseline = { replayVersion: 1, game: { phase: "day", day: 1, turn: 0 } };
const entries = [
  { id: ids.root, gameId: ids.game, parentEventId: null, sequence: 1, type: "game.started" },
  {
    id: ids.turn,
    gameId: ids.game,
    parentEventId: ids.root,
    sequence: 2,
    type: "turn.completed",
  },
];
const replay = (_baseline, activeEntries) => ({
  game: { phase: "day", day: 1, turn: activeEntries.length - 1 },
});
const envelope = {
  version: 4,
  gameId: ids.game,
  revision: 7,
  name: "Verifier table",
  metadata: {
    setup: null,
    hostPlayerId: "host-player",
    hostName: "Host",
    playlistId: "playlist",
    legacyLog: [],
  },
  game: { phase: "day", day: 1, turn: 1 },
  undoBudget: 2,
  baseline,
  entries,
  headEventId: ids.turn,
  resetReturnEventId: null,
  results: null,
  outbox: [],
};
const session = {
  gameId: ids.game,
  name: "Verifier table",
  revision: 7,
  status: "active",
  results: null,
  state: {
    ...envelope.metadata,
    game: { phase: "day", day: 1, turn: 1 },
    undoBudget: 2,
    initialGame: baseline,
    events: entries,
    headEventId: ids.turn,
    resetReturnEventId: null,
  },
};

const clone = (value) => structuredClone(value);

const temporaryDirectory = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mafia-session-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

test("restart rendezvous is opt-in and exchanges fresh empty markers", async (t) => {
  await assert.doesNotReject(() => contracts.awaitRestartRendezvous({ directory: undefined }));

  const directory = await temporaryDirectory(t);
  const rendezvous = contracts.awaitRestartRendezvous({ directory, timeoutMs: 1_000 });
  await assert.doesNotReject(async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await access(join(directory, "ready"));
        return;
      } catch {
        await delay(5);
      }
    }
    throw new Error("ready marker was not created");
  });
  assert.equal(await readFile(join(directory, "ready"), "utf8"), "");
  await writeFile(join(directory, "continue"), "", { flag: "wx" });
  await assert.doesNotReject(() => rendezvous);
});

test("restart rendezvous rejects stale markers and times out without secrets", async (t) => {
  const staleDirectory = await temporaryDirectory(t);
  await writeFile(join(staleDirectory, "continue"), "", { flag: "wx" });
  await assert.rejects(
    () => contracts.awaitRestartRendezvous({ directory: staleDirectory, timeoutMs: 50 }),
    /stale restart rendezvous marker: continue/i,
  );

  const timeoutDirectory = await temporaryDirectory(t);
  const secret = "mafia_session=must-not-appear";
  await assert.rejects(
    () =>
      contracts.awaitRestartRendezvous({
        directory: timeoutDirectory,
        timeoutMs: 20,
        diagnosticLabel: secret,
      }),
    (error) => {
      assert.match(error.message, /timed out waiting for application restart/i);
      assert.doesNotMatch(error.message, /must-not-appear/);
      return true;
    },
  );
});

test("verifier credentials are strict and never repeated in errors", () => {
  assert.deepEqual(contracts.parseVerifierAuthCookie("mafia_session=opaque=value"), {
    name: "mafia_session",
    value: "opaque=value",
  });
  assert.equal(contracts.parseVerifierAuthCookie(undefined), null);
  assert.throws(
    () => contracts.parseVerifierAuthCookie("must-not-appear", { required: true }),
    (error) => {
      assert.match(error.message, /name=value/i);
      assert.doesNotMatch(error.message, /must-not-appear/);
      return true;
    },
  );
  assert.equal(
    contracts.parseVerifierClubId("00000000-0000-4000-8000-000000000101"),
    "00000000-0000-4000-8000-000000000101",
  );
  assert.throws(() => contracts.parseVerifierClubId("not-a-club"), /UUID/i);
});

test("durable browser storage keys isolate non-default clubs", () => {
  const defaultClub = "00000000-0000-4000-8000-000000000101";
  const otherClub = "00000000-0000-4000-8000-000000000102";

  assert.equal(
    contracts.gameSessionStorageKeyForClub(defaultClub),
    "mafia-dashboard.game-session.v4",
  );
  assert.equal(
    contracts.gameSessionStorageKeyForClub(otherClub),
    `mafia-dashboard.game-session.v4.${otherClub}`,
  );
});

test("read-only verifier policy permits safe navigation and blocks every mutation", () => {
  const expectedOrigin = "https://mafia.example.test";
  assert.deepEqual(
    contracts.classifyReadOnlyVerifierRequest({
      method: "GET",
      url: `${expectedOrigin}/api/music/playlists`,
      expectedOrigin,
    }),
    { kind: "same-origin-api" },
  );
  assert.deepEqual(
    contracts.classifyReadOnlyVerifierRequest({
      method: "GET",
      url: "https://www.youtube.com/iframe_api",
      expectedOrigin,
    }),
    { kind: "external-safe" },
  );
  assert.throws(
    () =>
      contracts.classifyReadOnlyVerifierRequest({
        method: "POST",
        url: `${expectedOrigin}/api/game-sessions`,
        expectedOrigin,
      }),
    /unsafe/i,
  );
  assert.throws(
    () =>
      contracts.classifyReadOnlyVerifierRequest({
        method: "GET",
        url: "https://evil.example/api/music/playlists",
        expectedOrigin,
      }),
    /origin mismatch/i,
  );
});

test("playlist selection requests require exact routing and the selected target", () => {
  const request = {
    method: "GET",
    url: "https://mafia.example.test/api/music/playlists/playlist/items",
    expectedOrigin: "https://mafia.example.test",
    expectedPath: "/api/music/playlists/playlist/items",
    selectedPlaylistId: "playlist",
    expectedPlaylistId: "playlist",
  };

  assert.equal(contracts.isExactPlaylistSelectionRequest(request), true);
  assert.equal(
    contracts.isExactPlaylistSelectionRequest({ ...request, selectedPlaylistId: "" }),
    false,
  );
  assert.equal(
    contracts.isExactPlaylistSelectionRequest({ ...request, url: `${request.url}?stale=1` }),
    false,
  );
  assert.equal(contracts.isExactPlaylistSelectionRequest({ ...request, method: "POST" }), false);
  assert.equal(
    contracts.isExactPlaylistSelectionRequest({
      ...request,
      url: "https://other.example.test/api/music/playlists/playlist/items",
    }),
    false,
  );
});

test("exact origin guards reject matching API paths on another origin", () => {
  assert.doesNotThrow(() =>
    contracts.assertExactOrigin("https://verified.example/api/clubs", "https://verified.example"),
  );
  assert.throws(
    () =>
      contracts.assertExactOrigin("https://attacker.example/api/clubs", "https://verified.example"),
    /origin/i,
  );
});

test("remote verifier targets require an isolated opt-in and exact HTTPS origin", () => {
  const valid = {
    configuredUrl: "https://verified.example",
    browserUrl: "https://verified.example/dashboard",
    remoteAllowed: true,
    expectedOrigin: "https://verified.example",
  };
  assert.equal(contracts.assertVerifierTarget(valid), "https://verified.example");
  assert.throws(
    () => contracts.assertVerifierTarget({ ...valid, remoteAllowed: false }),
    /isolated/i,
  );
  assert.throws(
    () => contracts.assertVerifierTarget({ ...valid, expectedOrigin: "https://verified.example/" }),
    /exact expected origin/i,
  );
  assert.throws(
    () =>
      contracts.assertVerifierTarget({
        ...valid,
        configuredUrl: "http://verified.example",
        browserUrl: "http://verified.example",
        expectedOrigin: "http://verified.example",
      }),
    /HTTPS/i,
  );
});

test("IPv6 loopback remains a local verifier target without remote opt-in", () => {
  assert.equal(
    contracts.assertVerifierTarget({
      configuredUrl: "http://[::1]:8080",
      browserUrl: "http://[::1]:8080/dashboard",
      remoteAllowed: false,
    }),
    "http://[::1]:8080",
  );
});

test("verifier targets reject browser and API deployment identity splits", () => {
  assert.throws(
    () =>
      contracts.assertVerifierTarget({
        configuredUrl: "https://verified.example",
        browserUrl: "https://localhost:8443",
        remoteAllowed: true,
        expectedOrigin: "https://verified.example",
      }),
    /browser\/API origin mismatch/i,
  );
  assert.throws(
    () =>
      contracts.assertVerifierTarget({
        configuredUrl: "http://127.0.0.1:8080",
        browserUrl: "http://localhost:8080",
        remoteAllowed: false,
      }),
    /browser\/API origin mismatch/i,
  );
});

test("authoritative game snapshot saves require the exact phase and full-snapshot contract", () => {
  const valid = {
    method: "PUT",
    pathname: `/api/game-sessions/${ids.game}`,
    expectedPhase: "day",
    body: {
      state: {
        game: { phase: "day" },
        events: [{ type: "game.started", parentEventId: null }],
      },
      results: null,
    },
  };

  assert.equal(contracts.isAuthoritativeGameSnapshotRequest(valid), true);
  for (const candidate of [
    { ...valid, method: "POST" },
    { ...valid, pathname: `${valid.pathname}/start` },
    { ...valid, pathname: `${valid.pathname}?unreviewed=1` },
    { ...valid, expectedPhase: "night" },
    { ...valid, body: { ...valid.body, state: { ...valid.body.state, game: { phase: "night" } } } },
    { ...valid, body: { ...valid.body, state: { ...valid.body.state, events: null } } },
    {
      ...valid,
      body: {
        ...valid.body,
        state: {
          ...valid.body.state,
          events: [{ type: "phase.changed", parentEventId: ids.root }],
        },
      },
    },
    { ...valid, body: { ...valid.body, results: { winner: "red" } } },
  ]) {
    assert.equal(contracts.isAuthoritativeGameSnapshotRequest(candidate), false);
  }
});

test("browser API policy blocks unexpected unsafe requests and unowned sessions", () => {
  const gameId = "00000000-0000-4000-8000-000000000201";
  const ownedGameIds = new Set([gameId]);
  const classify = (method, path) =>
    contracts.classifyBrowserApiRequest({
      method,
      url: `https://verified.example${path}`,
      expectedOrigin: "https://verified.example",
      ownedGameIds,
    });

  assert.deepEqual(classify("GET", "/api/players"), { kind: "safe" });
  assert.deepEqual(
    contracts.classifyBrowserApiRequest({
      method: "GET",
      url: "https://fonts.googleapis.com/css2",
      expectedOrigin: "https://verified.example",
      ownedGameIds,
    }),
    { kind: "external-safe" },
  );
  assert.throws(
    () => classify("POST", `/api/game-sessions/${gameId}/events`),
    /unexpected unsafe browser request/i,
  );
  assert.throws(
    () => classify("POST", `/api/game-sessions/${gameId}/events?unreviewed=1`),
    /unexpected unsafe browser request/i,
  );
  assert.throws(() => classify("DELETE", "/api/players/not-owned"), /unsafe browser request/i);
  assert.throws(() => classify("POST", "/unreviewed-write"), /unsafe browser request/i);
  assert.throws(() => classify("POST", "/api"), /unsafe browser request/i);
  assert.throws(
    () => classify("POST", "/api/game-sessions/00000000-0000-4000-8000-000000000202/events"),
    /unexpected unsafe browser request/i,
  );
  assert.throws(
    () =>
      contracts.classifyBrowserApiRequest({
        method: "GET",
        url: "https://attacker.example/api/players",
        expectedOrigin: "https://verified.example",
        ownedGameIds,
      }),
    /origin mismatch/i,
  );
});

test("browser API policy exposes only exact session creation and owned mutation routes", () => {
  const ownedId = "00000000-0000-4000-8000-000000000201";
  const newId = "00000000-0000-4000-8000-000000000202";
  const classify = (method, path) =>
    contracts.classifyBrowserApiRequest({
      method,
      url: `https://verified.example${path}`,
      expectedOrigin: "https://verified.example",
      ownedGameIds: new Set([ownedId]),
    });

  assert.deepEqual(classify("PUT", `/api/game-sessions/${newId}`), {
    kind: "session-creation",
    gameId: newId,
  });
  assert.deepEqual(classify("PUT", `/api/game-sessions/${ownedId}`), {
    kind: "owned-session-mutation",
    gameId: ownedId,
  });
  assert.deepEqual(classify("DELETE", `/api/game-sessions/${ownedId}?expectedRevision=7`), {
    kind: "owned-session-mutation",
    gameId: ownedId,
  });
  for (const [method, action] of [
    ["POST", "claim"],
    ["POST", "takeover"],
    ["DELETE", "claim"],
  ]) {
    assert.deepEqual(classify(method, `/api/game-sessions/${ownedId}/${action}`), {
      kind: "owned-session-mutation",
      gameId: ownedId,
    });
    assert.throws(
      () => classify(method, `/api/game-sessions/${newId}/${action}`),
      /unowned game session/i,
    );
  }
  assert.throws(
    () => classify("DELETE", `/api/game-sessions/${newId}?expectedRevision=7`),
    /unowned game session/i,
  );
  assert.throws(() => classify("PATCH", `/api/game-sessions/${ownedId}`), /unexpected unsafe/i);
});

test("ownership checks canonicalize case-variant UUID references before dispatch", () => {
  const gameId = "a0000000-0000-4000-8000-000000000201";
  const requestId = gameId.toUpperCase();
  const classify = (ownedGameIds) =>
    contracts.classifyBrowserApiRequest({
      method: "PUT",
      url: `https://verified.example/api/game-sessions/${requestId}`,
      expectedOrigin: "https://verified.example",
      ownedGameIds,
    });

  const candidate = classify(new Set());
  assert.deepEqual(candidate, { kind: "session-creation", gameId });
  assert.equal(new Set([gameId]).has(candidate.gameId), true);
  assert.deepEqual(classify(new Set([gameId])), { kind: "owned-session-mutation", gameId });
  assert.throws(
    () =>
      contracts.assertNewResource({
        label: "player",
        status: 201,
        id: requestId,
        preexistingIds: new Set([gameId]),
      }),
    /pre-existing ID/i,
  );
});

test("ownership snapshots reject duplicate and pre-existing creation names", () => {
  assert.doesNotThrow(() =>
    contracts.assertNamesAvailable(["Verifier One", "Verifier Two"], ["Existing Player"]),
  );
  assert.throws(
    () => contracts.assertNamesAvailable(["Verifier One", "Verifier One"], []),
    /duplicate requested name/i,
  );
  assert.throws(
    () => contracts.assertNamesAvailable(["Verifier One"], ["Verifier One"]),
    /pre-existing name/i,
  );
});

test("created-resource ownership requires 201, the requested ID, and snapshot absence", () => {
  const requestedId = "00000000-0000-4000-8000-000000000202";
  const candidate = {
    label: "game session",
    status: 201,
    id: requestedId,
    expectedId: requestedId,
    preexistingIds: new Set(["00000000-0000-4000-8000-000000000201"]),
  };
  assert.equal(contracts.assertNewResource(candidate), requestedId);
  assert.throws(() => contracts.assertNewResource({ ...candidate, status: 200 }), /201 Created/i);
  assert.throws(
    () =>
      contracts.assertNewResource({
        ...candidate,
        id: "00000000-0000-4000-8000-000000000203",
      }),
    /requested ID/i,
  );
  assert.throws(
    () => contracts.assertNewResource({ ...candidate, preexistingIds: new Set([requestedId]) }),
    /pre-existing ID/i,
  );
  assert.throws(
    () => contracts.assertNewResource({ ...candidate, claimedIds: new Set([requestedId]) }),
    /already claimed/i,
  );
});

test("durable envelopes must match the complete authoritative canonical session", async (t) => {
  assert.doesNotThrow(() => assertEnvelopeMatchesSession(envelope, session, replay));

  const mismatches = {
    revision: [clone(envelope), { ...clone(session), revision: 8 }],
    status: [clone(envelope), { ...clone(session), status: "completed" }],
    results: [clone(envelope), { ...clone(session), results: { winner: "red" } }],
    name: [clone(envelope), { ...clone(session), name: "Other table" }],
    metadata: [
      clone(envelope),
      { ...clone(session), state: { ...clone(session.state), playlistId: "other" } },
    ],
    baseline: [
      clone(envelope),
      { ...clone(session), state: { ...clone(session.state), initialGame: null } },
    ],
    entries: [
      clone(envelope),
      { ...clone(session), state: { ...clone(session.state), events: entries.slice(0, 1) } },
    ],
    head: [
      clone(envelope),
      { ...clone(session), state: { ...clone(session.state), headEventId: ids.root } },
    ],
    "reset return": [
      clone(envelope),
      { ...clone(session), state: { ...clone(session.state), resetReturnEventId: ids.turn } },
    ],
    game: [
      { ...clone(envelope), game: { phase: "day", day: 1, turn: 0 } },
      {
        ...clone(session),
        state: clone(session.state),
      },
    ],
  };
  for (const [name, [candidateEnvelope, candidateSession]] of Object.entries(mismatches)) {
    await t.test(name, () => {
      assert.throws(
        () => assertEnvelopeMatchesSession(candidateEnvelope, candidateSession, replay),
        new RegExp(name, "i"),
      );
    });
  }
});

test("durable envelopes normalize an omitted authoritative legacy log to empty", () => {
  const withoutLegacyLog = clone(session);
  delete withoutLegacyLog.state.legacyLog;
  assert.doesNotThrow(() => assertEnvelopeMatchesSession(envelope, withoutLegacyLog, replay));
});

test("authoritative readbacks must satisfy the fresh reset postcondition", () => {
  const expected = {
    gameId: ids.game,
    revision: 8,
    status: "active",
    results: null,
    headEventId: ids.root,
    resetReturnEventId: null,
    game: { phase: "day", day: 1, turn: 0 },
  };
  const readback = {
    ...session,
    revision: 8,
    state: {
      ...session.state,
      game: expected.game,
      headEventId: ids.root,
      resetReturnEventId: null,
    },
  };

  assert.doesNotThrow(() => assertSessionPostcondition(readback, expected, replay));
  assert.throws(
    () => assertSessionPostcondition({ ...readback, revision: 7 }, expected, replay),
    /revision/i,
  );
  assert.throws(
    () =>
      assertSessionPostcondition(
        { ...readback, state: { ...readback.state, game: { ...expected.game, turn: 1 } } },
        expected,
        replay,
      ),
    /game/i,
  );
});

test("async tracker waits for delayed work before reporting completion", async () => {
  const tracker = createAsyncTracker();
  let resolve;
  tracker.track(
    "late response",
    new Promise((nextResolve) => {
      resolve = nextResolve;
    }),
  );
  let drained = false;
  const draining = tracker.drain().then(() => {
    drained = true;
  });

  await Promise.resolve();
  assert.equal(drained, false);
  resolve();
  await draining;
  assert.equal(drained, true);
});

test("async tracker surfaces delayed failures with their operation label", async () => {
  const tracker = createAsyncTracker();
  let reject;
  tracker.track(
    "late retry readback",
    new Promise((_resolve, nextReject) => {
      reject = nextReject;
    }),
  );
  const draining = tracker.drain();
  reject(new Error("stale revision"));

  await assert.rejects(draining, /late retry readback.*stale revision/i);
});

test("async tracker retains failures that settle between drains", async () => {
  const tracker = createAsyncTracker();
  await tracker.drain();

  tracker.track("late retry readback", Promise.reject(new Error("HTTP 500")));
  await delay(0);

  await assert.rejects(tracker.drain(), /late retry readback.*HTTP 500/i);
  await tracker.drain();
});

test("async tracker reports failures in registration order", async () => {
  const tracker = createAsyncTracker();
  let rejectFirst;
  tracker.track(
    "first request",
    new Promise((_resolve, reject) => {
      rejectFirst = reject;
    }),
  );
  tracker.track("second request", Promise.reject(new Error("second failed")));
  const draining = tracker.drain();
  await delay(0);
  rejectFirst(new Error("first failed"));

  await assert.rejects(draining, (error) => {
    assert(error instanceof AggregateError);
    assert.deepEqual(
      error.errors.map(({ message }) => message),
      ["first request: first failed", "second request: second failed"],
    );
    return true;
  });
});

test("cleanup runs every action and aggregates labeled failures in order", async () => {
  const calls = [];
  await assert.rejects(
    runCleanupActions([
      {
        label: "sessions",
        run: async () => {
          calls.push("sessions");
          throw new Error("session remains");
        },
      },
      {
        label: "players",
        run: async () => {
          calls.push("players");
        },
      },
      {
        label: "browser",
        run: async () => {
          calls.push("browser");
          throw new Error("browser close failed");
        },
      },
    ]),
    (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map(({ message }) => message),
        ["sessions: session remains", "browser: browser close failed"],
      );
      return true;
    },
  );
  assert.deepEqual(calls, ["sessions", "players", "browser"]);
});

test("exact cleanup deletes a proven ID even when listings omit it and confirms absence", async () => {
  const statuses = [204, 404];
  let calls = 0;
  await contracts.deleteAndVerifyAbsent("verification player", async () => {
    calls += 1;
    return statuses.shift();
  });
  assert.equal(calls, 2);

  await assert.rejects(
    contracts.deleteAndVerifyAbsent("verification player", async () => 204),
    /remains after cleanup/i,
  );
  await assert.rejects(
    contracts.deleteAndVerifyAbsent("verification player", async () => 500),
    /HTTP 500/i,
  );
});

test("runtime verifiers enforce the shared contracts at their success boundaries", async () => {
  const [sessionVerifier, uiVerifier, composeVerifier, oauthVerifier] = await Promise.all([
    readFile(new URL("./verify-session-state.mjs", import.meta.url), "utf8"),
    readFile(new URL("./verify-ui.mjs", import.meta.url), "utf8"),
    readFile(new URL("./verify-production-compose.mjs", import.meta.url), "utf8"),
    readFile(new URL("./verify-oauth.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(sessionVerifier, /assertSessionPostcondition\(resetReadback/);
  assert.match(sessionVerifier, /authoritativeSession = resetReadback/);
  assert.match(sessionVerifier, /assertEnvelopeMatchesSession\(restoredEnvelope/);
  assert.match(sessionVerifier, /await waitForSaved\(startSave\)/);
  assert.match(sessionVerifier, /responseTracker\.drain\(\)/);
  assert.match(sessionVerifier, /runCleanupActions\(/);
  assert.match(sessionVerifier, /deleteAndVerifyAbsent\(/);
  assert.match(sessionVerifier, /assertVerifierTarget\(/);
  assert.match(sessionVerifier, /classifyBrowserApiRequest\(/);
  assert.match(sessionVerifier, /origin: targetUrl\.origin/);
  assert.match(sessionVerifier, /context\.route\("\*\*\/\*"/);
  assert.match(sessionVerifier, /assertNamesAvailable\(/);
  assert.match(sessionVerifier, /assertNewResource\(/);
  assert.match(sessionVerifier, /isAuthoritativeGameSnapshotRequest\(/);
  assert.match(
    sessionVerifier,
    /const startSave = waitForSnapshot\("mafia-planning"\);[\s\S]*Begin Mafia planning stage[\s\S]*await waitForSaved\(startSave\);[\s\S]*Continue night zero to Sheriff wake-up[\s\S]*const beginDay = [\s\S]*Begin day one[\s\S]*await beginDay\.waitFor\(\);[\s\S]*const daySave = waitForSnapshot\("day"\);[\s\S]*await beginDay\.click\(\);[\s\S]*await waitForSaved\(daySave\);/,
  );
  assert.match(sessionVerifier, /Open Manage menu/);
  assert.match(sessionVerifier, /const acceptedEvent = activeEvents\.at\(-1\)/);
  assert.match(sessionVerifier, /waitForAuthoritativePhase\(/);
  assert.match(
    sessionVerifier,
    /const \{ session: storedSession \} = await storedResponse\.json\(\);[\s\S]*await awaitRestartRendezvous\([\s\S]*const restartedSession = await readAuthoritativeSession\([\s\S]*isDeepStrictEqual\(restartedSession, storedSession\)[\s\S]*const resetResponse = await apiContext\.put/,
  );
  assert.match(sessionVerifier, /SESSION_RESTART_GATE_DIR/);
  assert.match(sessionVerifier, /SESSION_RESTART_TIMEOUT_MS/);
  assert.match(sessionVerifier, /const ownedClaims = new Map\(\)/);
  assert.match(sessionVerifier, /baseRevision: storedSession\.revision/);
  assert.match(sessionVerifier, /headers: claimHeaders/);
  assert.match(sessionVerifier, /Game already controlled/);
  assert.match(sessionVerifier, /button", \{ name: "Take over"/);
  assert.match(sessionVerifier, /gameSessionStorageKeyForClub\(clubId\)/);
  assert.equal(sessionVerifier.match(/window\.localStorage\.getItem\(storageKey\)/g)?.length, 2);
  assert.match(uiVerifier, /assertExactOrigin\(route\.request\(\)\.url\(\), expectedOrigin\)/);
  assert.match(uiVerifier, /await unlockDeveloperMenu\(page\)/);
  assert.match(uiVerifier, /snapshotRevision \+= 1/);
  assert.match(uiVerifier, /Destructive snapshot Reset failed/);
  assert.match(uiVerifier, /rootCheckpoint\?\.phaseAfter !== "mafia-planning"/);
  assert.match(uiVerifier, /dayCheckpoint\?\.phaseAfter !== "day"/);
  assert.match(composeVerifier, /origin: `http:\/\/127\.0\.0\.1:\$\{port\}`/);
  assert.match(composeVerifier, /\/tmp\/mafia-app\.pid/);
  assert.match(composeVerifier, /kill -KILL/);
  assert.match(composeVerifier, /restartCountAfter <= restartCountBefore/);
  assert.match(
    composeVerifier,
    /spawn\(process\.execPath, \["scripts\/verify-session-state\.mjs"\]/,
  );
  assert.match(composeVerifier, /SESSION_RESTART_GATE_DIR: restartGateDirectory/);
  assert.match(composeVerifier, /SESSION_AUTH_COOKIE: `mafia_session=\$\{sessionToken\}`/);
  const childLaunch = composeVerifier.indexOf("spawn(process.execPath");
  const readyWait = composeVerifier.indexOf('waitForMarker("ready")');
  const kill = composeVerifier.lastIndexOf('sigkillContainerProcess("app")');
  const readiness = composeVerifier.lastIndexOf("await waitUntilReady()");
  const continuation = composeVerifier.indexOf('writeRestartMarker("continue")');
  assert.ok(
    childLaunch < readyWait && readyWait < kill && kill < readiness && readiness < continuation,
  );
  assert.match(composeVerifier, /await sessionVerifierResult/);
  assert.match(oauthVerifier, /assertVerifierTarget\(/);
  assert.match(oauthVerifier, /parseVerifierAuthCookie\(/);
  assert.match(oauthVerifier, /parseVerifierClubId\(/);
  assert.match(oauthVerifier, /classifyReadOnlyVerifierRequest\(/);
  assert.match(oauthVerifier, /\/api\/auth\/session/);
  assert.match(oauthVerifier, /\/api\/clubs/);
  assert.match(oauthVerifier, /\/api\/music\/playlists\/\$\{encodeURIComponent/);
  assert.match(oauthVerifier, /Open \$\{selectedClub\.name\} in \$\{selectedClub\.city\}/);
  assert.match(oauthVerifier, /Open Manage menu/);
  assert.match(oauthVerifier, /Music player setup/);
  assert.match(oauthVerifier, /isExactPlaylistSelectionRequest/);
  assert.match(oauthVerifier, /waitForRequest/);
  assert.match(oauthVerifier, /Playlist required/);
  assert.match(
    oauthVerifier,
    /itemsResponse\.finished\(\)[\s\S]*waitForLoadState\("networkidle"\)[\s\S]*requestErrors\.length/,
  );
  assert.doesNotMatch(oauthVerifier, /\.player-input-grid select/);
  assert.doesNotMatch(oauthVerifier, /Continue to music/);
  assert.doesNotMatch(oauthVerifier, /Start table music/);
  assert.doesNotMatch(oauthVerifier, /Ready · paused/);
  assert.doesNotMatch(oauthVerifier, /waitForResponse/);
  assert.doesNotMatch(oauthVerifier, /OAUTH_SCREENSHOT|page\.screenshot/);
  assert.doesNotMatch(oauthVerifier, /\$\{pathname\} failed/);
});

/* global URL, structuredClone */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertEnvelopeMatchesSession,
  assertHeadOperation,
  assertSessionPostcondition,
  createAsyncTracker,
  createHeadOperationExpectations,
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
    initialGame: baseline,
    events: entries,
    headEventId: ids.turn,
    resetReturnEventId: null,
  },
};

const clone = (value) => structuredClone(value);

const validHeadOperation = {
  mutationId: ids.mutation,
  baseRevision: 7,
  targetEventId: ids.root,
  reason: "reset",
};
const expectedHeadOperation = {
  baseRevision: 7,
  targetEventId: ids.root,
  reason: "reset",
};

test("head operations require the exact expected contract", async (t) => {
  assert.doesNotThrow(() => assertHeadOperation(validHeadOperation, expectedHeadOperation));

  const invalid = {
    "wrong target": { ...validHeadOperation, targetEventId: ids.turn },
    "wrong reason": { ...validHeadOperation, reason: "restore-reset" },
    "stale revision": { ...validHeadOperation, baseRevision: 6 },
    "missing mutation id": { ...validHeadOperation, mutationId: undefined },
    "invalid mutation id": { ...validHeadOperation, mutationId: "mutation" },
    "cumulative game snapshot": { ...validHeadOperation, game: { phase: "day" } },
    "unknown key": { ...validHeadOperation, extra: true },
  };
  for (const [name, operation] of Object.entries(invalid)) {
    await t.test(name, () => {
      assert.throws(() => assertHeadOperation(operation, expectedHeadOperation), /head operation/i);
    });
  }
});

test("head operation expectations are ordered and must be drained", () => {
  const expectations = createHeadOperationExpectations();
  expectations.expect(expectedHeadOperation);
  expectations.expect({ ...expectedHeadOperation, baseRevision: 8, reason: "restore-reset" });

  assert.throws(
    () =>
      expectations.consume({
        ...validHeadOperation,
        baseRevision: 8,
        reason: "restore-reset",
      }),
    /head operation/i,
  );
  expectations.consume(validHeadOperation);
  assert.throws(() => expectations.assertDrained(), /1 expected head operation/i);
  expectations.consume({
    ...validHeadOperation,
    baseRevision: 8,
    reason: "restore-reset",
  });
  assert.doesNotThrow(() => expectations.assertDrained());
  assert.throws(() => expectations.consume(validHeadOperation), /unexpected head operation/i);
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
    "replayed game": [
      clone(envelope),
      {
        ...clone(session),
        state: { ...clone(session.state), game: { phase: "day", day: 1, turn: 0 } },
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

test("authoritative readbacks must satisfy the fresh reset postcondition", () => {
  const expected = {
    gameId: ids.game,
    revision: 8,
    status: "active",
    results: null,
    headEventId: ids.root,
    resetReturnEventId: ids.turn,
    game: { phase: "day", day: 1, turn: 0 },
  };
  const readback = {
    ...session,
    revision: 8,
    state: {
      ...session.state,
      game: expected.game,
      headEventId: ids.root,
      resetReturnEventId: ids.turn,
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

test("runtime verifiers enforce the shared contracts at their success boundaries", async () => {
  const [sessionVerifier, uiVerifier] = await Promise.all([
    readFile(new URL("./verify-session-state.mjs", import.meta.url), "utf8"),
    readFile(new URL("./verify-ui.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(sessionVerifier, /assertSessionPostcondition\(resetReadback/);
  assert.match(sessionVerifier, /assertSessionPostcondition\(authoritativeSession/);
  assert.match(sessionVerifier, /assertEnvelopeMatchesSession\(restoredEnvelope/);
  assert.match(sessionVerifier, /await waitForSaved\(startSave\)/);
  assert.match(sessionVerifier, /await waitForSaved\(turnSave\)/);
  assert.match(sessionVerifier, /responseTracker\.drain\(\)/);
  assert.match(sessionVerifier, /runCleanupActions\(/);
  assert.match(uiVerifier, /headOperationExpectations\.consume\(operation\)/);
  assert.match(uiVerifier, /headOperationExpectations\.assertDrained\(\)/);
  assert.match(uiVerifier, /rootCheckpoint\?\.phaseAfter !== "mafia-planning"/);
  assert.match(uiVerifier, /dayCheckpoint\?\.phaseAfter !== "day"/);
});

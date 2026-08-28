import { isDeepStrictEqual } from "node:util";

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const headOperationKeys = ["baseRevision", "mutationId", "reason", "targetEventId"];

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

const assertEqual = (label, actual, expected) => {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(
      `Canonical session ${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
};

const activeEntriesFor = (entries, headEventId) => {
  if (headEventId === null) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const active = [];
  const seen = new Set();
  let eventId = headEventId;
  while (eventId !== null) {
    if (seen.has(eventId)) throw new Error("Canonical session entries contain a cycle");
    seen.add(eventId);
    const entry = byId.get(eventId);
    if (entry === undefined) {
      throw new Error(`Canonical session head is disconnected at ${eventId}`);
    }
    active.push(entry);
    eventId = entry.parentEventId;
  }
  return active.reverse();
};

const canonicalMetadata = (state) => ({
  setup: state.setup,
  hostPlayerId: state.hostPlayerId,
  hostName: state.hostName,
  playlistId: state.playlistId,
  legacyLog: state.legacyLog,
});

export const assertHeadOperation = (actual, expected) => {
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
    throw new Error("Head operation must be an object");
  }
  const actualKeys = Object.keys(actual).sort();
  if (!isDeepStrictEqual(actualKeys, headOperationKeys)) {
    throw new Error(
      `Head operation keys mismatch: expected ${headOperationKeys.join(", ")}, received ${actualKeys.join(", ")}`,
    );
  }
  if (typeof actual.mutationId !== "string" || !uuidPattern.test(actual.mutationId)) {
    throw new Error("Head operation mutationId must be a UUID");
  }
  for (const field of ["baseRevision", "targetEventId", "reason"]) {
    if (!isDeepStrictEqual(actual[field], expected[field])) {
      throw new Error(
        `Head operation ${field} mismatch: expected ${JSON.stringify(expected[field])}, received ${JSON.stringify(actual[field])}`,
      );
    }
  }
};

export const createHeadOperationExpectations = () => {
  const expected = [];
  return {
    expect(operation) {
      expected.push(operation);
    },
    consume(actual) {
      const next = expected[0];
      if (next === undefined)
        throw new Error("Unexpected head operation with no pending expectation");
      assertHeadOperation(actual, next);
      expected.shift();
    },
    assertDrained() {
      if (expected.length > 0) {
        throw new Error(`${expected.length} expected head operation(s) were not observed`);
      }
    },
  };
};

export const assertEnvelopeMatchesSession = (envelope, session, replay) => {
  assertEqual("game id", envelope.gameId, session.gameId);
  assertEqual("name", envelope.name, session.name);
  assertEqual("revision", envelope.revision, session.revision);
  assertEqual("status", envelope.results === null ? "active" : "completed", session.status);
  assertEqual("results", envelope.results, session.results);
  assertEqual("metadata", envelope.metadata, canonicalMetadata(session.state));
  assertEqual("baseline", envelope.baseline, session.state.initialGame);
  assertEqual("entries", envelope.entries, session.state.events);
  assertEqual("head", envelope.headEventId, session.state.headEventId);
  assertEqual("reset return", envelope.resetReturnEventId, session.state.resetReturnEventId);
  assertEqual("outbox", envelope.outbox, []);
  const activeEntries = activeEntriesFor(envelope.entries, envelope.headEventId);
  const replayed = replay(envelope.baseline, activeEntries);
  assertEqual("replayed game", replayed.game, session.state.game);
};

export const assertSessionPostcondition = (session, expected, replay) => {
  assertEqual("game id", session.gameId, expected.gameId);
  assertEqual("revision", session.revision, expected.revision);
  assertEqual("status", session.status, expected.status);
  assertEqual("results", session.results, expected.results);
  assertEqual("head", session.state.headEventId, expected.headEventId);
  assertEqual("reset return", session.state.resetReturnEventId, expected.resetReturnEventId);
  assertEqual("game", session.state.game, expected.game);
  const activeEntries = activeEntriesFor(session.state.events, session.state.headEventId);
  const replayed = replay(session.state.initialGame, activeEntries);
  assertEqual("replayed game", replayed.game, session.state.game);
};

export const createAsyncTracker = () => {
  const pending = new Set();
  return {
    track(label, work) {
      const tracked = Promise.resolve(work)
        .then(() => null)
        .catch((error) => new Error(`${label}: ${messageOf(error)}`, { cause: error }))
        .finally(() => pending.delete(tracked));
      pending.add(tracked);
    },
    async drain() {
      const errors = [];
      while (pending.size > 0) {
        const results = await Promise.all([...pending]);
        errors.push(...results.filter((result) => result instanceof Error));
      }
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          `Tracked verifier work failed: ${errors.map(({ message }) => message).join("; ")}`,
        );
      }
    },
  };
};

export const runCleanupActions = async (actions) => {
  const errors = [];
  for (const { label, run } of actions) {
    try {
      await run();
    } catch (error) {
      errors.push(new Error(`${label}: ${messageOf(error)}`, { cause: error }));
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Verifier cleanup failed");
};

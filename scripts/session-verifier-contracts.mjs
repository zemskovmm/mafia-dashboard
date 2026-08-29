/* global URL */
import { isDeepStrictEqual } from "node:util";

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const headOperationKeys = ["baseRevision", "mutationId", "reason", "targetEventId"];
const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const canonicalUuid = (value) => value.toLowerCase();

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

export const assertExactOrigin = (url, expectedOrigin) => {
  const actualOrigin = new URL(url).origin;
  if (actualOrigin !== expectedOrigin) {
    throw new Error(
      `Verifier request origin mismatch: expected ${expectedOrigin}, received ${actualOrigin}`,
    );
  }
};

export const assertVerifierTarget = ({
  configuredUrl,
  browserUrl,
  remoteAllowed,
  expectedOrigin,
}) => {
  const configured = new URL(configuredUrl);
  const browser = new URL(browserUrl);
  if (configured.origin !== browser.origin) {
    throw new Error(
      `Verifier browser/API origin mismatch: expected ${configured.origin}, received ${browser.origin}`,
    );
  }
  if (!localHosts.has(configured.hostname)) {
    if (!remoteAllowed) throw new Error("Remote verifier target requires explicit isolated opt-in");
    if (configured.protocol !== "https:") throw new Error("Remote verifier target requires HTTPS");
    if (
      typeof expectedOrigin !== "string" ||
      expectedOrigin !== new URL(expectedOrigin).origin ||
      expectedOrigin !== configured.origin
    ) {
      throw new Error("Remote verifier target requires an exact expected origin");
    }
  }
  return configured.origin;
};

export const classifyBrowserApiRequest = ({ method, url, expectedOrigin, ownedGameIds }) => {
  const normalizedMethod = method.toUpperCase();
  const requestUrl = new URL(url);
  if (["GET", "HEAD", "OPTIONS"].includes(normalizedMethod)) {
    if (requestUrl.origin === expectedOrigin) return { kind: "safe" };
    if (requestUrl.pathname === "/api" || requestUrl.pathname.startsWith("/api/")) {
      assertExactOrigin(requestUrl, expectedOrigin);
    }
    return { kind: "external-safe" };
  }

  assertExactOrigin(requestUrl, expectedOrigin);
  const { pathname } = requestUrl;
  const sessionRoot = pathname.match(/^\/api\/game-sessions\/([0-9a-f-]+)$/i);
  if (sessionRoot !== null && uuidPattern.test(sessionRoot[1])) {
    const gameId = canonicalUuid(sessionRoot[1]);
    if (normalizedMethod === "PUT" && requestUrl.search === "") {
      return ownedGameIds.has(gameId)
        ? { kind: "owned-session-mutation", gameId }
        : { kind: "session-creation", gameId };
    }
    if (normalizedMethod === "DELETE" && /^\?expectedRevision=\d+$/.test(requestUrl.search)) {
      if (!ownedGameIds.has(gameId)) {
        throw new Error("Refusing an unsafe browser request for an unowned game session");
      }
      return { kind: "owned-session-mutation", gameId };
    }
  }
  const sessionMutation = pathname.match(
    /^\/api\/game-sessions\/([0-9a-f-]+)\/(normalize|start|events|head|complete)$/i,
  );
  if (normalizedMethod === "POST" && sessionMutation !== null && requestUrl.search === "") {
    const gameId = canonicalUuid(sessionMutation[1]);
    if (!uuidPattern.test(gameId) || !ownedGameIds.has(gameId)) {
      throw new Error("Refusing an unsafe browser request for an unowned game session");
    }
    return { kind: "owned-session-mutation", gameId };
  }

  throw new Error(`Refusing unexpected unsafe browser request: ${normalizedMethod} ${pathname}`);
};

export const assertNamesAvailable = (requestedNames, existingNames) => {
  const requested = new Set();
  const existing = new Set(existingNames);
  for (const name of requestedNames) {
    if (requested.has(name)) throw new Error(`Duplicate requested name: ${name}`);
    if (existing.has(name)) throw new Error(`Refusing to reuse a pre-existing name: ${name}`);
    requested.add(name);
  }
};

export const assertNewResource = ({
  label,
  status,
  id,
  expectedId,
  preexistingIds,
  claimedIds = new Set(),
}) => {
  if (status !== 201) throw new Error(`${label} creation must return 201 Created`);
  if (typeof id !== "string" || !uuidPattern.test(id)) {
    throw new Error(`${label} creation returned an invalid ID`);
  }
  const canonicalId = canonicalUuid(id);
  if (expectedId !== undefined && canonicalId !== canonicalUuid(expectedId)) {
    throw new Error(`${label} creation did not return the requested ID`);
  }
  if (preexistingIds.has(canonicalId)) {
    throw new Error(`${label} creation returned a pre-existing ID`);
  }
  if (claimedIds.has(canonicalId))
    throw new Error(`${label} creation returned an already claimed ID`);
  return canonicalId;
};

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
  legacyLog: state.legacyLog ?? [],
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
  const trackedWork = [];
  return {
    track(label, work) {
      const record = { error: null };
      const tracked = Promise.resolve(work)
        .catch((error) => {
          record.error = new Error(`${label}: ${messageOf(error)}`, { cause: error });
        })
        .finally(() => pending.delete(tracked));
      trackedWork.push(record);
      pending.add(tracked);
    },
    async drain() {
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
      const errors = trackedWork.splice(0).flatMap(({ error }) => (error === null ? [] : [error]));
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

export const deleteAndVerifyAbsent = async (label, remove) => {
  const deletionStatus = await remove();
  if (deletionStatus !== 204 && deletionStatus !== 404) {
    throw new Error(`${label} cleanup failed: HTTP ${deletionStatus}`);
  }
  const readbackStatus = await remove();
  if (readbackStatus !== 404) {
    throw new Error(`${label} remains after cleanup: HTTP ${readbackStatus}`);
  }
};

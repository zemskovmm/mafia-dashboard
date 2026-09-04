/* global URL */
import { access, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const canonicalUuid = (value) => value.toLowerCase();

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

const markerExists = async (path) => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

export const awaitRestartRendezvous = async ({ directory, timeoutMs = 60_000 }) => {
  if (directory === undefined) return;
  if (typeof directory !== "string" || directory.trim() === "") {
    throw new Error("Restart rendezvous directory must be a non-empty path");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error("Restart rendezvous timeout must be between 1 and 300000 milliseconds");
  }
  const directoryState = await lstat(directory);
  if (!directoryState.isDirectory() || directoryState.isSymbolicLink()) {
    throw new Error("Restart rendezvous path must be a caller-owned directory");
  }
  const ready = join(directory, "ready");
  const continuation = join(directory, "continue");
  for (const [label, path] of [
    ["ready", ready],
    ["continue", continuation],
  ]) {
    if (await markerExists(path)) throw new Error(`Stale restart rendezvous marker: ${label}`);
  }
  await writeFile(ready, "", { flag: "wx", mode: 0o600 });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await markerExists(continuation)) {
      const state = await lstat(continuation);
      if (!state.isFile() || state.isSymbolicLink()) {
        throw new Error("Restart rendezvous continuation must be a regular file");
      }
      return;
    }
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  throw new Error("Timed out waiting for application restart continuation");
};

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

export const parseVerifierAuthCookie = (value, { required = false } = {}) => {
  if (value === undefined || value.trim() === "") {
    if (required) throw new Error("Verifier authentication cookie must use name=value format");
    return null;
  }
  const separator = value.indexOf("=");
  const name = separator < 0 ? "" : value.slice(0, separator).trim();
  const cookieValue = separator < 0 ? "" : value.slice(separator + 1).trim();
  if (
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
    cookieValue === "" ||
    /[;\r\n]/.test(cookieValue)
  ) {
    throw new Error("Verifier authentication cookie must use name=value format");
  }
  return { name, value: cookieValue };
};

export const parseVerifierClubId = (value) => {
  if (typeof value !== "string" || !uuidPattern.test(value.trim())) {
    throw new Error("Verifier club ID must be a UUID");
  }
  return canonicalUuid(value.trim());
};

export const gameSessionStorageKeyForClub = (clubId) => {
  const canonicalClubId = parseVerifierClubId(clubId);
  const prefix = "mafia-dashboard.game-session.v4";
  return canonicalClubId === "00000000-0000-4000-8000-000000000101"
    ? prefix
    : `${prefix}.${canonicalClubId}`;
};

export const classifyReadOnlyVerifierRequest = ({ method, url, expectedOrigin }) => {
  const normalizedMethod = method.toUpperCase();
  const requestUrl = new URL(url);
  if (!["GET", "HEAD", "OPTIONS"].includes(normalizedMethod)) {
    throw new Error(`Refusing unsafe verifier request: ${normalizedMethod}`);
  }
  if (requestUrl.origin === expectedOrigin) {
    return {
      kind:
        requestUrl.pathname === "/api" || requestUrl.pathname.startsWith("/api/")
          ? "same-origin-api"
          : "same-origin-page",
    };
  }
  if (requestUrl.pathname === "/api" || requestUrl.pathname.startsWith("/api/")) {
    assertExactOrigin(requestUrl, expectedOrigin);
  }
  return { kind: "external-safe" };
};

export const isExactPlaylistSelectionRequest = ({
  method,
  url,
  expectedOrigin,
  expectedPath,
  selectedPlaylistId,
  expectedPlaylistId,
}) => {
  if (method.toUpperCase() !== "GET" || selectedPlaylistId !== expectedPlaylistId) return false;
  const requestUrl = new URL(url);
  return (
    requestUrl.origin === expectedOrigin &&
    requestUrl.username === "" &&
    requestUrl.password === "" &&
    requestUrl.pathname === expectedPath &&
    requestUrl.search === "" &&
    requestUrl.hash === ""
  );
};

export const isAuthoritativeGameSnapshotRequest = ({ method, pathname, expectedPhase, body }) => {
  const sessionRoot =
    typeof pathname === "string" ? pathname.match(/^\/api\/game-sessions\/([0-9a-f-]+)$/i) : null;
  return (
    typeof method === "string" &&
    method.toUpperCase() === "PUT" &&
    sessionRoot !== null &&
    uuidPattern.test(sessionRoot[1]) &&
    body?.results === null &&
    typeof expectedPhase === "string" &&
    body?.state?.game?.phase === expectedPhase &&
    Array.isArray(body?.state?.events) &&
    body.state.events.some(
      (event) =>
        event?.parentEventId === null &&
        (event.type === "game.started" || event.type === "game.checkpointed"),
    )
  );
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
  const sessionClaim = pathname.match(/^\/api\/game-sessions\/([0-9a-f-]+)\/(claim|takeover)$/i);
  if (sessionClaim !== null && uuidPattern.test(sessionClaim[1]) && requestUrl.search === "") {
    const gameId = canonicalUuid(sessionClaim[1]);
    const action = sessionClaim[2].toLowerCase();
    const allowed =
      (normalizedMethod === "POST" && ["claim", "takeover"].includes(action)) ||
      (normalizedMethod === "DELETE" && action === "claim");
    if (allowed) {
      if (!ownedGameIds.has(gameId)) {
        throw new Error("Refusing an unsafe browser request for an unowned game session");
      }
      return { kind: "owned-session-mutation", gameId };
    }
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

export const assertEnvelopeMatchesSession = (envelope, session, replay) => {
  assertEqual("game id", envelope.gameId, session.gameId);
  assertEqual("name", envelope.name, session.name);
  assertEqual("revision", envelope.revision, session.revision);
  assertEqual("status", envelope.results === null ? "active" : "completed", session.status);
  assertEqual("results", envelope.results, session.results);
  assertEqual("metadata", envelope.metadata, canonicalMetadata(session.state));
  assertEqual("game", envelope.game, session.state.game);
  assertEqual("undo budget", envelope.undoBudget ?? 0, session.state.undoBudget ?? 0);
  assertEqual("baseline", envelope.baseline, session.state.initialGame);
  assertEqual("entries", envelope.entries, session.state.events);
  assertEqual("head", envelope.headEventId, session.state.headEventId);
  assertEqual("reset return", envelope.resetReturnEventId, session.state.resetReturnEventId);
  assertEqual("outbox", envelope.outbox, []);
  const activeEntries = activeEntriesFor(envelope.entries, envelope.headEventId);
  replay(envelope.baseline, activeEntries);
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

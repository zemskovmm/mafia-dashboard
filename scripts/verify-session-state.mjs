/* global URL, document, fetch */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { CURRENT_REPLAY_VERSION, replayGameLog } from "@mafia/game-domain";
import { chromium, request as playwrightRequest } from "@playwright/test";
import {
  assertBrowserGameEnvelopeOwner,
  assertEnvelopeMatchesSession,
  assertExactOrigin,
  assertNamesAvailable,
  assertNewResource,
  assertSessionPostcondition,
  assertVerifierTarget,
  awaitRestartRendezvous,
  classifyBrowserApiRequest,
  createAsyncTracker,
  deleteAndVerifyAbsent,
  gameSessionStorageKeyForClub,
  isAuthoritativeGameSnapshotRequest,
  parseVerifierAuthCookie,
  parseVerifierClubId,
  runCleanupActions,
} from "./session-verifier-contracts.mjs";

const configuredUrl = process.env.APP_URL;
if (!configuredUrl) {
  throw new Error("APP_URL is required, for example https://mbp16.tail102fab.ts.net");
}
const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const remoteAllowed = process.env.SESSION_VERIFY_ALLOW_REMOTE === "1";
const configuredExpectedOrigin = process.env.SESSION_VERIFY_EXPECTED_ORIGIN?.trim();
const resolveAppUrl = async (value, expectedOrigin) => {
  let current = new URL(value);
  for (let redirect = 0; redirect < 5; redirect += 1) {
    assertExactOrigin(current, expectedOrigin);
    const response = await fetch(current, {
      redirect: "manual",
      headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    });
    await response.body?.cancel();
    if (response.status < 300 || response.status >= 400) return current;
    const location = response.headers.get("location");
    if (location === null) throw new Error("APP_URL returned a redirect without a location");
    const next = new URL(location, current);
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new Error("APP_URL redirected to an unsupported protocol");
    }
    assertExactOrigin(next, expectedOrigin);
    current = next;
  }
  throw new Error("APP_URL exceeded the redirect limit");
};

const configuredTargetUrl = new URL(configuredUrl);
assertVerifierTarget({
  configuredUrl,
  browserUrl: configuredUrl,
  remoteAllowed,
  expectedOrigin: configuredExpectedOrigin,
});
const configuredHostHeader = process.env.SESSION_VERIFY_HOST_HEADER?.trim();
const configuredRestartGateDirectory = process.env.SESSION_RESTART_GATE_DIR;
if (configuredRestartGateDirectory !== undefined && configuredRestartGateDirectory.trim() === "") {
  throw new Error("SESSION_RESTART_GATE_DIR must be a non-empty path");
}
const restartGateDirectory = configuredRestartGateDirectory?.trim();
const configuredRestartTimeout = process.env.SESSION_RESTART_TIMEOUT_MS;
if (configuredRestartTimeout !== undefined && restartGateDirectory === undefined) {
  throw new Error("SESSION_RESTART_TIMEOUT_MS requires SESSION_RESTART_GATE_DIR");
}
const restartGateTimeoutMs = Number(configuredRestartTimeout ?? "60000");
if (
  !Number.isInteger(restartGateTimeoutMs) ||
  restartGateTimeoutMs < 1 ||
  restartGateTimeoutMs > 300_000
) {
  throw new Error("SESSION_RESTART_TIMEOUT_MS must be between 1 and 300000");
}
if (
  configuredHostHeader !== undefined &&
  !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(configuredHostHeader)
) {
  throw new Error("SESSION_VERIFY_HOST_HEADER must be a bare DNS hostname");
}
if (configuredHostHeader !== undefined && configuredHostHeader !== configuredTargetUrl.hostname) {
  throw new Error("SESSION_VERIFY_HOST_HEADER cannot split browser and API deployment identity");
}
const targetUrl = await resolveAppUrl(configuredUrl, configuredTargetUrl.origin);
assertVerifierTarget({
  configuredUrl,
  browserUrl: targetUrl.href,
  remoteAllowed,
  expectedOrigin: configuredExpectedOrigin,
});
const apiBaseUrl = configuredTargetUrl.origin;
const remoteTarget = !localHosts.has(configuredTargetUrl.hostname);
const configuredClubId = process.env.SESSION_CLUB_ID?.trim();
if (remoteTarget && !configuredClubId) {
  throw new Error("SESSION_CLUB_ID is required for remote session verification");
}
const clubId = parseVerifierClubId(configuredClubId || "00000000-0000-4000-8000-000000000101");
const storageKey = gameSessionStorageKeyForClub(clubId);
const apiHeaders = { "x-club-id": clubId };
const browserHeaders = {
  ...apiHeaders,
};
const hasEngineMetadata = (value) =>
  /"(?:rulesEdition|rulesetId|rulesetVersion)":/u.test(JSON.stringify(value));
const parsedAuthCookie = parseVerifierAuthCookie(process.env.SESSION_AUTH_COOKIE);

const playlist = {
  id: "session-verification-playlist",
  title: "Mafia session verification",
  itemCount: 2,
  thumbnailUrl: null,
};
const runId = randomUUID().slice(0, 12);
const playerNames = Array.from(
  { length: 11 },
  (_, index) => `Session ${runId} Player ${String(index + 1).padStart(2, "0")}`,
);
const screenshotPath = process.env.SESSION_SCREENSHOT ?? ".AI/qa/session-state/restored.png";
const undoEvidencePath = screenshotPath.replace(/\.png$/iu, "-unlimited-undo.json");
const undoEvidence = { checkpoints: [], nativeUndoCount: 0, responseLoss: null };
const eligibleEntries = (entries) =>
  entries.filter(
    ({ type }) => !["game.started", "game.checkpointed", "game.completed"].includes(type),
  );
// Persistence is JSON: optional undefined fields do not survive the wire. The
// real replay still validates every canonical hash before this serialization.
const replayPersistedLog = (baseline, entries) => {
  const replayed = replayGameLog(baseline, entries);
  return { ...replayed, game: JSON.parse(JSON.stringify(replayed.game)) };
};
let responseLossProbe = null;
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  ...(configuredHostHeader === undefined
    ? {}
    : { args: [`--host-resolver-rules=MAP ${configuredHostHeader} 127.0.0.1`] }),
});
const apiContext = await playwrightRequest.newContext({
  baseURL: apiBaseUrl,
  extraHTTPHeaders: {
    ...apiHeaders,
    origin: targetUrl.origin,
    ...(parsedAuthCookie === null
      ? {}
      : { cookie: `${parsedAuthCookie.name}=${parsedAuthCookie.value}` }),
  },
});
const createdPlayerIds = new Set();
const createdGameIds = new Set();
const createdSetupStates = new Map();

const preexistingPlayerIds = new Set();
const preexistingGameIds = new Set();
const cleanupErrors = [];
const responseTracker = createAsyncTracker();

const createContext = async () => {
  const context = await browser.newContext({
    viewport: { width: 1180, height: 820 },
    extraHTTPHeaders: browserHeaders,
  });
  if (parsedAuthCookie !== null) {
    await context.addCookies([
      {
        ...parsedAuthCookie,
        url: targetUrl.origin,
        httpOnly: true,
        secure: targetUrl.protocol === "https:",
        sameSite: "Lax",
      },
    ]);
  }
  await context.addInitScript(() => {
    class FakeYouTubePlayer {
      constructor(_elementId, options) {
        this.options = options;
        this.volume = 65;
        this.iframe = document.createElement("iframe");
        setTimeout(() => options.events?.onReady?.({ target: this }), 0);
      }
      playVideo() {
        this.options.events?.onStateChange?.({ target: this, data: 1 });
      }
      pauseVideo() {
        this.options.events?.onStateChange?.({ target: this, data: 2 });
      }
      cuePlaylist(_videoIds, index = 0) {
        this.playlistIndex = index;
        this.options.events?.onStateChange?.({ target: this, data: 5 });
      }
      loadPlaylist(_videoIds, index = 0) {
        this.playlistIndex = index;
        this.options.events?.onStateChange?.({ target: this, data: 1 });
      }
      setVolume(volume) {
        this.volume = volume;
      }
      getVolume() {
        return this.volume;
      }
      getIframe() {
        return this.iframe;
      }
      getPlaylistIndex() {
        return this.playlistIndex ?? 0;
      }
      getCurrentTime() {
        return 0;
      }
      destroy() {}
    }
    window.YT = {
      Player: FakeYouTubePlayer,
      PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3, CUED: 5 },
    };
  });
  const reportBlockedRequest = async (route, error) => {
    cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    await route.abort("blockedbyclient");
  };
  const fulfillMock = async (route, response) => {
    try {
      const classification = classifyBrowserApiRequest({
        method: route.request().method(),
        url: route.request().url(),
        expectedOrigin: targetUrl.origin,
        ownedGameIds: createdGameIds,
      });
      if (classification.kind !== "safe") {
        throw new Error("Verifier mocks accept safe requests only");
      }
      await route.fulfill(response);
    } catch (error) {
      await reportBlockedRequest(route, error);
    }
  };
  await context.route("**/*", async (route) => {
    try {
      const request = route.request();
      const classification = classifyBrowserApiRequest({
        method: request.method(),
        url: request.url(),
        expectedOrigin: targetUrl.origin,
        ownedGameIds: createdGameIds,
      });
      if (classification.kind === "session-creation") {
        const response = await route.fetch({ maxRedirects: 0 });
        const session = await response.json();
        const createdGameId = assertNewResource({
          label: "game session",
          status: response.status(),
          id: session.gameId,

          preexistingIds: preexistingGameIds,
          claimedIds: createdGameIds,
        });
        createdGameIds.add(createdGameId);
        createdSetupStates.set(createdGameId, request.postDataJSON().state);
        await route.fulfill({ response });
        return;
      }
      if (
        classification.kind === "owned-session-mutation" &&
        request.method() === "PUT" &&
        classification.gameId === responseLossProbe?.gameId &&
        responseLossProbe.hold
      ) {
        if (responseLossProbe.accepted === null) {
          const response = await route.fetch({ maxRedirects: 0 });
          if (!response.ok())
            throw new Error(`Response-loss save failed: HTTP ${response.status()}`);
          responseLossProbe.accepted = await response.json();
          responseLossProbe.mutationId = request.postDataJSON().mutationId;
        } else {
          responseLossProbe.retryCount += 1;
        }
        await route.abort("failed");
        return;
      }
      if (
        classification.kind === "owned-session-mutation" &&
        request.method() === "PUT" &&
        classification.gameId === responseLossProbe?.gameId
      ) {
        responseLossProbe.retriedMutationIds.push(request.postDataJSON().mutationId);
      }
      await route.continue();
    } catch (error) {
      await reportBlockedRequest(route, error);
    }
  });
  await context.route("**/api/music/oauth/status", async (route) => {
    await fulfillMock(route, {
      contentType: "application/json",
      body: JSON.stringify({
        configured: true,
        connected: true,
        accountLabel: "session-verification@example.test",
      }),
    });
  });
  await context.route("**/api/music/playlists", async (route) => {
    await fulfillMock(route, {
      contentType: "application/json",
      body: JSON.stringify({ playlists: [playlist] }),
    });
  });
  await context.route("**/api/music/playlists/*/items", async (route) => {
    await fulfillMock(route, {
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            videoId: "session-track-1",
            title: "Session verification track",
            channelTitle: "Session verification",
            thumbnailUrl: null,
            position: 0,
          },
        ],
      }),
    });
  });
  return context;
};

const assertPageTarget = (page) => {
  const actual = new URL(page.url());
  if (actual.origin !== targetUrl.origin || (remoteTarget && actual.protocol !== "https:")) {
    throw new Error(`Browser navigation left the verified application origin: ${actual.origin}`);
  }
};

const readAuthoritativeSession = async (gameId, label) => {
  const response = await apiContext.get(`${apiBaseUrl}/api/game-sessions/${gameId}`, {
    maxRedirects: 0,
  });
  if (!response.ok()) throw new Error(`${label}: HTTP ${response.status()}`);
  return (await response.json()).session;
};

const waitForAuthoritativePhase = async (gameId, expectedPhase) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const session = await readAuthoritativeSession(gameId, `Waiting for ${expectedPhase}`);
    if (session.state.game?.phase === expectedPhase) return session;
    await delay(100);
  }
  throw new Error(`Timed out waiting for authoritative ${expectedPhase} phase`);
};

const waitForApplicationReady = async () => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const response = await fetch(new URL("/health/ready", targetUrl.origin), {
        redirect: "manual",
      });
      if (response.ok && (await response.json()).status === "ready") return;
    } catch {
      // The coordinated application restart may still be in progress.
    }
    await delay(100);
  }
  throw new Error("Application did not become ready after coordinated restart");
};

let verificationError = null;
try {
  const authResponse = await apiContext.get("/api/auth/session", { maxRedirects: 0 });
  if (!authResponse.ok()) {
    throw new Error(`Authentication preflight failed: HTTP ${authResponse.status()}`);
  }
  const authSession = await authResponse.json();
  if (authSession.user == null) {
    throw new Error("SESSION_AUTH_COOKIE must contain an authenticated test-session cookie");
  }
  const clubsResponse = await apiContext.get("/api/clubs", { maxRedirects: 0 });
  if (!clubsResponse.ok()) throw new Error("Club identity preflight failed");
  const selectedClub = (await clubsResponse.json()).clubs?.find(({ id }) => id === clubId);
  if (selectedClub === undefined) {
    throw new Error("SESSION_CLUB_ID is not an accessible club for the authenticated user");
  }
  const playerSnapshotResponse = await apiContext.get("/api/players", { maxRedirects: 0 });
  if (!playerSnapshotResponse.ok()) throw new Error("Player ownership preflight failed");
  const playerSnapshot = (await playerSnapshotResponse.json()).players;
  if (!Array.isArray(playerSnapshot)) throw new Error("Player ownership snapshot is malformed");
  for (const player of playerSnapshot) preexistingPlayerIds.add(player.id.toLowerCase());
  assertNamesAvailable(
    playerNames,
    playerSnapshot.map(({ nickname }) => nickname),
  );
  for (const path of ["/api/game-sessions", "/api/game-sessions?status=completed"]) {
    const sessionSnapshotResponse = await apiContext.get(path, { maxRedirects: 0 });
    if (!sessionSnapshotResponse.ok()) throw new Error("Game-session ownership preflight failed");
    const sessions = (await sessionSnapshotResponse.json()).sessions;
    if (!Array.isArray(sessions)) throw new Error("Game-session ownership snapshot is malformed");
    for (const session of sessions) preexistingGameIds.add(session.gameId.toLowerCase());
  }
  const firstContext = await createContext();
  const players = [];
  for (const nickname of playerNames) {
    const response = await apiContext.post(`${apiBaseUrl}/api/players`, {
      maxRedirects: 0,
      data: {
        nickname,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
      },
    });
    if (response.status() !== 201) {
      assertNewResource({
        label: "player",
        status: response.status(),
        id: null,
        preexistingIds: preexistingPlayerIds,
        claimedIds: createdPlayerIds,
      });
    }
    const { player } = await response.json();
    if (player?.nickname !== nickname) {
      throw new Error("Verification player response did not match the requested nickname");
    }
    const playerId = assertNewResource({
      label: "player",
      status: response.status(),
      id: player.id,
      preexistingIds: preexistingPlayerIds,
      claimedIds: createdPlayerIds,
    });
    players.push(player);
    createdPlayerIds.add(playerId);
  }

  const firstPage = await firstContext.newPage();
  let reportSessionFailure;
  const firstSessionFailure = new Promise((resolve) => {
    reportSessionFailure = resolve;
  });
  let sessionFailureReported = false;
  const reportFailure = (error) => {
    if (sessionFailureReported) return;
    sessionFailureReported = true;
    reportSessionFailure(error instanceof Error ? error : new Error(String(error)));
  };
  firstPage.on("response", (response) => {
    const responseUrl = new URL(response.url());
    responseTracker.track(
      `${response.request().method()} ${responseUrl.pathname}`,
      (async () => {
        const sessionMatch = responseUrl.pathname.match(/^\/api\/game-sessions\/([^/]+)(?:\/|$)/);
        if (sessionMatch === null || !createdGameIds.has(decodeURIComponent(sessionMatch[1]))) {
          return;
        }
        if (response.ok()) return;
        const body = await response.json().catch(() => null);
        const code =
          typeof body?.error === "string" && /^[a-z_]{1,80}$/.test(body.error)
            ? body.error
            : "unavailable";
        throw new Error(
          `Game-session request failed: HTTP ${response.status()} ${response.request().method()} ${responseUrl.pathname} (${code})`,
        );
      })(),
    );
  });
  const waitForSaved = async (requiredResponse) => {
    const result = await Promise.race([
      (async () => {
        const response = await requiredResponse;
        if (!response.ok()) {
          throw new Error(
            `Required game-session mutation failed: HTTP ${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`,
          );
        }
        return null;
      })(),
      firstSessionFailure,
    ]);
    if (result instanceof Error) throw result;
    await firstPage.waitForLoadState("networkidle");
    try {
      await responseTracker.drain();
    } catch (error) {
      reportFailure(error);
      throw error;
    }
  };
  await firstPage.goto(targetUrl.href, { waitUntil: "networkidle" });
  assertPageTarget(firstPage);
  await firstPage
    .getByRole("button", { name: `Open ${selectedClub.name} in ${selectedClub.city}`, exact: true })
    .click();
  await firstPage.getByRole("button", { name: "Select available players" }).click();
  for (const player of players) {
    await firstPage
      .getByRole("button", { name: `Mark ${player.nickname} available`, exact: true })
      .click();
  }
  await firstPage.getByRole("button", { name: "Close available players" }).click();
  await firstPage.getByRole("combobox", { name: "Host player" }).click();
  await firstPage.getByRole("option", { name: players[10].nickname, exact: true }).click();
  await firstPage.getByRole("button", { name: "Assign players" }).click();
  const startGame = firstPage.getByRole("button", { name: "Start game" });
  await startGame.waitFor();
  const musicPanelHandle = firstPage.getByRole("button", { name: "Music player panel handle" });
  await musicPanelHandle.click();
  const playlistPicker = firstPage.getByRole("combobox", {
    name: "YouTube Music playlist",
    exact: true,
  });
  await playlistPicker.selectOption(playlist.id);
  if ((await playlistPicker.inputValue()) !== playlist.id) {
    throw new Error("The expanded session queue did not select the verification playlist");
  }
  await musicPanelHandle.click();
  await startGame.click();
  const roleGiveawaySave = firstPage.waitForResponse((response) => {
    const request = response.request();
    const url = new URL(response.url());
    if (
      request.method() !== "PUT" ||
      url.origin !== targetUrl.origin ||
      ![...createdGameIds].some((id) => url.pathname === `/api/game-sessions/${id}`)
    ) {
      return false;
    }
    const body = request.postDataJSON();
    return (
      typeof body?.mutationId === "string" &&
      body.results === null &&
      body.state?.game === null &&
      body.state?.setup?.step === "roles" &&
      Object.keys(body.state?.setup?.setup?.assignments ?? {}).length === 10
    );
  });
  for (let roleIndex = 0; roleIndex < 10; roleIndex += 1) {
    await firstPage
      .getByRole("button", { name: /^Draw role for / })
      .first()
      .click();
  }
  await waitForSaved(roleGiveawaySave);
  if (createdGameIds.size !== 1) {
    throw new Error("Expected exactly one run-owned game session after role giveaway");
  }
  const [setupGameId] = createdGameIds;
  // Creation now happens during player selection; resume roles from the actual later UI save.
  const { state: roleGiveawayState } = await readAuthoritativeSession(
    setupGameId,
    "Role-giveaway snapshot readback failed",
  );
  if (
    roleGiveawayState.game !== null ||
    roleGiveawayState.setup?.step !== "roles" ||
    hasEngineMetadata(roleGiveawayState) ||
    roleGiveawayState.setup?.setup?.remainingRoles.length !== 0 ||
    Object.keys(roleGiveawayState.setup?.setup?.assignments ?? {}).length !== 10
  ) {
    throw new Error(
      `The UI did not durably save the completed role-giveaway setup: ${JSON.stringify({
        gameIsNull: roleGiveawayState.game === null,
        step: roleGiveawayState.setup?.step,
        hasEngineMetadata: hasEngineMetadata(roleGiveawayState),
        remainingRoles: roleGiveawayState.setup?.setup?.remainingRoles.length,
        assignments: Object.keys(roleGiveawayState.setup?.setup?.assignments ?? {}).length,
      })}`,
    );
  }
  const waitForSnapshot = (expectedPhase) =>
    firstPage.waitForResponse((response) => {
      const request = response.request();
      const responseUrl = new URL(response.url());
      let body;
      try {
        body = request.postDataJSON();
      } catch {
        return false;
      }
      return isAuthoritativeGameSnapshotRequest({
        method: request.method(),
        pathname: `${responseUrl.pathname}${responseUrl.search}`,
        expectedPhase,
        body,
      });
    });
  const startSave = waitForSnapshot("mafia-planning");
  await firstPage.getByRole("button", { name: "Begin Mafia planning stage" }).click();
  await waitForSaved(startSave);
  const sheriffSave = waitForSnapshot("sheriff-identification");
  await firstPage.getByRole("button", { name: "Mafia asleep", exact: true }).click();
  await waitForSaved(sheriffSave);
  const beginDay = firstPage.getByRole("button", { name: "Begin round zero", exact: true });
  await beginDay.waitFor();
  const daySave = waitForSnapshot("day");
  await beginDay.click();
  await waitForSaved(daySave);
  if (createdGameIds.size !== 1) {
    throw new Error("Expected exactly one run-owned game session after start");
  }
  const [gameId] = createdGameIds;
  const gameName = (await waitForAuthoritativePhase(gameId, "day")).name;
  const readEnvelope = async (page) =>
    page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? "null"), storageKey);
  const assertRetainedState = (state, expectedEntries, label, completed = false) => {
    const head = expectedEntries.at(-1)?.id ?? null;
    if (
      !isDeepStrictEqual(state.events, expectedEntries) ||
      state.headEventId !== head ||
      state.resetReturnEventId !== null ||
      !isDeepStrictEqual(state.undoHistory, []) ||
      state.undoBudget !== (completed ? 0 : eligibleEntries(expectedEntries).length) ||
      !isDeepStrictEqual(state.game, replayPersistedLog(state.initialGame, expectedEntries).game) ||
      !isDeepStrictEqual(
        state.log.slice(state.legacyLog.length).map(({ id }) => id),
        expectedEntries.map(({ id }) => id),
      )
    ) {
      throw new Error(`${label}: retained prefix/head/log/replay/derived Undo differs`);
    }
  };
  const savedCheckpoint = async (page, label, expectedEntries, completed = false) => {
    const deadline = Date.now() + 20_000;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const envelope = await readEnvelope(page);
        assertBrowserGameEnvelopeOwner(envelope, clubId);
        if (envelope.outbox.length !== 0) throw new Error("Save is not acknowledged yet");
        const authoritative = await readAuthoritativeSession(gameId);
        assertEnvelopeMatchesSession(envelope, authoritative, replayPersistedLog);
        assertRetainedState(envelope.current.state, expectedEntries, label, completed);
        if (!isDeepStrictEqual(envelope.current.state, authoritative.state)) {
          throw new Error("Full persisted canonical snapshot differs from the browser");
        }
        if ((authoritative.status === "completed") !== completed) {
          throw new Error("Explicit Finish status differs from authoritative readback");
        }
        undoEvidence.checkpoints.push({ label, envelope, authoritative });
        return authoritative;
      } catch (error) {
        lastError = error;
        await delay(100);
      }
    }
    throw new Error(`${label}: ${lastError?.message ?? "save timeout"}`, { cause: lastError });
  };
  const genuineAction = async (page, name, label) => {
    const before = (await readEnvelope(page)).current.state;
    const control = page.getByRole("button", { name, exact: true });
    if ((await control.evaluate((element) => element.tagName)) !== "BUTTON") {
      throw new Error(`${label}: the action is not a native button`);
    }
    await control.click();
    await page.waitForFunction(
      ({ key, head }) =>
        JSON.parse(window.localStorage.getItem(key)).current.state.headEventId !== head,
      { key: storageKey, head: before.headEventId },
    );
    const after = (await readEnvelope(page)).current.state;
    if (
      after.events.length !== before.events.length + 1 ||
      !isDeepStrictEqual(after.events.slice(0, -1), before.events) ||
      after.events.at(-1).parentEventId !== before.headEventId ||
      eligibleEntries(after.events).length !== eligibleEntries(before.events).length + 1
    ) {
      throw new Error(`${label}: native action did not append exactly one genuine eligible event`);
    }
    return savedCheckpoint(page, label, after.events);
  };
  await savedCheckpoint(
    firstPage,
    "initial-day",
    (await readEnvelope(firstPage)).current.state.events,
  );
  for (let turn = 0; turn < 9; turn += 1) {
    await genuineAction(firstPage, "Next player", `zero-round-turn-${turn + 1}`);
  }
  for (const name of [
    "Begin night",
    "Evaluate Mafia shots",
    "Continue night",
    "Skip Don check",
    "Skip Sheriff check",
    "Announce morning",
  ]) {
    await genuineAction(firstPage, name, `next-day-${name}`);
  }
  const nextDay = (await readEnvelope(firstPage)).current.state.game;
  if (nextDay.day !== 2 || nextDay.phase !== "day" || nextDay.currentTurnIndex !== 0) {
    throw new Error(
      "Unlimited Undo fixture did not cross a genuine ordinary night-to-day transition",
    );
  }

  const activeResponse = await apiContext.get(`${apiBaseUrl}/api/game-sessions`, {
    maxRedirects: 0,
  });
  if (!activeResponse.ok()) throw new Error("Active session listing failed");
  const { sessions } = await activeResponse.json();
  const verificationSessions = Array.isArray(sessions)
    ? sessions.filter(({ gameId }) => createdGameIds.has(gameId.toLowerCase()))
    : [];
  if (verificationSessions.length !== 1) {
    throw new Error("Expected exactly one run-owned active server session before restart");
  }
  if (verificationSessions[0].gameId.toLowerCase() !== gameId) {
    throw new Error("Active session listing returned the wrong run-owned game ID");
  }
  const storedResponse = await apiContext.get(`${apiBaseUrl}/api/game-sessions/${gameId}`, {
    maxRedirects: 0,
  });
  if (!storedResponse.ok()) throw new Error("Stored session readback failed");
  const { session: storedSession } = await storedResponse.json();
  let authoritativeSession = storedSession;
  const storedEvents = Array.isArray(storedSession.state.events) ? storedSession.state.events : [];
  const eventsById = new Map(storedEvents.map((event) => [event.id, event]));
  const activeEventIds = new Set();
  let activeEventId = storedSession.state.headEventId;
  let priorSequence = Number.POSITIVE_INFINITY;
  while (activeEventId !== null) {
    if (activeEventIds.has(activeEventId)) throw new Error("Stored replay chain contains a cycle");
    activeEventIds.add(activeEventId);
    const event = eventsById.get(activeEventId);
    if (event === undefined || event.gameId !== gameId || event.sequence >= priorSequence) {
      throw new Error("Stored replay chain has an invalid parent or sequence");
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(event.stateHashAfter)) {
      throw new Error("Stored replay chain has an invalid state hash");
    }
    priorSequence = event.sequence;
    activeEventId = event.parentEventId;
  }
  const activeEvents = storedEvents.filter(({ id }) => activeEventIds.has(id));
  const replayed = replayPersistedLog(storedSession.state.initialGame, activeEvents);
  if (
    storedSession.state.hostPlayerId !== players[10].id ||
    Object.hasOwn(storedSession.state, "hostName") ||
    storedSession.state.playlistId !== playlist.id ||
    storedSession.state.game?.phase !== "day" ||
    storedSession.state.game?.currentTurnIndex !== 0 ||
    storedSession.state.undoHistory.length !== 0 ||
    storedSession.state.undoBudget !== eligibleEntries(activeEvents).length ||
    eligibleEntries(activeEvents).length <= 5 ||
    storedSession.state.initialGame?.replayVersion !== CURRENT_REPLAY_VERSION ||
    hasEngineMetadata(storedSession) ||
    activeEvents.length === 0 ||
    !activeEvents.some(({ type }) => type === "game.started" || type === "game.checkpointed") ||
    !activeEvents.some(({ type }) => type === "phase.changed") ||
    !isDeepStrictEqual(replayed.game, storedSession.state.game)
  ) {
    throw new Error(
      `The authoritative server session is not fully restorable: ${JSON.stringify({
        hostPlayerId: storedSession.state.hostPlayerId,
        hostName: storedSession.state.hostName,
        playlistId: storedSession.state.playlistId,
        phase: storedSession.state.game?.phase,
        currentTurnIndex: storedSession.state.game?.currentTurnIndex,
        undoCount: storedSession.state.undoBudget,
        replayVersion: storedSession.state.initialGame?.replayVersion,
        eventTypes: activeEvents.map(({ type }) => type),
        replayMatches: isDeepStrictEqual(replayed.game, storedSession.state.game),
      })}`,
    );
  }
  const storedCanonicalState = JSON.stringify(storedSession.state);
  if (playerNames.some((nickname) => storedCanonicalState.includes(nickname))) {
    throw new Error("The authoritative canonical snapshot contains copied player names");
  }
  const secondName = `Session ${runId} second game`;
  const initialState = createdSetupStates.get(gameId);
  if (initialState === undefined) throw new Error("Missing run-owned creation snapshot");
  const secondCreated = await apiContext.post("/api/game-sessions", {
    maxRedirects: 0,
    data: {
      creationId: randomUUID(),
      name: secondName,
      state: { ...roleGiveawayState, log: [], legacyLog: [], events: [] },
      results: null,
    },
  });
  const secondSession = await secondCreated.json();
  const secondId = assertNewResource({
    label: "second game session",
    status: secondCreated.status(),
    id: secondSession.gameId,
    preexistingIds: preexistingGameIds,
    claimedIds: createdGameIds,
  });
  createdGameIds.add(secondId);
  const concurrentListing = await apiContext.get("/api/game-sessions");
  const concurrentSessions = (await concurrentListing.json()).sessions;
  if (
    ![gameId, secondId].every((id) => concurrentSessions.some((session) => session.gameId === id))
  ) {
    throw new Error("The club did not enumerate both simultaneous active games");
  }
  const secondContext = await createContext();
  const secondPage = await secondContext.newPage();
  await secondPage.goto(targetUrl.href, { waitUntil: "networkidle" });
  await secondPage
    .getByRole("button", { name: `Open ${selectedClub.name} in ${selectedClub.city}` })
    .click();
  await secondPage.getByRole("button", { name: "Open Manage menu" }).click();
  await secondPage.getByRole("button", { name: `Resume ${secondName}`, exact: true }).click();
  await secondPage.getByRole("heading", { name: "Role giveaway" }).waitFor();
  await secondPage.getByRole("button", { name: "Open Manage menu" }).click();
  const gameRows = secondPage.getByRole("listitem");
  await gameRows
    .filter({ has: secondPage.getByRole("button", { name: `Resume ${gameName}`, exact: true }) })
    .waitFor();
  secondPage.once("dialog", (dialog) => dialog.accept());
  const secondDeletion = secondPage.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname === `/api/game-sessions/${secondId}`,
  );
  await gameRows
    .filter({ has: secondPage.getByRole("button", { name: `Resume ${secondName}`, exact: true }) })
    .getByRole("button", { name: `Delete ${secondName}`, exact: true })
    .click();
  const secondDeleteResponse = await secondDeletion;
  if (secondDeleteResponse.status() !== 204) {
    throw new Error(`Second-game UI delete failed: HTTP ${secondDeleteResponse.status()}`);
  }
  await secondPage.getByRole("heading", { name: "Select players", exact: true }).waitFor();
  const secondReadback = await apiContext.get(`/api/game-sessions/${secondId}`);
  if (secondReadback.status() !== 404) throw new Error("Deleted second game remains on the server");
  const lateSave = await apiContext.put(`/api/game-sessions/${secondId}`, {
    data: { name: secondName, mutationId: randomUUID(), state: secondSession.state, results: null },
  });
  if (lateSave.status() !== 404) throw new Error("A late save recreated the deleted game");
  const survivingSession = await readAuthoritativeSession(gameId);
  if (!isDeepStrictEqual(survivingSession, storedSession)) {
    throw new Error("Deleting the second game changed the first game");
  }
  await secondPage.reload({ waitUntil: "networkidle" });
  const afterSecondDelete = await apiContext.get("/api/game-sessions");
  const remainingSessions = (await afterSecondDelete.json()).sessions;
  if (
    remainingSessions.some((session) => session.gameId === secondId) ||
    !remainingSessions.some((session) => session.gameId === gameId)
  ) {
    throw new Error("Active game listing did not preserve only the surviving fixture");
  }
  await secondContext.close();
  await awaitRestartRendezvous({
    directory: restartGateDirectory,
    timeoutMs: restartGateTimeoutMs,
  });
  if (restartGateDirectory !== undefined) await waitForApplicationReady();
  const restartedSession = await readAuthoritativeSession(
    gameId,
    "Authoritative post-restart readback failed",
  );
  if (
    !isDeepStrictEqual(restartedSession, storedSession) ||
    JSON.stringify(restartedSession.state) !== storedCanonicalState
  ) {
    throw new Error("Authoritative session changed across the application restart");
  }
  authoritativeSession = restartedSession;

  const acceptedEvent = activeEvents.at(-1);
  if (acceptedEvent?.type !== "phase.changed" || acceptedEvent.parentEventId == null) {
    throw new Error("Reset probe has no accepted phase event with a parent");
  }
  const resetGame = replayPersistedLog(
    storedSession.state.initialGame,
    activeEvents.filter(({ id }) => id !== acceptedEvent.id),
  ).game;
  const resetEntries = activeEvents.slice(0, -1);
  const resetState = {
    ...storedSession.state,
    game: resetGame,
    events: resetEntries,
    log: storedSession.state.log.filter(({ id }) => id !== acceptedEvent.id),
    undoHistory: [],
    headEventId: acceptedEvent.parentEventId,
    resetReturnEventId: null,
    undoBudget: 0,
  };
  const resetPostcondition = {
    gameId,
    revision: storedSession.revision + 1,
    status: "active",
    results: null,
    headEventId: acceptedEvent.parentEventId,
    resetReturnEventId: null,
    game: resetGame,
  };
  const resetResponse = await apiContext.put(`${apiBaseUrl}/api/game-sessions/${gameId}`, {
    maxRedirects: 0,

    data: {
      name: storedSession.name,
      mutationId: randomUUID(),

      state: resetState,
      results: null,
    },
  });
  if (!resetResponse.ok()) {
    throw new Error(`Authoritative snapshot reset probe failed: HTTP ${resetResponse.status()}`);
  }
  assertSessionPostcondition(await resetResponse.json(), resetPostcondition, replayPersistedLog);
  const resetReadback = await readAuthoritativeSession(
    gameId,
    "Authoritative reset readback failed",
  );
  assertSessionPostcondition(resetReadback, resetPostcondition, replayPersistedLog);
  if (
    resetReadback.state.undoBudget !== 0 ||
    eligibleEntries(resetReadback.state.events).length <= 5
  ) {
    throw new Error("Legacy-zero resume fixture was not durably saved with long eligible history");
  }
  undoEvidence.checkpoints.push({
    label: "server-saved-legacy-zero",
    authoritative: resetReadback,
  });
  authoritativeSession = resetReadback;
  await firstContext.close();

  const restartedContext = await createContext();
  const restartedPage = await restartedContext.newPage();
  await restartedPage.goto(targetUrl.href, { waitUntil: "networkidle" });
  assertPageTarget(restartedPage);
  await restartedPage
    .getByRole("button", { name: `Open ${selectedClub.name} in ${selectedClub.city}`, exact: true })
    .click();
  await restartedPage.getByRole("button", { name: "Open Manage menu" }).click();
  await restartedPage.getByRole("button", { name: `Resume ${gameName}` }).click();

  const restoredPhaseAction = restartedPage.getByRole("button", {
    name: "Announce morning",
    exact: true,
  });
  await restoredPhaseAction.waitFor();
  authoritativeSession = await savedCheckpoint(
    restartedPage,
    "legacy-zero-server-resume",
    resetEntries,
  );
  const restoredEnvelope = await readEnvelope(restartedPage);
  assertBrowserGameEnvelopeOwner(restoredEnvelope, clubId);
  assertEnvelopeMatchesSession(restoredEnvelope, authoritativeSession, replayPersistedLog);
  if (
    JSON.stringify(restoredEnvelope.current.state) !== JSON.stringify(authoritativeSession.state)
  ) {
    throw new Error("The restored browser canonical snapshot differs from authoritative readback");
  }
  await restartedPage.locator(".club-curtain-opening").waitFor({ state: "detached" });
  await restartedPage.screenshot({ path: screenshotPath, fullPage: true });

  // Preserve the original open-client deletion probe on a separately resumed stale tab.
  const removalContext = await createContext();
  const removalPage = await removalContext.newPage();
  await removalPage.goto(targetUrl.href, { waitUntil: "networkidle" });
  await removalPage
    .getByRole("button", { name: `Open ${selectedClub.name} in ${selectedClub.city}`, exact: true })
    .click();
  await removalPage.getByRole("button", { name: "Open Manage menu" }).click();
  await removalPage.getByRole("button", { name: `Resume ${gameName}`, exact: true }).click();
  await removalPage.getByRole("button", { name: "Announce morning", exact: true }).waitFor();
  await savedCheckpoint(removalPage, "independent-removal-client", resetEntries);

  // Undo must work immediately after server resume, before a fresh action could
  // accidentally replenish a legacy zero allowance.
  const legacyLast = eligibleEntries(resetEntries).at(-1);
  const legacyRetained = resetEntries.slice(
    0,
    resetEntries.findIndex(({ id }) => id === legacyLast.id),
  );
  const legacyUndo = restartedPage.getByRole("button", { name: "Undo last action", exact: true });
  if (
    !(await legacyUndo.isEnabled()) ||
    (await legacyUndo.evaluate((element) => element.tagName)) !== "BUTTON" ||
    (await legacyUndo.innerText()).trim() !== ""
  ) {
    throw new Error("Legacy-zero server resume did not enable native, badge-free Undo");
  }
  await legacyUndo.click();
  undoEvidence.nativeUndoCount += 1;
  await savedCheckpoint(restartedPage, "legacy-zero-immediate-native-undo", legacyRetained);
  await genuineAction(restartedPage, "Skip Sheriff check", "legacy-zero-reapply-undone-action");
  await genuineAction(restartedPage, "Announce morning", "legacy-zero-native-action");
  for (let turn = 0; turn < 5; turn += 1) {
    await genuineAction(restartedPage, "Next player", `day-two-turn-${turn + 1}`);
  }
  let retained = (await readEnvelope(restartedPage)).current.state.events;
  const discardedIds = new Set([legacyLast.id]);
  const undo = async (label, loseResponse = false) => {
    const eligible = eligibleEntries(retained).at(-1);
    if (eligible === undefined) throw new Error(`${label}: expected an eligible action`);
    const next = retained.slice(
      0,
      retained.findIndex(({ id }) => id === eligible.id),
    );
    for (const { id } of retained.slice(next.length)) discardedIds.add(id);
    const control = restartedPage.getByRole("button", { name: "Undo last action", exact: true });
    if (
      !(await control.isEnabled()) ||
      (await control.evaluate((element) => element.tagName)) !== "BUTTON" ||
      (await control.innerText()).trim() !== ""
    ) {
      throw new Error(`${label}: Undo is not enabled/native/badge-free`);
    }
    if (loseResponse) {
      responseLossProbe = {
        gameId,
        hold: true,
        accepted: null,
        mutationId: null,
        retryCount: 0,
        retriedMutationIds: [],
      };
    }
    await control.click();
    undoEvidence.nativeUndoCount += 1;
    retained = next;
    if (loseResponse) {
      const deadline = Date.now() + 20_000;
      while (responseLossProbe.accepted === null && Date.now() < deadline) await delay(50);
      if (responseLossProbe.accepted === null)
        throw new Error("Response-loss save never reached the real API");
      const persisted = await readAuthoritativeSession(gameId);
      assertRetainedState(persisted.state, retained, `${label}-accepted-before-response-loss`);
      if (!isDeepStrictEqual(persisted, responseLossProbe.accepted)) {
        throw new Error("Lost-response mutation differs from authoritative persistence");
      }
      await restartedPage.reload({ waitUntil: "networkidle" });
      await restartedPage.getByRole("button", { name: "Undo last action", exact: true }).waitFor();
      const pending = await readEnvelope(restartedPage);
      assertRetainedState(pending.current.state, retained, `${label}-queued-reload`);
      if (
        pending.outbox.length === 0 ||
        !pending.outbox.some(({ mutationId }) => mutationId === responseLossProbe.mutationId)
      ) {
        throw new Error(
          "Response-loss reload dropped the queued mutation or its idempotency identity",
        );
      }
      for (const mutation of pending.outbox) {
        assertRetainedState(mutation.state, retained, `${label}-queued-mutation`);
      }
      undoEvidence.responseLoss = { pending, persisted, mutationId: responseLossProbe.mutationId };
      responseLossProbe.hold = false;
      await restartedPage.locator(".save-indicator").click();
      const retried = await savedCheckpoint(restartedPage, label, retained);
      if (
        !responseLossProbe.retriedMutationIds.includes(responseLossProbe.mutationId) ||
        !isDeepStrictEqual(retried.state, persisted.state) ||
        !isDeepStrictEqual(retried.results, persisted.results)
      ) {
        throw new Error("Response-loss retry changed the Undo snapshot or its mutation identity");
      }
      // The store versions each accepted full-snapshot save, including retries;
      // logical idempotence is exact prefix/head/state equality, not revision reuse.
      undoEvidence.responseLoss.retriedRevision = retried.revision;
      undoEvidence.responseLoss.retriedMutationIds = responseLossProbe.retriedMutationIds;
      responseLossProbe = null;
    } else {
      await savedCheckpoint(restartedPage, label, retained);
    }
  };
  for (let index = 0; index < 11; index += 1) {
    await undo(`native-undo-${index + 1}`, index === 1);
    if (index === 3) {
      await restartedPage.reload({ waitUntil: "networkidle" });
      await restartedPage.getByRole("button", { name: "Undo last action", exact: true }).waitFor();
      await savedCheckpoint(restartedPage, "acknowledged-mid-undo-reload", retained);
    }
  }
  if ((await readEnvelope(restartedPage)).current.state.game.day !== 1) {
    throw new Error("Native Undo did not return through the ordinary night into the earlier day");
  }
  const branchParent = retained.at(-1).id;
  const branch = await genuineAction(restartedPage, "Begin night", "new-action-after-discard");
  if (
    branch.state.events.at(-1).parentEventId !== branchParent ||
    branch.state.events.some(({ id }) => discardedIds.has(id)) ||
    branch.state.log.some(({ id }) => discardedIds.has(id))
  ) {
    throw new Error("A new native action resurrected the discarded suffix");
  }
  retained = branch.state.events;
  await restartedPage.reload({ waitUntil: "networkidle" });
  await restartedPage.getByRole("button", { name: "Undo last action", exact: true }).waitFor();
  await savedCheckpoint(restartedPage, "new-branch-reload-no-resurrection", retained);

  while (eligibleEntries(retained).length > 0) await undo("oldest-retained-action");
  if (
    await restartedPage.getByRole("button", { name: "Undo last action", exact: true }).isEnabled()
  ) {
    throw new Error("The initialization-only baseline still permits Undo");
  }
  await restartedPage.reload({ waitUntil: "networkidle" });
  await restartedPage.getByRole("button", { name: "Mafia asleep", exact: true }).waitFor();
  await savedCheckpoint(restartedPage, "baseline-reload-undo-disabled", retained);
  if (
    await restartedPage.getByRole("button", { name: "Undo last action", exact: true }).isEnabled()
  ) {
    throw new Error("Reload re-enabled Undo at the initialization-only baseline");
  }
  await genuineAction(restartedPage, "Mafia asleep", "finish-fixture-sheriff");
  await genuineAction(restartedPage, "Begin round zero", "finish-fixture-day");
  const outcomeBefore = (await readEnvelope(restartedPage)).current.state.events;
  const awardVictory = async (label) => {
    const card = restartedPage.getByRole("button", { name: /^Nominate / }).first();
    await card.scrollIntoViewIfNeeded();
    const box = await card.boundingBox();
    if (box === null) throw new Error("No native player card for the discipline gesture");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await restartedPage.mouse.move(x, y);
    await restartedPage.mouse.down();
    await restartedPage.mouse.move(x, y - 72, { steps: 12 });
    await restartedPage.mouse.up();
    const dialog = restartedPage.getByRole("dialog");
    undoEvidence.outcomeGesture = {
      box,
      hit: await restartedPage.evaluate(
        ({ x, y }) => {
          const element = document.elementFromPoint(x, y);
          return {
            tag: element?.tagName,
            label: element?.closest("button")?.getAttribute("aria-label"),
            text: element?.textContent,
          };
        },
        { x, y },
      ),
      dialogs: await restartedPage
        .locator("dialog")
        .evaluateAll((dialogs) =>
          dialogs.map((dialog) => ({ open: dialog.open, text: dialog.innerText })),
        ),
    };
    await restartedPage.screenshot({
      path: screenshotPath.replace(/\.png$/iu, "-outcome-gesture.png"),
      fullPage: true,
    });
    await dialog
      .getByRole("combobox", { name: /^Discipline action/ })
      .selectOption("opponent-victory");
    await dialog
      .getByLabel("Judge's reason", { exact: true })
      .fill("Synthetic local unlimited Undo qualification");
    await genuineAction(restartedPage, "Award victory to opposing team", label);
  };
  await awardVictory("winner-before-explicit-finish");
  if (
    (await readEnvelope(restartedPage)).current.results !== null ||
    !(await restartedPage
      .getByRole("button", { name: "Undo last action", exact: true })
      .isEnabled())
  ) {
    throw new Error("Reaching a winner incorrectly locked Undo before Finish");
  }
  retained = (await readEnvelope(restartedPage)).current.state.events;
  await undo("winner-still-undoable-before-finish");
  if (!isDeepStrictEqual(retained, outcomeBefore))
    throw new Error("Outcome Undo did not retain its exact prefix");
  await awardVictory("winner-reentered-before-finish");
  responseLossProbe = {
    gameId,
    hold: true,
    accepted: null,
    mutationId: null,
    retryCount: 0,
    retriedMutationIds: [],
  };
  await restartedPage.getByRole("button", { name: "Finish the game", exact: true }).click();
  await restartedPage.waitForFunction(
    (key) => JSON.parse(window.localStorage.getItem(key)).current.results !== null,
    storageKey,
  );
  const finishedEntries = (await readEnvelope(restartedPage)).current.state.events;
  const finishDeadline = Date.now() + 20_000;
  while (responseLossProbe.accepted === null && Date.now() < finishDeadline) await delay(50);
  if (responseLossProbe.accepted === null) throw new Error("Finish never reached the real API");
  const finishedSession = await readAuthoritativeSession(gameId);
  const assertPendingFinish = async (label) => {
    const envelope = await readEnvelope(restartedPage);
    assertBrowserGameEnvelopeOwner(envelope, clubId);
    assertRetainedState(envelope.current.state, finishedEntries, label, true);
    assertRetainedState(finishedSession.state, finishedEntries, label, true);
    if (
      !isDeepStrictEqual(envelope.current.state, finishedSession.state) ||
      !isDeepStrictEqual(envelope.current.results, finishedSession.results) ||
      finishedSession.status !== "completed" ||
      envelope.current.results === null ||
      envelope.outbox.length !== 1 ||
      envelope.outbox[0].mutationId !== responseLossProbe.mutationId ||
      finishedEntries.filter(({ type }) => type === "game.completed").length !== 1
    ) {
      throw new Error(
        `${label}: Finish changed its retained snapshot, result, or pending identity`,
      );
    }
    undoEvidence.checkpoints.push({ label, envelope, authoritative: finishedSession });
  };
  await assertPendingFinish("explicit-finish-pending-lock");
  if (
    await restartedPage.getByRole("button", { name: "Undo last action", exact: true }).isEnabled()
  ) {
    throw new Error("Explicit Finish left Undo enabled");
  }
  await restartedPage.reload({ waitUntil: "networkidle" });
  await restartedPage.getByRole("button", { name: "Undo last action", exact: true }).waitFor();
  await assertPendingFinish("explicit-finish-reload-lock");
  if (
    await restartedPage.getByRole("button", { name: "Undo last action", exact: true }).isEnabled()
  ) {
    throw new Error("Reload unlocked an explicitly finished game");
  }
  responseLossProbe.hold = false;
  await restartedPage.locator(".save-indicator").click();
  await restartedPage.getByRole("heading", { name: "Select players", exact: true }).waitFor();
  if ((await readEnvelope(restartedPage)) !== null) {
    throw new Error("Acknowledged Finish did not clear its durable current-game envelope");
  }
  const completed = await readAuthoritativeSession(gameId);
  assertRetainedState(completed.state, finishedEntries, "acknowledged-finish", true);
  if (
    completed.status !== "completed" ||
    !isDeepStrictEqual(completed.state, finishedSession.state) ||
    !isDeepStrictEqual(completed.results, finishedSession.results) ||
    !responseLossProbe.retriedMutationIds.includes(responseLossProbe.mutationId)
  ) {
    throw new Error("Acknowledged Finish retry changed the completed record or mutation identity");
  }
  undoEvidence.checkpoints.push({ label: "acknowledged-finish", authoritative: completed });
  responseLossProbe = null;
  await restartedPage.reload({ waitUntil: "networkidle" });
  await restartedPage
    .getByRole("button", { name: `Open ${selectedClub.name} in ${selectedClub.city}`, exact: true })
    .click();
  await restartedPage.getByRole("heading", { name: "Select players", exact: true }).waitFor();
  if (
    (await readEnvelope(restartedPage)) !== null ||
    (await restartedPage
      .getByRole("button", { name: "Undo last action", exact: true })
      .isEnabled()) ||
    !isDeepStrictEqual(await readAuthoritativeSession(gameId), completed)
  ) {
    throw new Error(
      "Reload after Finish restored mutable history or changed the completed server record",
    );
  }
  undoEvidence.checkpoints.push({
    label: "acknowledged-finish-reload-lock",
    authoritative: completed,
  });

  const directDelete = await apiContext.delete(`/api/game-sessions/${gameId}`);
  if (directDelete.status() !== 204) throw new Error("Direct server-side delete failed");
  const removedSave = removalPage.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === `/api/game-sessions/${gameId}`,
  );
  await removalPage.getByRole("button", { name: "Announce morning", exact: true }).click();
  if ((await removedSave).status() !== 404)
    throw new Error("The open client recreated a removed game");
  await removalPage
    .getByRole("button", {
      name: "This game was removed from the server. Its local copy will not be recreated.",
      exact: true,
    })
    .waitFor();
  const afterClear = await apiContext.get(`${apiBaseUrl}/api/game-sessions`, {
    maxRedirects: 0,
  });
  const clearedSessions = (await afterClear.json()).sessions;
  if (
    !Array.isArray(clearedSessions) ||
    clearedSessions.some(({ gameId: activeGameId }) => activeGameId.toLowerCase() === gameId)
  ) {
    throw new Error("Cleared session remains active on the server");
  }
  const tombstoned = await apiContext.get(`${apiBaseUrl}/api/game-sessions/${gameId}`, {
    maxRedirects: 0,
  });
  if (tombstoned.status() !== 404) throw new Error("Cleared session remains server-restorable");
  const remainingEnvelope = await removalPage.evaluate(
    (storageKey) => window.localStorage.getItem(storageKey),
    storageKey,
  );
  const removedEnvelope = JSON.parse(remainingEnvelope);
  if (removedEnvelope?.removed !== true || removedEnvelope.outbox.length !== 0) {
    throw new Error("Removed game retained automatic retries or lost its local recovery copy");
  }
  await removalContext.close();
  await restartedContext.close();
} catch (error) {
  verificationError = error instanceof Error ? error : new Error(String(error));
} finally {
  const cleanupAttempt = async (label, action) => {
    try {
      await runCleanupActions([{ label, run: action }]);
    } catch (error) {
      cleanupErrors.push(
        ...(error instanceof AggregateError
          ? error.errors
          : [error instanceof Error ? error : new Error(String(error))]),
      );
    }
  };
  await cleanupAttempt("browser response drain", () => responseTracker.drain());
  for (const gameId of createdGameIds) {
    await cleanupAttempt(`verification session cleanup ${gameId}`, async () => {
      const stored = await apiContext.get(`/api/game-sessions/${gameId}`, { maxRedirects: 0 });
      if (stored.status() === 404) return;
      if (!stored.ok()) {
        throw new Error(`Unable to inspect verification session cleanup: HTTP ${stored.status()}`);
      }
      const response = await apiContext.delete(`/api/game-sessions/${gameId}`, {
        maxRedirects: 0,
      });
      if (!response.ok() && response.status() !== 404) {
        throw new Error(`Unable to clean up a verification session: HTTP ${response.status()}`);
      }
      const readback = await apiContext.get(`/api/game-sessions/${gameId}`, { maxRedirects: 0 });
      if (readback.status() !== 404) {
        throw new Error("Verifier-owned session remains after cleanup");
      }
    });
  }
  for (const playerId of [...createdPlayerIds].reverse()) {
    await cleanupAttempt(`verification player cleanup ${playerId}`, () =>
      deleteAndVerifyAbsent("Verifier-owned player", async () =>
        (
          await apiContext.delete(`/api/players/${playerId}`, {
            maxRedirects: 0,
          })
        ).status(),
      ),
    );
  }
  await cleanupAttempt("API context close", () => apiContext.dispose());
  await cleanupAttempt("browser close", () => browser.close());
  mkdirSync(dirname(undoEvidencePath), { recursive: true });
  writeFileSync(
    undoEvidencePath,
    `${JSON.stringify(
      {
        ...undoEvidence,
        pass: verificationError === null && cleanupErrors.length === 0,
        failure: verificationError?.message ?? null,
        cleanupErrors: cleanupErrors.map(({ message }) => message),
      },
      null,
      2,
    )}\n`,
  );
}

const failures = [...(verificationError === null ? [] : [verificationError]), ...cleanupErrors];
if (failures.length > 0) {
  throw new AggregateError(failures, "Session verification or cleanup failed");
}
console.log(
  `Authoritative ${restartGateDirectory === undefined ? "browser" : "application"} restart verification: PASS (${screenshotPath})`,
);
console.log(
  `Unlimited Undo persistence verification: PASS (${undoEvidence.nativeUndoCount} native Undos; ${undoEvidence.checkpoints.length} canonical/API checkpoints; ${undoEvidencePath})`,
);

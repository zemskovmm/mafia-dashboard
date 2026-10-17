/* global AbortController, AbortSignal, URL, fetch */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { clearTimeout } from "node:timers";
import { chromium } from "@playwright/test";
import { tsImport } from "tsx/esm/api";
import { ownedAzuriteEnvironment } from "./test-local.mjs";
import { verifyCompletedRecords } from "./verify-completed-records.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultPorts = new Set([3000, 5173]);
const syntheticGoogleClientId = "local-backend-verifier-client";
const syntheticGoogleClientSecret = "local-backend-verifier-secret";
const sessionCookieName = "mafia_session";
const evidenceDirectory = resolve(repositoryRoot, ".AI/local-backend");
const timeoutMs = 30_000;

class VerifierError extends Error {
  constructor(message, options = undefined) {
    super(message, options);
    this.name = "VerifierError";
  }
}

export const assertLoopbackHttpOrigin = (candidate) => {
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new VerifierError("A verifier origin must be a valid loopback HTTP URL");
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new VerifierError("A verifier origin must be an exact 127.0.0.1 HTTP origin");
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new VerifierError("A verifier origin must use a valid loopback port");
  }
  if (defaultPorts.has(port)) {
    throw new VerifierError("A verifier origin must not use an application default port");
  }
  return parsed.origin;
};

const inheritedEnvironmentWhitelist = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "TERM",
  "CI",
  "TZ",
];

const cleanInheritedEnvironment = (inheritedEnv) => {
  const environment = {};
  for (const key of inheritedEnvironmentWhitelist) {
    if (inheritedEnv[key] !== undefined) environment[key] = inheritedEnv[key];
  }
  return { ...environment, LC_ALL: "C" };
};

export const buildVerifierEnvironment = ({
  apiPort,
  storage,
  inheritedEnv = process.env,
  webPort,
}) => {
  const apiOrigin = assertLoopbackHttpOrigin(`http://127.0.0.1:${apiPort}`);
  const webOrigin = assertLoopbackHttpOrigin(`http://127.0.0.1:${webPort}`);
  if (apiOrigin === webOrigin) {
    throw new VerifierError("The API and Vite verifier origins must use separate ports");
  }
  const verifiedStorage = ownedAzuriteEnvironment(storage);
  const base = cleanInheritedEnvironment(inheritedEnv);
  const serverEnv = {
    ...base,
    APP_COMMIT: "unknown",
    ...verifiedStorage,
    GOOGLE_CLIENT_ID: syntheticGoogleClientId,
    GOOGLE_CLIENT_SECRET: syntheticGoogleClientSecret,
    HOST: "127.0.0.1",
    PORT: String(apiPort),
    PUBLIC_APP_URL: webOrigin,
  };
  const webEnv = {
    ...base,
    HOST: "127.0.0.1",
    MAFIA_API_PROXY_TARGET: apiOrigin,
    PORT: String(webPort),
  };
  return { apiOrigin, serverEnv, webEnv, webOrigin };
};

export const sanitizeDiagnostic = (value) =>
  String(value)
    .replace(
      /\b(?:mafia_session|SESSION_AUTH_COOKIE)\s*[=:]\s*[^;\s]+/giu,
      "session=[redacted-cookie]",
    )
    .replace(/\bpostgres(?:ql)?:\/\/[^\s]+/giu, "[redacted-postgres-url]")
    .replace(
      /\b(?:AZURE_STORAGE_CONNECTION_STRING\s*[=:]\s*)?DefaultEndpointsProtocol=[^\s]+/giu,
      "[redacted-storage-connection]",
    )
    .replace(/\bAccountKey\s*=\s*[^;\s]+/giu, "AccountKey=[redacted]")
    .replace(
      /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY|COOKIE)\s*[=:]\s*\S+/gu,
      "[redacted-credential]",
    )
    .replace(/\b(local-backend-verifier-secret)\b/gu, "[redacted]");

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const throwIfAborted = (signal) => {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new VerifierError("Verifier execution was interrupted");
  }
};

const reserveLoopbackPort = async () => {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
  });
  const address = server.address();
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  if (address === null || typeof address === "string" || defaultPorts.has(address.port)) {
    throw new VerifierError("Could not reserve a non-default loopback verifier port");
  }
  return address.port;
};

const appendOutput = (buffer, chunk) => {
  const next = `${buffer}${chunk.toString()}`;
  return next.slice(-12_000);
};

const startChild = ({ args, command, cwd, env, label }) => {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stderr: "", stdout: "" };
  child.stdout?.on("data", (chunk) => {
    output.stdout = appendOutput(output.stdout, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output.stderr = appendOutput(output.stderr, chunk);
  });
  const tracked = { child, label, output, spawnError: null };
  child.once("error", (error) => {
    tracked.spawnError = error;
  });
  return tracked;
};

const childFailure = ({ child, label, output, spawnError }) => {
  const detail = sanitizeDiagnostic(
    [spawnError instanceof Error ? spawnError.message : "", output.stdout, output.stderr]
      .filter((entry) => entry !== "")
      .join("\n"),
  );
  return new VerifierError(
    `${label} exited before becoming ready (exit ${child.exitCode ?? "unknown"}${
      detail === "" ? "" : `; ${detail}`
    })`,
  );
};

const stopChild = async (tracked) => {
  if (
    tracked === null ||
    tracked.child.exitCode !== null ||
    tracked.child.signalCode !== null ||
    tracked.spawnError !== null
  )
    return;
  const exited = once(tracked.child, "exit");
  try {
    tracked.child.kill("SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    return;
  }
  const finished = await Promise.race([exited.then(() => true), delay(5_000).then(() => false)]);
  if (finished) return;
  try {
    tracked.child.kill("SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  await Promise.race([exited, delay(5_000)]);
};

const runChild = async ({ signal, timeout = timeoutMs, ...options }) => {
  const tracked = startChild(options);
  try {
    const result = await new Promise((resolveResult, rejectResult) => {
      const timeoutHandle = setTimeout(
        () => rejectResult(new VerifierError(`${tracked.label} exceeded its ${timeout}ms timeout`)),
        timeout,
      );
      const cleanup = () => {
        clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", onAbort);
        tracked.child.off("error", onError);
        tracked.child.off("exit", onExit);
      };
      const onAbort = () => {
        cleanup();
        rejectResult(signal.reason ?? new VerifierError(`${tracked.label} was interrupted`));
      };
      const onError = () => {
        cleanup();
        rejectResult(childFailure(tracked));
      };
      const onExit = (code, exitSignal) => {
        cleanup();
        resolveResult({ code, signal: exitSignal });
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      tracked.child.once("error", onError);
      tracked.child.once("exit", onExit);
    });
    if (result.code !== 0) throw childFailure(tracked);
  } finally {
    await stopChild(tracked);
  }
};

const waitForHttp = async ({ label, signal, tracked, url }) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (tracked?.spawnError !== null && tracked?.spawnError !== undefined) {
      throw childFailure(tracked);
    }
    if (tracked !== undefined && tracked.child.exitCode !== null) {
      throw childFailure(tracked);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new VerifierError(
    `${label} did not become ready${
      tracked === undefined
        ? ""
        : `; ${sanitizeDiagnostic(`${tracked.output.stdout}\n${tracked.output.stderr}`)}`
    }${lastError === null ? "" : `: ${sanitizeDiagnostic(lastError)}`}`,
  );
};

const waitForRestartMarker = async (directory, signal) => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      const marker = await readFile(join(directory, "ready"));
      if (marker.length !== 0) throw new VerifierError("Restart marker must be empty");
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(100);
  }
  throw new VerifierError("Authoritative session verifier did not request an API restart");
};

const apiResponse = async ({
  apiOrigin,
  clubId,
  path,
  token,
  method = "GET",
  payload,
  origin = apiOrigin,
}) => {
  const headers = { origin };
  if (token !== undefined) headers.cookie = `${sessionCookieName}=${token}`;
  if (clubId !== undefined) headers["x-club-id"] = clubId;
  if (payload !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(new URL(path, apiOrigin), {
    headers,
    method,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let body;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { body, status: response.status };
};

const expectStatus = (response, expected, label) => {
  if (response.status !== expected) {
    throw new VerifierError(`${label} returned HTTP ${response.status}, expected ${expected}`);
  }
};

export const makeSession = async (accounts, { displayName, expiresAt }) => {
  const token = randomBytes(32).toString("base64url");
  const userId = randomUUID();
  const tokenHash = createHash("sha256").update(token).digest();
  await accounts.upsertUser({
    id: userId,
    subject: `local-backend-verifier:${userId}`,
    email: `${userId}@local-backend-verifier.invalid`,
    name: displayName,
    picture: null,
  });
  await accounts.saveSession(userId, tokenHash, expiresAt);
  return { token, tokenHash, userId };
};

const openPlayersScreen = async (page, { clubName, clubCity, reopenPortal = false }) => {
  if (reopenPortal) {
    await page
      .getByRole("button", { exact: true, name: `Open ${clubName} in ${clubCity}` })
      .click();
  }
  await page
    .getByRole("button", { exact: true, name: "Open Manage menu" })
    .waitFor({ state: "visible" });
  await page.getByRole("button", { exact: true, name: "Open Manage menu" }).click();
  await page.getByRole("button", { exact: true, name: "Players screen" }).click();
  await page.getByLabel("New player nickname").waitFor({ state: "visible" });
};

const writeEvidence = async ({ error, stages, status }) => {
  await mkdir(evidenceDirectory, { recursive: true });
  const filename = `run-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`;
  const evidence = {
    browser: "chromium",
    externalGoogleContacted: false,
    limitations: [
      "Synthetic Azure account/session records validate real cookie lookup, not Google OAuth consent or token exchange.",
      "Chromium is the required browser coverage; WebKit/iPad coverage is not included in this smoke verifier.",
    ],
    status,
    ...(error === undefined ? {} : { error: sanitizeDiagnostic(error) }),
    stages,
  };
  await writeFile(
    resolve(evidenceDirectory, filename),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );
  console.log(`Local backend verification ${status}: ${stages.length} completed stages.`);
  console.log(`Evidence: ${resolve(evidenceDirectory, filename)}`);
};

const verify = async () => {
  const stages = [];
  const pass = (name, details = {}) => stages.push({ name, status: "passed", ...details });
  let azurite = null;
  let azure = null;
  let server = null;
  let vite = null;
  let browser = null;
  let browserContext = null;
  let sessionVerifierResult = null;
  let failure;
  const initialSignalListenerCounts = {
    SIGINT: process.listenerCount("SIGINT"),
    SIGTERM: process.listenerCount("SIGTERM"),
  };
  const signalController = new AbortController();
  const interrupt = (name) => {
    if (signalController.signal.aborted) return;
    signalController.abort(new VerifierError(`Verifier interrupted by ${name}`));
    for (const tracked of [vite, server]) {
      if (tracked?.child.exitCode === null) tracked.child.kill("SIGTERM");
    }
    void browserContext?.close();
    void browser?.close();
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    const { startAzurite } = await import("./local-azurite.mjs");
    azurite = await startAzurite({ mode: "test" });
    throwIfAborted(signalController.signal);
    const storage = ownedAzuriteEnvironment(azurite.environment);
    pass("owned-loopback-azurite-started");

    const [apiPort, webPort] = await Promise.all([reserveLoopbackPort(), reserveLoopbackPort()]);
    const { apiOrigin, serverEnv, webEnv, webOrigin } = buildVerifierEnvironment({
      apiPort,
      storage,
      webPort,
    });

    const { createAzureStores } = await tsImport(
      "../apps/server/src/azure-stores.ts",
      import.meta.url,
    );
    azure = createAzureStores({
      connectionString: storage.AZURE_STORAGE_CONNECTION_STRING,
      tableName: storage.AZURE_STORAGE_TABLE_NAME,
      containerName: storage.AZURE_STORAGE_CONTAINER_NAME,
      partitionKey: storage.AZURE_STORAGE_PARTITION_KEY,
    });
    await azure.initialize();
    pass("owned-azure-storage-initialized");

    const startServer = async () => {
      if (server !== null)
        throw new VerifierError("Attempted to start an already-running verifier API");
      server = startChild({
        args: ["--import", "tsx", "apps/server/src/main.ts"],
        command: process.execPath,
        cwd: repositoryRoot,
        env: serverEnv,
        label: "verifier API",
      });
      await waitForHttp({
        label: "verifier API",
        signal: signalController.signal,
        tracked: server,
        url: `${apiOrigin}/health/ready`,
      });
      if (server.child.exitCode !== null) throw childFailure(server);
    };

    await startServer();
    vite = startChild({
      args: ["--host", "127.0.0.1", "--port", String(webPort), "--strictPort"],
      command: resolve(repositoryRoot, "node_modules/.bin/vite"),
      cwd: resolve(repositoryRoot, "apps/web"),
      env: webEnv,
      label: "verifier Vite frontend",
    });
    await waitForHttp({
      label: "verifier Vite frontend",
      signal: signalController.signal,
      tracked: vite,
      url: webOrigin,
    });
    if (vite.child.exitCode !== null) throw childFailure(vite);
    pass("real-api-and-vite-started");

    const anonymousSession = await apiResponse({ apiOrigin, path: "/api/auth/session" });
    expectStatus(anonymousSession, 200, "anonymous session lookup");
    if (anonymousSession.body?.configured !== true || anonymousSession.body?.user !== null) {
      throw new VerifierError(
        "Anonymous session lookup did not report configured local authentication",
      );
    }
    expectStatus(
      await apiResponse({ apiOrigin, path: "/api/clubs" }),
      401,
      "anonymous protected club access",
    );
    pass("anonymous-access-denied");

    const owner = await makeSession(azure.auth, {
      displayName: "Local Backend Owner",
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });
    const secondUser = await makeSession(azure.auth, {
      displayName: "Local Backend Stranger",
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });
    const expired = await makeSession(azure.auth, {
      displayName: "Local Backend Expired",
      expiresAt: new Date(Date.now() - 60_000),
    });
    pass("synthetic-hashed-sessions-seeded");

    browser = await chromium.launch({ headless: true });
    browserContext = await browser.newContext();
    await browserContext.addCookies([
      {
        httpOnly: true,
        name: sessionCookieName,
        sameSite: "Lax",
        secure: true,
        url: webOrigin,
        value: owner.token,
      },
    ]);
    const page = await browserContext.newPage();
    page.setDefaultNavigationTimeout(15_000);
    page.setDefaultTimeout(15_000);
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(sanitizeDiagnostic(error)));

    await page.goto(webOrigin, { waitUntil: "domcontentloaded" });
    const browserSession = await page.evaluate(async () => {
      const response = await fetch("/api/auth/session");
      return { body: await response.json(), status: response.status };
    });
    if (
      browserSession.status !== 200 ||
      browserSession.body?.configured !== true ||
      browserSession.body?.user === null
    ) {
      throw new VerifierError(
        "The browser did not send its seeded cookie through the real Vite API proxy",
      );
    }
    pass("chromium-secure-loopback-cookie-sent", { statusCode: 200 });
    const newClubButton = page.getByRole("button", { name: /^New club\b/u });
    try {
      await newClubButton.waitFor({ state: "visible" });
    } catch (error) {
      throw new VerifierError(
        `Authenticated portal did not render a New club control (${browserErrors.length} browser error(s)): ${sanitizeDiagnostic(error)}`,
      );
    }
    const clubName = "Verifier Club";
    const clubCity = "Loopback";
    await newClubButton.click();
    const editor = page.getByRole("region", { name: "Club details" });
    await editor.getByLabel("Club name").fill(clubName);
    await editor.getByLabel("City").fill(clubCity);
    await editor.getByLabel(/I consent to store my Google name and email/iu).check();
    const clubCreated = page.waitForResponse(
      (response) =>
        response.url() === `${webOrigin}/api/clubs` && response.request().method() === "POST",
    );
    await editor.getByRole("button", { exact: true, name: "Save club" }).click();
    const clubResponse = await clubCreated;
    if (clubResponse.status() !== 201) {
      throw new VerifierError(
        `Club creation through the browser returned HTTP ${clubResponse.status()}`,
      );
    }
    const clubPayload = await clubResponse.json();
    const clubId = clubPayload?.club?.id;
    if (typeof clubId !== "string") {
      throw new VerifierError("Club creation response did not include a club ID");
    }
    await page
      .getByRole("button", { exact: true, name: `Open ${clubName} in ${clubCity}` })
      .waitFor({
        state: "visible",
      });
    pass("club-created-through-real-ui", { statusCode: 201 });

    await openPlayersScreen(page, { clubCity, clubName, reopenPortal: true });
    const playerName = "Verifier Player";
    await page.getByLabel("New player nickname").fill(playerName);
    const playerCreated = page.waitForResponse(
      (response) =>
        response.url() === `${webOrigin}/api/players` && response.request().method() === "POST",
    );
    await page.getByRole("button", { exact: true, name: "Add player" }).click();
    const playerResponse = await playerCreated;
    if (playerResponse.status() !== 201) {
      throw new VerifierError(
        `Player creation through the browser returned HTTP ${playerResponse.status()}`,
      );
    }
    const playerPayload = await playerResponse.json();
    if (playerPayload?.player?.nickname !== playerName) {
      throw new VerifierError("Player creation response did not contain the submitted nickname");
    }
    await page.getByText(playerName, { exact: true }).last().waitFor({ state: "visible" });
    pass("player-created-through-real-ui", { statusCode: 201 });

    await page.reload({ waitUntil: "networkidle" });
    await openPlayersScreen(page, { clubCity, clubName, reopenPortal: true });
    await page.getByText(playerName, { exact: true }).last().waitFor({ state: "visible" });
    const persistedBeforeRestart = await apiResponse({
      apiOrigin,
      clubId,
      path: "/api/players",
      token: owner.token,
    });
    expectStatus(persistedBeforeRestart, 200, "player readback after browser reload");
    if (!persistedBeforeRestart.body?.players?.some(({ nickname }) => nickname === playerName)) {
      throw new VerifierError("Persisted player was missing after browser reload");
    }
    pass("reload-persistence-readback");

    await stopChild(server);
    server = null;
    await startServer();
    const persistedAfterRestart = await apiResponse({
      apiOrigin,
      path: "/api/clubs",
      token: owner.token,
    });
    expectStatus(persistedAfterRestart, 200, "club readback after API restart");
    if (
      !persistedAfterRestart.body?.clubs?.some(({ id, name }) => id === clubId && name === clubName)
    ) {
      throw new VerifierError("Persisted club was missing after API restart");
    }
    await page.reload({ waitUntil: "networkidle" });
    await openPlayersScreen(page, { clubCity, clubName, reopenPortal: true });
    await page.getByText(playerName, { exact: true }).last().waitFor({ state: "visible" });
    pass("server-restart-persistence-readback");

    await mkdir(evidenceDirectory, { recursive: true });
    const restartGateDirectory = await mkdtemp(join(evidenceDirectory, "restart-gate-"));
    sessionVerifierResult = runChild({
      args: ["scripts/verify-session-state.mjs"],
      command: process.execPath,
      cwd: repositoryRoot,
      env: {
        ...cleanInheritedEnvironment(process.env),
        APP_URL: webOrigin,
        SESSION_AUTH_COOKIE: `${sessionCookieName}=${owner.token}`,
        SESSION_CLUB_ID: clubId,
        SESSION_RESTART_GATE_DIR: restartGateDirectory,
        SESSION_RESTART_TIMEOUT_MS: "120000",
        SESSION_SCREENSHOT: resolve(evidenceDirectory, "game-record-restored.png"),
      },
      label: "server-backed game record browser verification",
      signal: signalController.signal,
      timeout: 240_000,
    }).then(
      () => ({ error: null }),
      (error) => ({ error }),
    );
    await Promise.race([
      waitForRestartMarker(restartGateDirectory, signalController.signal),
      sessionVerifierResult.then(({ error }) => {
        throw error ?? new VerifierError("Session verifier exited before requesting the restart");
      }),
    ]);
    const serverExited = once(server.child, "exit");
    if (!server.child.kill("SIGKILL"))
      throw new VerifierError("Owned API process could not be killed");
    await serverExited;
    server = null;
    await startServer();
    await writeFile(join(restartGateDirectory, "continue"), "", { flag: "wx", mode: 0o600 });
    const sessionResult = await sessionVerifierResult;
    if (sessionResult.error !== null) throw sessionResult.error;
    pass("authoritative-game-survives-api-sigkill-restart");
    pass("game-record-browser-create-restore-delete");

    const deniedSecondUser = await apiResponse({
      apiOrigin,
      clubId,
      path: "/api/players",
      token: secondUser.token,
    });
    expectStatus(deniedSecondUser, 403, "second-user guessed club access");
    pass("cross-user-club-access-denied", { statusCode: 403 });

    await verifyCompletedRecords({
      page,
      player: playerPayload.player,
      evidenceDirectory,
      pass,
      request: (options) =>
        apiResponse({ ...options, apiOrigin, clubId, token: owner.token, origin: webOrigin }),
    });

    await azure.auth.removeSession(owner.tokenHash);
    expectStatus(
      await apiResponse({ apiOrigin, path: "/api/clubs", token: owner.token }),
      401,
      "revoked session protected access",
    );
    expectStatus(
      await apiResponse({ apiOrigin, path: "/api/clubs", token: expired.token }),
      401,
      "expired session protected access",
    );
    pass("revoked-and-expired-session-access-denied", { statusCode: 401 });

    if (browserErrors.length > 0) {
      throw new VerifierError(`Browser reported application errors: ${browserErrors.join("; ")}`);
    }
    pass("chromium-browser-flow-clean");
  } catch (error) {
    failure = error instanceof Error ? error : new VerifierError(sanitizeDiagnostic(error));
  } finally {
    signalController.abort(new VerifierError("Verifier cleanup"));
    const cleanupFailures = [];
    for (const cleanup of [
      async () => sessionVerifierResult,
      async () => browserContext?.close(),
      async () => browser?.close(),
      async () => stopChild(vite),
      async () => stopChild(server),
      async () => azure?.end(),
      async () => azurite?.stop(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupFailures.push(sanitizeDiagnostic(error));
      }
    }
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (
      process.listenerCount("SIGINT") !== initialSignalListenerCounts.SIGINT ||
      process.listenerCount("SIGTERM") !== initialSignalListenerCounts.SIGTERM
    ) {
      cleanupFailures.push("Verifier signal listeners were not fully released");
    }
    if (cleanupFailures.length > 0) {
      const cleanupError = new VerifierError(
        `Verifier cleanup failed: ${cleanupFailures.join("; ")}`,
      );
      failure =
        failure === undefined
          ? cleanupError
          : new AggregateError([failure, cleanupError], "Verifier failed");
    }
  }

  try {
    await writeEvidence({
      ...(failure === undefined ? {} : { error: failure }),
      stages,
      status: failure === undefined ? "passed" : "failed",
    });
  } catch (error) {
    const evidenceError = new VerifierError(
      `Could not write sanitized verifier evidence: ${sanitizeDiagnostic(error)}`,
    );
    failure =
      failure === undefined
        ? evidenceError
        : new AggregateError([failure, evidenceError], "Verifier failed");
  }

  if (failure !== undefined) throw failure;
};

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  verify().catch((error) => {
    const diagnostic = sanitizeDiagnostic(
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    console.error(`Local backend verification failed: ${diagnostic}`);
    process.exitCode = diagnostic.includes("Verifier interrupted by SIGINT") ? 130 : 1;
  });
}

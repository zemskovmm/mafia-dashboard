/* global URL, fetch, AbortSignal */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { composeAppVersion } from "./release-verifier-contracts.mjs";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const { version: packageVersion } = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
const buildIndex = process.env.APP_BUILD_INDEX ?? "0";
const appVersion = composeAppVersion(packageVersion, buildIndex);
const appCommitResult = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd,
  encoding: "utf8",
});
if (appCommitResult.status !== 0 || !/^[0-9a-f]{40}\n?$/.test(appCommitResult.stdout)) {
  throw new Error("Production Compose verification requires an exact Git commit");
}
const trackedStatusResult = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], {
  cwd,
  encoding: "utf8",
});
if (trackedStatusResult.status !== 0) {
  throw new Error("Production Compose verification could not inspect tracked files");
}
const trackedStatus = trackedStatusResult.stdout.trim();
const appCommit = trackedStatus === "" ? appCommitResult.stdout.trim() : "unknown";
const project = `mafia-dashboard-smoke-${process.pid}`;
const image = `mafia-dashboard:smoke-${process.pid}`;
const overridePath = join(tmpdir(), `${project}-crash-override.yaml`);
const restartGateDirectory = mkdtempSync(join(tmpdir(), `${project}-restart-`));
const crashCommand =
  'node apps/server/dist/main.js & child=$$!; printf "%s" "$$child" > /tmp/mafia-app.pid; wait "$$child"; exit $$?';
writeFileSync(
  overridePath,
  `services:\n  app:\n    entrypoint: ["/bin/sh", "-c"]\n    command: [${JSON.stringify(crashCommand)}]\n`,
);

const findFreePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Unable to reserve a smoke-test port"));
        return;
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });

const port = await findFreePort();

const sessionToken = randomUUID();
const sessionHash = createHash("sha256").update(sessionToken).digest("hex");
const clubId = "00000000-0000-4000-8000-000000000101";
const postgresPassword = "mafia-smoke-only";
const databaseUrl = `postgresql://mafia:${postgresPassword}@db:5432/mafia`;
const env = {
  ...process.env,
  APP_COMMIT: appCommit,
  APP_BUILD_INDEX: buildIndex,
  APP_BIND: "127.0.0.1",
  APP_IMAGE: image,
  APP_PORT: String(port),
  DATABASE_URL: databaseUrl,
  GOOGLE_CLIENT_ID: "compose-smoke.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "compose-smoke-secret",
  GOOGLE_OAUTH_REDIRECT_URI: "",
  MUSIC_TOKEN_ENCRYPTION_KEY: "",
  POSTGRES_DB: "mafia",
  POSTGRES_PASSWORD: postgresPassword,
  POSTGRES_USER: "mafia",
  PUBLIC_APP_URL: `http://127.0.0.1:${port}`,
  VITE_YOUTUBE_PLAYLIST_ID: "",
};
const prefix = [
  "compose",
  "--project-name",
  project,
  "--file",
  join(cwd, "compose.yaml"),
  "--file",
  overridePath,
];

const requireCondition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const boundedOutput = (value, limit = 64 * 1024) =>
  value.length <= limit ? value : `${value.slice(0, limit)}\n[truncated]`;
const redact = (value) =>
  [sessionToken, sessionHash, postgresPassword].reduce(
    (redacted, secret) => redacted.replaceAll(secret, "[redacted]"),
    value,
  );
const markerPath = (name) => join(restartGateDirectory, name);
const writeRestartMarker = (name) =>
  writeFileSync(markerPath(name), "", { flag: "wx", mode: 0o600 });
const waitForMarker = async (name) => {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const state = lstatSync(markerPath(name));
      if (!state.isFile() || state.isSymbolicLink()) {
        throw new Error(`Restart marker ${name} is not a regular file`);
      }
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for restart marker ${name}`);
};

const collectChild = (child) => {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout = boundedOutput(stdout + String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderr = boundedOutput(stderr + String(chunk));
  });
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ error, status: null, signal: null, stderr, stdout }));
    child.once("exit", (status, signal) =>
      resolve({ error: null, status, signal, stderr, stdout }),
    );
  });
};

const assertSessionVerifierPassed = (result) => {
  if (result.error === null && result.status === 0 && result.signal === null) return;
  const detail = redact(result.stderr || result.stdout || result.error?.message || "unknown error");
  throw new Error(
    `Authoritative restart verifier failed (${result.signal ?? result.status ?? "spawn"}): ${detail}`,
  );
};

const run = (args, { allowFailure = false, capture = false, environment = {} } = {}) => {
  const result = spawnSync("docker", [...prefix, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...env, ...environment },
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const detail = capture ? `\n${result.stderr || result.stdout}` : "";
    throw new Error(`docker compose ${args.join(" ")} failed with ${result.status}${detail}`);
  }
  return result;
};

const serviceState = (name) => {
  const output = run(["ps", "--all", "--format", "json", name], { capture: true }).stdout.trim();
  if (output === "") throw new Error(`Compose service ${name} was not created`);
  return JSON.parse(output.split("\n")[0]);
};

const restartCount = (name) => {
  const containerId = run(["ps", "--quiet", name], { capture: true }).stdout.trim();
  if (containerId === "") throw new Error(`Compose service ${name} has no container ID`);
  const inspected = spawnSync("docker", ["inspect", "--format", "{{.RestartCount}}", containerId], {
    cwd,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (inspected.error !== undefined) throw inspected.error;
  if (inspected.status !== 0) {
    throw new Error(`Unable to inspect ${name} restart count: ${inspected.stderr}`);
  }
  return Number(inspected.stdout.trim());
};

const sigkillContainerProcess = (name) => {
  const killed = run(
    ["exec", "--no-TTY", name, "sh", "-c", 'kill -KILL "$(cat /tmp/mafia-app.pid)"'],
    { allowFailure: true, capture: true },
  );
  if (killed.status !== 0) {
    throw new Error(`Unable to SIGKILL ${name}: ${killed.stderr || killed.stdout}`);
  }
};

const waitForRestartPolicy = async (name) => {
  const containerId = run(["ps", "--quiet", name], { capture: true }).stdout.trim();
  if (containerId === "") throw new Error(`Compose service ${name} has no container ID`);
  const inspected = spawnSync(
    "docker",
    ["inspect", "--format", "{{.State.StartedAt}}", containerId],
    { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (inspected.error !== undefined) throw inspected.error;
  if (inspected.status !== 0) {
    throw new Error(`Unable to inspect ${name} start time: ${inspected.stderr}`);
  }
  const startedAt = Date.parse(inspected.stdout.trim());
  if (!Number.isFinite(startedAt)) throw new Error(`Invalid ${name} start time`);
  const remaining = 11_000 - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
};

const assertExitedZero = (name) => {
  const state = serviceState(name);
  if (state.State !== "exited" || Number(state.ExitCode) !== 0) {
    throw new Error(`${name} did not exit cleanly: ${JSON.stringify(state)}`);
  }
};

const waitUntilReady = async () => {
  const url = `http://127.0.0.1:${port}/health/ready`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok && (await response.json()).status === "ready") return;
    } catch {
      // The container may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Application did not become ready at ${url}`);
};

const waitForRestart = async (name, before) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const current = restartCount(name);
      if (current > before) return current;
    } catch {
      // Docker may briefly hide the restarting container.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The ${name} container did not automatically restart after SIGKILL`);
};

let validationFailed = false;
let validationFailure;
let sessionVerifier;
let sessionVerifierResult;
try {
  const rendered = JSON.parse(run(["config", "--format", "json"], { capture: true }).stdout);
  const { app, db, migrate } = rendered.services;
  requireCondition(app.image === migrate.image, "App and migration services use different images");
  requireCondition(
    app.depends_on?.migrate?.condition === "service_completed_successfully",
    "App startup is not gated on migration completion",
  );
  requireCondition(
    migrate.depends_on?.db?.condition === "service_healthy",
    "Migration startup is not gated on bundled PostgreSQL health",
  );
  requireCondition(
    app.ports?.[0]?.host_ip === "127.0.0.1",
    "Application port is not bound to loopback",
  );
  for (const [name, service] of [
    ["app", app],
    ["db", db],
  ]) {
    requireCondition(service.logging?.driver === "local", `${name} does not use local logging`);
    requireCondition(
      service.logging?.options?.["max-size"] === "10m" &&
        service.logging?.options?.["max-file"] === "3",
      `${name} logging is not bounded`,
    );
  }

  const externalDatabaseUrl =
    "postgresql://mafia:external@db.example.test/mafia?sslmode=verify-full";
  const external = JSON.parse(
    run(
      [
        "--file",
        "compose.yaml",
        "--file",
        "compose.external-db.yaml",
        "config",
        "--format",
        "json",
      ],
      { capture: true, environment: { DATABASE_URL: externalDatabaseUrl } },
    ).stdout,
  );
  requireCondition(
    external.services.db === undefined,
    "External-DB overlay still starts bundled DB",
  );
  requireCondition(
    external.services.migrate.depends_on === undefined ||
      external.services.migrate.depends_on === null,
    "External-DB migration still depends on bundled DB",
  );
  requireCondition(
    external.services.app.environment.DATABASE_URL === externalDatabaseUrl &&
      external.services.migrate.environment.DATABASE_URL === externalDatabaseUrl,
    "External DATABASE_URL is not passed unchanged",
  );

  run(["build", "app"]);

  const failedMigration = run(["up", "--detach", "--no-build", "--pull", "never", "app"], {
    allowFailure: true,
    capture: true,
    environment: {
      DATABASE_URL: "postgresql://mafia:unreachable@127.0.0.1:1/mafia",
    },
  });
  if (failedMigration.status === 0) {
    throw new Error("An unreachable migration database did not stop Compose startup");
  }
  const blockedApp = run(["ps", "--all", "--format", "json", "app"], {
    capture: true,
    environment: {
      DATABASE_URL: "postgresql://mafia:unreachable@127.0.0.1:1/mafia",
    },
  }).stdout.trim();
  if (blockedApp !== "" && JSON.parse(blockedApp.split("\n")[0]).State === "running") {
    throw new Error("The app started after its migration dependency failed");
  }
  const failedAttemptCleanup = run(["down", "--volumes", "--remove-orphans"], {
    allowFailure: true,
    capture: true,
  });
  if (failedAttemptCleanup.status !== 0) {
    throw new Error("Unable to clean up the deliberately failed migration attempt");
  }

  const startup = run(["up", "--detach", "--no-build", "--pull", "never", "--wait"], {
    allowFailure: true,
    capture: true,
  });
  if (startup.status !== 0) {
    const logs = run(["logs", "--no-color", "migrate", "app"], {
      allowFailure: true,
      capture: true,
    });
    throw new Error(
      `Production Compose startup failed:\n${startup.stderr || startup.stdout}\n${logs.stdout || logs.stderr}`,
    );
  }
  assertExitedZero("migrate");
  await waitUntilReady();
  const identityResponse = await fetch(`http://127.0.0.1:${port}/health/version`, {
    redirect: "manual",
  });
  if (!identityResponse.ok) throw new Error("Application release identity endpoint failed");
  const identity = await identityResponse.json();
  if (identity.version !== appVersion || identity.commit !== appCommit) {
    throw new Error("Application release identity does not match the Compose candidate");
  }

  run([
    "exec",
    "--no-TTY",
    "db",
    "psql",
    "--username",
    "mafia",
    "--dbname",
    "mafia",
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    `INSERT INTO user_sessions (id, token_hash, user_id, expires_at) VALUES ('${randomUUID()}', decode('${sessionHash}', 'hex'), '00000000-0000-4000-8000-000000000001', NOW() + INTERVAL '1 hour');`,
  ]);

  sessionVerifier = spawn(process.execPath, ["scripts/verify-session-state.mjs"], {
    cwd,
    env: {
      ...process.env,
      APP_URL: `http://127.0.0.1:${port}`,
      SESSION_AUTH_COOKIE: `mafia_session=${sessionToken}`,
      SESSION_CLUB_ID: clubId,
      SESSION_RESTART_GATE_DIR: restartGateDirectory,
      SESSION_RESTART_TIMEOUT_MS: "120000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  sessionVerifierResult = collectChild(sessionVerifier);
  await Promise.race([
    waitForMarker("ready"),
    sessionVerifierResult.then((result) => {
      assertSessionVerifierPassed(result);
      throw new Error("Authoritative restart verifier exited before requesting the restart");
    }),
  ]);
  await waitForRestartPolicy("app");
  const restartCountBefore = restartCount("app");
  sigkillContainerProcess("app");
  const restartCountAfter = await waitForRestart("app", restartCountBefore);
  await waitUntilReady();
  if (restartCountAfter <= restartCountBefore) {
    throw new Error("The application container did not automatically restart after SIGKILL");
  }
  writeRestartMarker("continue");
  assertSessionVerifierPassed(await sessionVerifierResult);

  run(["run", "--rm", "migrate"]);
} catch (error) {
  validationFailed = true;
  validationFailure = error;
}

if (sessionVerifier?.exitCode === null && sessionVerifier.signalCode === null) {
  sessionVerifier.kill("SIGTERM");
  await Promise.race([sessionVerifierResult, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  if (sessionVerifier.exitCode === null && sessionVerifier.signalCode === null) {
    sessionVerifier.kill("SIGKILL");
  }
}

const cleanup = run(["down", "--volumes", "--remove-orphans"], {
  allowFailure: true,
  capture: true,
});
const imageCleanup = spawnSync("docker", ["image", "rm", image], {
  cwd,
  encoding: "utf8",
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
rmSync(restartGateDirectory, { force: true, recursive: true });
if (validationFailed) {
  rmSync(overridePath, { force: true });
  throw validationFailure;
}
if (cleanup.status !== 0) {
  throw new Error(`Compose cleanup failed: ${cleanup.stderr || cleanup.stdout}`);
}
if (imageCleanup.status !== 0) {
  throw new Error(`Smoke-image cleanup failed: ${imageCleanup.stderr || imageCleanup.stdout}`);
}
const resources = run(["ps", "--all", "--quiet"], { capture: true });
if (resources.stdout.trim() !== "") {
  throw new Error(`Compose resources remain after cleanup: ${resources.stdout.trim()}`);
}
rmSync(overridePath, { force: true });
const imageStillExists = spawnSync("docker", ["image", "inspect", image], {
  cwd,
  env,
  stdio: "ignore",
});
if (imageStillExists.status === 0) {
  throw new Error(`Smoke image ${image} remains after cleanup`);
}

console.log(`Production Compose verification: PASS (http://127.0.0.1:${port})`);

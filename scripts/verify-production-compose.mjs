/* global URL, fetch, AbortSignal */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const project = `mafia-dashboard-smoke-${process.pid}`;
const image = `mafia-dashboard:smoke-${process.pid}`;

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
const gameName = `Compose smoke ${process.pid}`;
const sessionToken = randomUUID();
const sessionHash = createHash("sha256").update(sessionToken).digest("hex");
const clubId = "00000000-0000-4000-8000-000000000101";
const env = {
  ...process.env,
  APP_BIND: "127.0.0.1",
  APP_IMAGE: image,
  APP_PORT: String(port),
  DATABASE_URL: "postgresql://mafia:mafia-smoke-only@db:5432/mafia",
  GOOGLE_CLIENT_ID: "compose-smoke.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "compose-smoke-secret",
  GOOGLE_OAUTH_REDIRECT_URI: "",
  MUSIC_TOKEN_ENCRYPTION_KEY: "",
  POSTGRES_DB: "mafia",
  POSTGRES_PASSWORD: "mafia-smoke-only",
  POSTGRES_USER: "mafia",
  PUBLIC_APP_URL: `http://127.0.0.1:${port}`,
  VITE_YOUTUBE_PLAYLIST_ID: "",
};
const prefix = ["compose", "--project-name", project];

const requireCondition = (condition, message) => {
  if (!condition) throw new Error(message);
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

let validationFailed = false;
let validationFailure;
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

  run(["up", "--detach", "--no-build", "--pull", "never", "--wait"]);
  assertExitedZero("migrate");
  await waitUntilReady();

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

  const requestHeaders = {
    "content-type": "application/json",
    cookie: `mafia_session=${sessionToken}`,
    origin: `http://127.0.0.1:${port}`,
    "x-club-id": clubId,
  };
  const createGame = await fetch(`http://127.0.0.1:${port}/api/games`, {
    body: JSON.stringify({ name: gameName }),
    headers: requestHeaders,
    method: "POST",
  });
  if (createGame.status !== 201) {
    throw new Error(`Application rejected the smoke game with HTTP ${createGame.status}`);
  }
  const { gameId } = await createGame.json();

  run(["stop", "--timeout", "10", "app"]);
  assertExitedZero("app");
  run(["start", "app"]);
  await waitUntilReady();

  const readEvents = await fetch(
    `http://127.0.0.1:${port}/api/games/${gameId}/events?visibility=host`,
    { headers: requestHeaders },
  );
  if (!readEvents.ok) {
    throw new Error(
      `Application could not read the smoke game after restart: ${readEvents.status}`,
    );
  }
  const { events } = await readEvents.json();
  if (
    events.length !== 1 ||
    events[0].type !== "game.created" ||
    events[0].payload.name !== gameName
  ) {
    throw new Error("The accepted game event did not survive the application-container restart");
  }

  run(["run", "--rm", "migrate"]);
} catch (error) {
  validationFailed = true;
  validationFailure = error;
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
if (validationFailed) throw validationFailure;
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
const imageStillExists = spawnSync("docker", ["image", "inspect", image], {
  cwd,
  env,
  stdio: "ignore",
});
if (imageStillExists.status === 0) {
  throw new Error(`Smoke image ${image} remains after cleanup`);
}

console.log(`Production Compose verification: PASS (http://127.0.0.1:${port})`);

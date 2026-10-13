import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import { join } from "node:path";
import { createServer } from "node:net";
import { startAzurite } from "./local-azurite.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const apiOrigin = "http://127.0.0.1:3000";
const viteOrigin = "http://127.0.0.1:5173";
const tailscaleHost = "mbp16.tail102fab.ts.net";
export const canonicalOrigin = `https://${tailscaleHost}`;
export const localOrigin = "http://localhost:5173";

export const assertAvailablePort = (port) =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (cause) =>
      reject(
        new Error(
          `Local app port ${port} is already in use or unavailable; stop the other service first.`,
          { cause },
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

const googleKeys = new Set([
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_OAUTH_REDIRECT_URI",
  "MUSIC_TOKEN_ENCRYPTION_KEY",
]);
const storageKeys = [
  "STORAGE_PROVIDER",
  "AZURE_STORAGE_CONNECTION_STRING",
  "AZURE_STORAGE_TABLE_NAME",
  "AZURE_STORAGE_CONTAINER_NAME",
  "AZURE_STORAGE_PARTITION_KEY",
  "AZURE_STORAGE_INITIALIZE",
];
const pinnedKeys = new Set([
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "AZURITE_ACCOUNTS",
  ...storageKeys,
  ...storageKeys.map((key) => `TEST_${key}`),
  "PUBLIC_APP_URL",
  "STATIC_DIR",
  "HOST",
  "PORT",
  "TRUST_PROXY_HOPS",
  "MAFIA_API_PROXY_TARGET",
]);

const commandOutput = (command, args, timeout = 10_000) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const finish = (callback, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(
        reject,
        new Error(`${command} ${args.join(" ")} timed out after ${timeout / 1_000} seconds`),
      );
    }, timeout);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => finish(reject, error));
    child.once("close", (code) => {
      if (code === 0) finish(resolve, stdout);
      else
        finish(
          reject,
          new Error(
            `${command} ${args.join(" ")} failed: ${(stderr || stdout).trim().slice(0, 1_000)}`,
          ),
        );
    });
  });

const trimTrailingDot = (value) => (typeof value === "string" ? value.replace(/\.$/, "") : "");

/** Validates existing Tailscale state without changing Serve or tailnet settings. */
export const verifyTailscalePreflight = ({ status, serve }) => {
  if (status?.BackendState !== "Running") {
    throw new Error("Tailscale is not running. Start Tailscale, then run npm run dev again.");
  }
  if (status?.Self?.Online !== true) {
    throw new Error(
      "Tailscale node is not online. Reconnect this Mac to the tailnet, then run npm run dev again.",
    );
  }
  if (trimTrailingDot(status?.Self?.DNSName).toLowerCase() !== tailscaleHost) {
    throw new Error(
      `This launcher is approved only for ${tailscaleHost}; use npm run dev -- --local on another machine.`,
    );
  }
  const rootHandler = serve?.Web?.[`${tailscaleHost}:443`]?.Handlers?.["/"];
  if (serve?.TCP?.["443"]?.HTTPS !== true || rootHandler?.Proxy !== viteOrigin) {
    throw new Error(
      `Tailscale Serve must proxy ${canonicalOrigin} to ${viteOrigin}. Existing Serve was not changed.`,
    );
  }
  return canonicalOrigin;
};

const verifyLiveTailscale = async () => {
  let status;
  let serve;
  try {
    status = JSON.parse(await commandOutput("tailscale", ["status", "--json"]));
    serve = JSON.parse(await commandOutput("tailscale", ["serve", "status", "--json"]));
  } catch (error) {
    throw new Error(
      `Could not read Tailscale status: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
  return verifyTailscalePreflight({ status, serve });
};

export const parseLaunchMode = (argumentsList) => {
  if (argumentsList.length === 0) return { local: false };
  if (argumentsList.length === 1 && argumentsList[0] === "--local") return { local: true };
  throw new Error("Usage: npm run dev [-- --local]");
};

const unquote = (value) => {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/, "");
};

const parseEnvironmentFile = (contents) => {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (match !== null) values[match[1]] = unquote(match[2]);
  }
  return values;
};

const readLocalConfiguration = async () => {
  const path = join(root, ".env.local");
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return {};
    throw new Error(
      `Could not read .env.local: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
  return parseEnvironmentFile(contents);
};

const rejectPinnedOverrides = (values, source) => {
  for (const key of pinnedKeys) {
    if (values[key] !== undefined && values[key] !== "") {
      throw new Error(`${key} is pinned by local development and must be removed from ${source}.`);
    }
  }
};

const validateInheritedOverrides = () =>
  rejectPinnedOverrides(process.env, "the inherited environment");

export const googleEnvironment = (values) =>
  Object.fromEntries(
    Object.entries(values).filter(([key, value]) => googleKeys.has(key) && value !== ""),
  );

const childEnvironment = (overrides) => {
  const environment = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "TERM",
    "CI",
    "TZ",
    "NO_COLOR",
    "FORCE_COLOR",
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return { ...environment, ...overrides };
};

const createProcess = (command, args, options) => {
  const child = spawn(command, args, {
    ...options,
    detached: process.platform !== "win32",
    stdio: "inherit",
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, exited };
};

const stopProcess = async (processHandle) => {
  const { child, exited } = processHandle;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid !== undefined)
      process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ESRCH")) throw error;
  }
  if (
    await Promise.race([
      exited.then(
        () => true,
        () => true,
      ),
      delay(10_000).then(() => false),
    ])
  ) {
    return;
  }
  try {
    if (process.platform !== "win32" && child.pid !== undefined)
      process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ESRCH")) throw error;
  }
  await exited.catch(() => undefined);
};

const fetchJson = async (url) => {
  const response = await globalThis.fetch(url, { signal: globalThis.AbortSignal.timeout(2_000) });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await response.json() : undefined;
  return { response, body };
};

const waitFor = async ({ label, url, validate, children }) => {
  const deadline = Date.now() + 30_000;
  let lastError = "no response";
  while (Date.now() < deadline) {
    for (const child of children) {
      if (child.child.exitCode !== null || child.child.signalCode !== null) {
        throw new Error(`${label} did not become ready because a child process exited.`);
      }
    }
    try {
      const result = await fetchJson(url);
      if (validate(result)) return result.body;
      lastError = `received HTTP ${result.response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`${label} did not become ready within 30 seconds (${lastError}).`);
};

export const apiSettings = ({ storage, origin, google }) =>
  childEnvironment({
    ...Object.fromEntries(storageKeys.map((key) => [key, storage[key]])),
    PUBLIC_APP_URL: origin,
    HOST: "127.0.0.1",
    PORT: "3000",
    TRUST_PROXY_HOPS: "0",
    ...google,
  });

export const viteSettings = () => childEnvironment({ MAFIA_API_PROXY_TARGET: apiOrigin });

export const main = async () => {
  const mode = parseLaunchMode(process.argv.slice(2));
  const managed = [];
  let azurite;
  let cleanupPromise;
  let signalName;
  let resolveSignal;
  const signal = new Promise((resolve) => {
    resolveSignal = resolve;
  });
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      await Promise.allSettled([...managed].reverse().map(stopProcess));
      const storage = azurite;
      azurite = undefined;
      await storage?.stop();
    })();
    return cleanupPromise;
  };
  const onSignal = (name) => {
    signalName ??= name;
    resolveSignal(signalName);
    void cleanup();
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  const throwIfInterrupted = () => {
    if (signalName !== undefined) throw new Error(`${signalName} received during local startup.`);
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    const origin = mode.local ? localOrigin : await verifyLiveTailscale();
    throwIfInterrupted();
    validateInheritedOverrides();
    const localConfiguration = await readLocalConfiguration();
    throwIfInterrupted();
    rejectPinnedOverrides(localConfiguration, ".env.local");
    const google = googleEnvironment(localConfiguration);
    await Promise.all([assertAvailablePort(3000), assertAvailablePort(5173)]);
    throwIfInterrupted();
    const storage = await startAzurite({ mode: "dev" });
    if (signalName !== undefined) {
      await storage.stop();
      throwIfInterrupted();
    }
    azurite = storage;
    const apiEnvironment = apiSettings({ storage: storage.environment, origin, google });

    // Azure storage initialization is performed by the server on startup; no PostgreSQL migration.
    const api = createProcess("npm", ["run", "dev", "-w", "@mafia/server"], {
      cwd: root,
      env: apiEnvironment,
    });
    managed.push(api);
    await waitFor({
      label: "Local API",
      url: `${apiOrigin}/health/ready`,
      validate: ({ response, body }) => response.status === 200 && body?.status === "ready",
      children: [api],
    });
    throwIfInterrupted();
    const apiSession = await waitFor({
      label: "Local API session endpoint",
      url: `${apiOrigin}/api/auth/session`,
      validate: ({ response, body }) =>
        response.status === 200 && typeof body?.configured === "boolean",
      children: [api],
    });
    throwIfInterrupted();

    const vite = createProcess(
      process.execPath,
      [
        join(root, "node_modules", "vite", "bin", "vite.js"),
        "--host",
        "127.0.0.1",
        "--port",
        "5173",
        "--strictPort",
      ],
      { cwd: join(root, "apps", "web"), env: viteSettings() },
    );
    managed.push(vite);
    await waitFor({
      label: "Loopback Vite",
      url: `${viteOrigin}/`,
      validate: ({ response }) => response.status === 200,
      children: [api, vite],
    });
    throwIfInterrupted();
    await waitFor({
      label: "Loopback proxied API readiness",
      url: `${viteOrigin}/health/ready`,
      validate: ({ response, body }) => response.status === 200 && body?.status === "ready",
      children: [api, vite],
    });
    throwIfInterrupted();
    await waitFor({
      label: "Browser origin frontend",
      url: `${origin}/`,
      validate: ({ response }) => response.status === 200,
      children: [api, vite],
    });
    throwIfInterrupted();
    const publicSession = await waitFor({
      label: "Browser origin session endpoint",
      url: `${origin}/api/auth/session`,
      validate: ({ response, body }) =>
        response.status === 200 && typeof body?.configured === "boolean",
      children: [api, vite],
    });
    throwIfInterrupted();

    if (!apiSession.configured || !publicSession.configured) {
      console.error(
        `Google sign-in is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env.local, authorize ${origin}/api/auth/google/callback in Google, then restart. The app is API-ready but not normal-ready.`,
      );
    } else {
      console.log(`Local development ready: ${origin}`);
    }
    if (!google.GOOGLE_OAUTH_REDIRECT_URI || !google.MUSIC_TOKEN_ENCRYPTION_KEY) {
      console.warn(
        `YouTube Music connection is not configured. Add GOOGLE_OAUTH_REDIRECT_URI=${origin}/api/music/oauth/callback and MUSIC_TOKEN_ENCRYPTION_KEY to .env.local, authorize the music callback in Google, then restart. See README.md; Google sign-in alone does not enable playlist access.`,
      );
    }

    const outcome = await Promise.race([
      signal.then((name) => ({ type: "signal", name })),
      ...managed.map((processHandle) =>
        processHandle.exited.then((result) => ({ type: "exit", result })),
      ),
    ]);
    if (outcome.type === "exit") {
      throw new Error(
        `A development child exited (${outcome.result.code ?? outcome.result.signal ?? "unknown"}).`,
      );
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    await cleanup();
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

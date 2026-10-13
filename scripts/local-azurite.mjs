import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { URL, fileURLToPath } from "node:url";
import { TableServiceClient } from "@azure/data-tables";
import { BlobServiceClient } from "@azure/storage-blob";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = join(projectRoot, ".AI", "local-azurite");
const markerName = ".mafia-local-azurite-owner.json";
const owner = "mafia-dashboard-local-azurite";
const devPorts = { blob: 13500, queue: 13501, table: 13502 };
const azuriteEntry = join(projectRoot, "node_modules", "azurite", "dist", "src", "azurite.js");

const statOrNull = async (path) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

const ensureRealDirectory = async (path) => {
  const stat = await statOrNull(path);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error(`Refusing non-directory or symlink in owned fixture path: ${path}`);
  }
  if (!stat) {
    await mkdir(path, { mode: 0o700 });
    await chmod(path, 0o700);
  }
  return !stat;
};

const validMarker = (marker, mode) =>
  marker?.owner === owner &&
  marker.version === 1 &&
  marker.mode === mode &&
  typeof marker.accountKey === "string" &&
  /^[A-Za-z0-9+/]{43}=$/.test(marker.accountKey) &&
  typeof marker.id === "string" &&
  /^[a-f0-9-]{36}$/.test(marker.id);

const assertOwned = async (directory, expected) => {
  const stat = await statOrNull(directory);
  const markerPath = join(directory, markerName);
  const markerStat = await statOrNull(markerPath);
  if (
    !stat?.isDirectory() ||
    stat.isSymbolicLink() ||
    !markerStat?.isFile() ||
    markerStat.isSymbolicLink()
  ) {
    throw new Error(`Refusing Azurite directory without its ownership marker: ${directory}`);
  }
  let marker;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    throw new Error(`Refusing invalid Azurite ownership marker: ${directory}`);
  }
  if (
    !validMarker(marker, expected) ||
    (expected === "dev" && marker.ports?.blob !== devPorts.blob)
  ) {
    throw new Error(`Refusing Azurite directory owned by another configuration: ${directory}`);
  }
  return marker;
};

const newMarker = (mode) => ({
  owner,
  version: 1,
  mode,
  id: randomUUID(),
  accountKey: randomBytes(32).toString("base64"),
  ...(mode === "dev" ? { ports: devPorts } : {}),
});

const saveMarker = async (directory, marker) => {
  const path = join(directory, markerName);
  await writeFile(path, `${JSON.stringify(marker)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
};

const freePort = () =>
  new Promise((resolvePort, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });

const testPorts = async () => {
  const ports = new Set();
  while (ports.size < 3) ports.add(await freePort());
  const [blob, queue, table] = ports;
  return { blob, queue, table };
};

const connectionFor = (account, key, ports) =>
  `DefaultEndpointsProtocol=http;AccountName=${account};AccountKey=${key};BlobEndpoint=http://127.0.0.1:${ports.blob}/${account};QueueEndpoint=http://127.0.0.1:${ports.queue}/${account};TableEndpoint=http://127.0.0.1:${ports.table}/${account}`;

/** Starts only a private, loopback Azurite instance in this repository's fixture root. */
export const startAzurite = async ({ mode = "test", rootDirectory = fixtureRoot } = {}) => {
  if (mode !== "test" && mode !== "dev")
    throw new Error("Unknown local Azurite mode (test or dev required).");
  if (typeof rootDirectory !== "string" || resolve(rootDirectory) !== fixtureRoot) {
    throw new Error(`Expected the owned fixture root ${fixtureRoot}; arbitrary paths are refused.`);
  }
  await ensureRealDirectory(join(projectRoot, ".AI"));
  await ensureRealDirectory(fixtureRoot);
  const account = mode === "dev" ? "mafiadev" : "mafiatest";
  let directory;
  let marker;
  let releaseLock;
  let child;
  let exited;
  let stopPromise;
  let createdTest = false;
  try {
    if (mode === "dev") {
      const lock = join(fixtureRoot, ".dev-start.lock");
      try {
        await mkdir(lock, { mode: 0o700 });
      } catch (error) {
        if (error?.code === "EEXIST")
          throw new Error("Another local Azurite development startup is in progress.", {
            cause: error,
          });
        throw error;
      }
      releaseLock = () => rm(lock, { recursive: true, force: true });
      directory = join(fixtureRoot, "dev");
      if (await statOrNull(directory)) marker = await assertOwned(directory, mode);
      else {
        await ensureRealDirectory(directory);
        marker = newMarker(mode);
        await saveMarker(directory, marker);
      }
    } else {
      const tests = join(fixtureRoot, "tests");
      await ensureRealDirectory(tests);
      directory = await mkdtemp(join(tests, "fixture-"));
      createdTest = true;
      await chmod(directory, 0o700);
      marker = newMarker(mode);
      await saveMarker(directory, marker);
    }
    marker = await assertOwned(directory, mode);
    const ports = mode === "dev" ? devPorts : await testPorts();
    const connection = connectionFor(account, marker.accountKey, ports);
    const id = marker.id.replaceAll("-", "");
    const environment = {
      STORAGE_PROVIDER: "azure",
      AZURE_STORAGE_CONNECTION_STRING: connection,
      AZURE_STORAGE_TABLE_NAME: mode === "dev" ? "MafiaDevRecords" : `MafiaTest${id}`,
      AZURE_STORAGE_CONTAINER_NAME: mode === "dev" ? "mafia-dev-records" : `mafia-test-${id}`,
      AZURE_STORAGE_PARTITION_KEY: mode === "dev" ? "local" : `test-${id}`,
      AZURE_STORAGE_INITIALIZE: "true",
    };
    // Only the owned emulator gets this generated account key; inherited storage targets are never used.
    const childEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      AZURITE_ACCOUNTS: `${account}:${marker.accountKey}`,
    };
    child = spawn(
      process.execPath,
      [
        azuriteEntry,
        "--location",
        directory,
        "--blobHost",
        "127.0.0.1",
        "--blobPort",
        String(ports.blob),
        "--queueHost",
        "127.0.0.1",
        "--queuePort",
        String(ports.queue),
        "--tableHost",
        "127.0.0.1",
        "--tablePort",
        String(ports.table),
        // Emulator-only: current Azure SDK versions can send newer API versions.
        "--skipApiVersionCheck",
        "--silent",
      ],
      { cwd: projectRoot, env: childEnv, stdio: "ignore" },
    );
    exited = new Promise((resolveExit) => {
      child.once("error", (error) => resolveExit({ error }));
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    const stop = () => {
      stopPromise ??= (async () => {
        if (child.exitCode === null && child.signalCode === null && child.pid) {
          child.kill("SIGTERM");
          const closed = await Promise.race([
            exited.then(() => true),
            delay(5_000).then(() => false),
          ]);
          if (!closed) child.kill("SIGKILL");
        }
        await exited;
        if (createdTest) {
          const actual = await assertOwned(directory, "test");
          if (actual.id !== marker.id || actual.accountKey !== marker.accountKey) {
            throw new Error("Refusing to remove a changed Azurite fixture ownership marker.");
          }
          await rm(directory, { recursive: true, force: true });
        }
      })();
      return stopPromise;
    };
    const table = TableServiceClient.fromConnectionString(connection, {
      allowInsecureConnection: true,
      retryOptions: { maxRetries: 0 },
    });
    const blob = BlobServiceClient.fromConnectionString(connection, {
      retryOptions: { maxRetries: 0 },
    });
    const deadline = Date.now() + 30_000;
    let lastError = "not yet ready";
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
        throw new Error("Owned Azurite exited before Table and Blob became ready.");
      }
      try {
        await Promise.all([
          table.listTables({ abortSignal: globalThis.AbortSignal.timeout(2_000) }).next(),
          blob.listContainers({ abortSignal: globalThis.AbortSignal.timeout(2_000) }).next(),
        ]);
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error("Azurite exited during readiness check");
        return { environment, stop };
      } catch (error) {
        // Do not expose connection strings or account keys from SDK errors.
        lastError =
          typeof error?.statusCode === "number"
            ? `HTTP ${error.statusCode}`
            : (error?.code ?? error?.name ?? "connection unavailable");
      }
      await delay(150);
    }
    throw new Error(`Owned Azurite Table and Blob did not become ready (${lastError}).`);
  } catch (error) {
    if (child && exited) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([exited, delay(5_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
    if (createdTest && directory) {
      const actual = await assertOwned(directory, "test");
      if (actual.id === marker.id && actual.accountKey === marker.accountKey) {
        await rm(directory, { recursive: true, force: true });
      }
    }
    throw error;
  } finally {
    await releaseLock?.();
  }
};

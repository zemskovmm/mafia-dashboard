import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const postgresRoot = join(root, "postgres-data");
const ownerFile = ".mafia-local-postgres-owner.json";
const owner = "mafia-dashboard-local-postgres";
const postgresUser = "mafia";
const persistentPort = 54328;
const persistentStartLock = join(postgresRoot, ".mafia-local-postgres-start.lock");

const acquirePersistentStartLock = async () => {
  try {
    await mkdir(persistentStartLock, { mode: 0o700 });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new Error(
        "Another local PostgreSQL startup is in progress; wait for it to finish before retrying.",
        {
          cause: error,
        },
      );
    }
    throw error;
  }
  return () => rm(persistentStartLock, { recursive: true, force: true });
};

const localEnvironment = () => {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key === "DATABASE_URL" || key === "PGSERVICE" || key.startsWith("PG"))
      delete environment[key];
  }
  environment.LC_ALL = "C";
  environment.LANG = "C";
  return environment;
};

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: localEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });

const runChecked = async (command, args, description) => {
  let result;
  try {
    result = await run(command, args);
  } catch (error) {
    throw new Error(`${description}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (result.code === 0) return result.stdout.trim();
  const detail = (result.stderr || result.stdout).trim().slice(0, 1_000);
  throw new Error(`${description}${detail === "" ? "" : `: ${detail}`}`);
};

const lstatOrNull = async (path) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
};

const assertDirectory = async (path, description) => {
  const stat = await lstatOrNull(path);
  if (stat === null) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(
      `${description} must be a real directory, not a symlink or foreign file: ${path}`,
    );
  }
  return true;
};

const ensureDirectory = async (path, description) => {
  if (!(await assertDirectory(path, description))) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
};

const markerFor = ({ kind, database, port }) => ({
  owner,
  version: 1,
  kind,
  database,
  port,
  user: postgresUser,
});

const writeMarker = async (dataDirectory, marker) => {
  const path = join(dataDirectory, ownerFile);
  await writeFile(path, `${JSON.stringify(marker)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
};

const assertOwned = async (dataDirectory, expected) => {
  if (!(await assertDirectory(dataDirectory, "PostgreSQL data directory"))) {
    throw new Error(`PostgreSQL data directory is missing: ${dataDirectory}`);
  }
  const markerPath = join(dataDirectory, ownerFile);
  const markerStat = await lstatOrNull(markerPath);
  if (markerStat === null || markerStat.isSymbolicLink() || !markerStat.isFile()) {
    throw new Error(
      `Refusing PostgreSQL data directory without this launcher's ownership marker: ${dataDirectory}`,
    );
  }
  let marker;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    throw new Error(
      `Refusing PostgreSQL data directory with an invalid ownership marker: ${dataDirectory}`,
    );
  }
  if (
    marker?.owner !== owner ||
    marker.version !== 1 ||
    marker.kind !== expected.kind ||
    marker.database !== expected.database ||
    marker.port !== expected.port ||
    marker.user !== postgresUser
  ) {
    throw new Error(
      `Refusing PostgreSQL data directory owned by another configuration: ${dataDirectory}`,
    );
  }
};

const initDatabase = async (dataDirectory, marker) => {
  await runChecked(
    "initdb",
    [
      "--auth-host=trust",
      "--auth-local=trust",
      "--encoding=UTF8",
      "--locale=C",
      `--username=${postgresUser}`,
      "--pgdata",
      dataDirectory,
    ],
    "Native PostgreSQL initialization failed",
  );
  await chmod(dataDirectory, 0o700);
  await writeMarker(dataDirectory, marker);
};

const createPersistentDataDirectory = async (dataDirectory, marker) => {
  const stagingDirectory = join(postgresRoot, `.local-initializing-${randomUUID()}`);
  try {
    await initDatabase(stagingDirectory, marker);
    await rename(stagingDirectory, dataDirectory);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
};

const findFreeLoopbackPort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not select a loopback port for disposable PostgreSQL"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

const databaseUrl = (port, database) =>
  `postgresql://${postgresUser}@127.0.0.1:${port}/${database}`;

const isRunning = async (dataDirectory) =>
  (await run("pg_ctl", ["-D", dataDirectory, "status"])).code === 0;

const stopServer = async (dataDirectory) =>
  runChecked(
    "pg_ctl",
    ["-D", dataDirectory, "-w", "-t", "30", "stop", "-m", "fast"],
    "Native PostgreSQL shutdown failed",
  );

const ensureDatabase = async ({ port, database }) => {
  const common = ["--host=127.0.0.1", `--port=${port}`, `--username=${postgresUser}`];
  const exists = await runChecked(
    "psql",
    [
      "-XAtq",
      ...common,
      "--dbname=postgres",
      "-c",
      `SELECT 1 FROM pg_database WHERE datname = '${database}'`,
    ],
    "Could not inspect local PostgreSQL databases",
  );
  if (exists !== "1") {
    await runChecked(
      "createdb",
      [...common, database],
      `Could not create local ${database} database`,
    );
  }
  await runChecked(
    "psql",
    ["-XAtq", ...common, `--dbname=${database}`, "-c", "SELECT 1"],
    "Local PostgreSQL did not become query-ready",
  );
};

const verifyRunningCluster = async ({ dataDirectory, port }) => {
  const actual = await runChecked(
    "psql",
    [
      "-XAtq",
      "--host=127.0.0.1",
      `--port=${port}`,
      `--username=${postgresUser}`,
      "--dbname=postgres",
      "-F",
      "\t",
      "-c",
      "SELECT current_setting('data_directory'), current_setting('port')",
    ],
    "Could not verify the running local PostgreSQL cluster",
  );
  const [actualDirectory, actualPort] = actual.split("\t");
  if (actualDirectory !== (await realpath(dataDirectory)) || actualPort !== String(port)) {
    throw new Error(
      `Refusing a PostgreSQL server that does not match owned data at ${dataDirectory}`,
    );
  }
};

const startServer = async ({ dataDirectory, port, disposable }) => {
  const attempts = disposable ? 10 : 1;
  const logPath = join(dataDirectory, ".mafia-local-postgres.log");
  let lastError;
  let lastPort = port;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const chosenPort = disposable ? await findFreeLoopbackPort() : port;
    lastPort = chosenPort;
    await writeFile(logPath, "", { mode: 0o600 });
    const result = await run("pg_ctl", [
      "-D",
      dataDirectory,
      "-l",
      logPath,
      "-o",
      `-h 127.0.0.1 -p ${chosenPort} -k ''`,
      "-w",
      "-t",
      "30",
      "start",
    ]);
    if (result.code === 0) return chosenPort;
    const log = await readFile(logPath, "utf8").catch(() => "");
    lastError = (log || result.stderr || result.stdout).trim().slice(-1_000);
    if (!disposable || !/address already in use|could not bind/i.test(lastError)) break;
  }
  throw new Error(
    `Native PostgreSQL failed to start on 127.0.0.1:${lastPort}${lastError ? `: ${lastError}` : ""}`,
  );
};

/**
 * Starts an owned native PostgreSQL cluster for local development or tests.
 * Persistent data stays in postgres-data/local; disposable test data is removed only after a clean stop.
 */
export const startPostgres = async ({ disposable = false } = {}) => {
  await ensureDirectory(postgresRoot, "PostgreSQL root");
  const releasePersistentStartLock = disposable ? undefined : await acquirePersistentStartLock();
  try {
    const database = disposable ? "mafia_test" : "mafia_local";
    let dataDirectory;
    let port = persistentPort;
    let createdDisposable = false;

    if (disposable) {
      const testsDirectory = join(postgresRoot, "tests");
      await ensureDirectory(testsDirectory, "PostgreSQL test root");
      dataDirectory = await mkdtemp(join(testsDirectory, "cluster-"));
      createdDisposable = true;
      try {
        await initDatabase(dataDirectory, markerFor({ kind: "disposable", database, port: null }));
      } catch (error) {
        await rm(dataDirectory, { recursive: true, force: true });
        throw error;
      }
    } else {
      dataDirectory = join(postgresRoot, "local");
      const marker = markerFor({ kind: "persistent", database, port });
      if (await assertDirectory(dataDirectory, "PostgreSQL data directory")) {
        await assertOwned(dataDirectory, marker);
      } else {
        await createPersistentDataDirectory(dataDirectory, marker);
      }
    }

    const marker = markerFor({
      kind: disposable ? "disposable" : "persistent",
      database,
      port: disposable ? null : port,
    });
    await assertOwned(dataDirectory, marker);
    const alreadyRunning = await isRunning(dataDirectory);
    let startedHere = false;
    let startupAttempted = false;
    let stopped = false;

    try {
      if (alreadyRunning) {
        if (disposable)
          throw new Error(
            `Disposable PostgreSQL cluster was unexpectedly already running: ${dataDirectory}`,
          );
        await verifyRunningCluster({ dataDirectory, port });
      } else {
        startupAttempted = true;
        port = await startServer({ dataDirectory, port, disposable });
        startedHere = true;
        await verifyRunningCluster({ dataDirectory, port });
      }
      await ensureDatabase({ port, database });
    } catch (error) {
      let stoppedCleanly = true;
      if (createdDisposable || startedHere || startupAttempted) {
        const running = await isRunning(dataDirectory).catch(() => undefined);
        if (running === true && !startedHere && !startupAttempted) {
          stoppedCleanly = false;
        } else if (running === true) {
          try {
            await stopServer(dataDirectory);
          } catch {
            stoppedCleanly = false;
          }
        } else if (running === undefined) {
          stoppedCleanly = false;
        }
      }
      if (createdDisposable && stoppedCleanly)
        await rm(dataDirectory, { recursive: true, force: true });
      throw error;
    }

    return {
      url: databaseUrl(port, database),
      stop: async () => {
        if (stopped) return;
        if (startedHere) await stopServer(dataDirectory);
        stopped = true;
        if (createdDisposable) await rm(dataDirectory, { recursive: true, force: true });
      },
    };
  } finally {
    await releasePersistentStartLock?.();
  }
};

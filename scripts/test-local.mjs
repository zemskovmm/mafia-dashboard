import { URL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout, clearTimeout } from "node:timers";

export function testCommand(args) {
  if (args.length === 0) return ["npm", "run", "test"];
  if (args.length === 1 && args[0] === "--check") return ["npm", "run", "check"];
  if (args[0] === "--" && args.length > 1) return args.slice(1);
  throw new Error("Usage: npm run test:local [-- -- command args...] or npm run check:local");
}

export function runnerMode(args) {
  if (args[0] === "--postgres") return { mode: "postgres", args: args.slice(1) };
  return { mode: "azure", args };
}

const safeAzureTestEnvironment = (fixture) => {
  const connection = fixture?.AZURE_STORAGE_CONNECTION_STRING;
  const segments =
    typeof connection === "string"
      ? Object.fromEntries(
          connection.split(";").map((part) => {
            const separator = part.indexOf("=");
            return [part.slice(0, separator), part.slice(separator + 1)];
          }),
        )
      : {};
  const id = fixture?.AZURE_STORAGE_TABLE_NAME?.match(/^MafiaTest([a-f0-9]{32})$/)?.[1];
  if (
    !id ||
    segments.DefaultEndpointsProtocol !== "http" ||
    segments.AccountName !== "mafiatest" ||
    !/^[A-Za-z0-9+/]{43}=$/.test(segments.AccountKey ?? "") ||
    fixture.AZURE_STORAGE_CONTAINER_NAME !== `mafia-test-${id}` ||
    fixture.AZURE_STORAGE_PARTITION_KEY !== `test-${id}` ||
    fixture.AZURE_STORAGE_INITIALIZE !== "true" ||
    fixture.STORAGE_PROVIDER !== "azure" ||
    !["Blob", "Queue", "Table"].every((service) => {
      try {
        const endpoint = new URL(segments[`${service}Endpoint`]);
        return (
          endpoint.protocol === "http:" &&
          endpoint.hostname === "127.0.0.1" &&
          endpoint.port !== "" &&
          endpoint.pathname === "/mafiatest" &&
          endpoint.search === "" &&
          endpoint.hash === ""
        );
      } catch {
        return false;
      }
    })
  )
    throw new Error("Expected an owned loopback Azurite test fixture");
  return Object.fromEntries(
    [
      "AZURE_STORAGE_CONNECTION_STRING",
      "AZURE_STORAGE_TABLE_NAME",
      "AZURE_STORAGE_CONTAINER_NAME",
      "AZURE_STORAGE_PARTITION_KEY",
    ].map((key) => [`TEST_${key}`, fixture[key]]),
  );
};
export function testEnvironment(url, source = process.env, referenceUrl) {
  const azure = typeof url === "object" ? safeAzureTestEnvironment(url) : undefined;
  if (azure) {
    const environment = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "TERM", "CI", "TZ"]) {
      if (source[key] !== undefined) environment[key] = source[key];
    }
    const reference =
      referenceUrl === undefined
        ? {}
        : {
            TEST_DATABASE_URL: testEnvironment(referenceUrl, {}).TEST_DATABASE_URL,
          };
    return { ...environment, LC_ALL: "C", ...azure, ...reference };
  }
  const target = new URL(url);
  if (
    target.protocol !== "postgresql:" ||
    target.hostname !== "127.0.0.1" ||
    target.pathname !== "/mafia_test" ||
    !target.port ||
    target.search ||
    target.hash
  )
    throw new Error("Expected an owned loopback test database");
  const environment = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "TERM", "CI", "TZ"]) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return { ...environment, LC_ALL: "C", TEST_DATABASE_URL: url };
}

export async function runTests(args = process.argv.slice(2)) {
  const { mode, args: commandOptions } = runnerMode(args);
  const [command, ...commandArgs] = testCommand(commandOptions);
  let fixture;
  let referenceFixture;
  let child;
  let interrupted = 0;
  let killTimer;
  const killGroup = (signal) => {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const interrupt = (signal) => {
    interrupted = signal === "SIGINT" ? 130 : 143;
    killGroup("SIGTERM");
    if (!killTimer && child?.pid) {
      killTimer = setTimeout(() => killGroup("SIGKILL"), 5000);
      killTimer.unref();
    }
  };
  const onInt = () => interrupt("SIGINT");
  const onTerm = () => interrupt("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    if (mode === "postgres") {
      const { startPostgres } = await import("./local-postgres.mjs");
      fixture = await startPostgres({ disposable: true });
    } else {
      const { startAzurite } = await import("./local-azurite.mjs");
      fixture = await startAzurite({ mode: "test" });
      // Existing SQL suites are retained as reference coverage during transition.
      // Normal Azure development stays SQL-free, but checks must execute them.
      const { startPostgres } = await import("./local-postgres.mjs");
      referenceFixture = await startPostgres({ disposable: true });
    }
    if (interrupted) return interrupted;
    // Explicit argv, no shell; only the requested child receives the owned fixture.
    child = spawn(command, commandArgs, {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: testEnvironment(
        mode === "postgres" ? fixture.url : fixture.environment,
        process.env,
        referenceFixture?.url,
      ),
      stdio: "inherit",
      detached: true,
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (status) => resolve(status ?? 1));
    });
    return interrupted || code;
  } finally {
    clearTimeout(killTimer);
    killGroup("SIGKILL");
    try {
      try {
        await fixture?.stop();
      } finally {
        await referenceFixture?.stop();
      }
    } finally {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runTests();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

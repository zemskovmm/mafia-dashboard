import { URL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout, clearTimeout } from "node:timers";

export function testCommand(args) {
  if (args.length === 0) return ["npm", "run", "test"];
  if (args.length === 1 && args[0] === "--check") return ["npm", "run", "check"];
  if (args[0] === "--" && args.length > 1) return args.slice(1);
  throw new Error("Usage: npm run test:local [-- -- command args...] or npm run check:local");
}

export const ownedAzuriteEnvironment = (fixture) => {
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
          endpoint.username === "" &&
          endpoint.password === "" &&
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
      "STORAGE_PROVIDER",
      "AZURE_STORAGE_CONNECTION_STRING",
      "AZURE_STORAGE_TABLE_NAME",
      "AZURE_STORAGE_CONTAINER_NAME",
      "AZURE_STORAGE_PARTITION_KEY",
      "AZURE_STORAGE_INITIALIZE",
    ].map((key) => [key, fixture[key]]),
  );
};
export function testEnvironment(fixture, source = process.env) {
  const azure = ownedAzuriteEnvironment(fixture);
  const environment = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "TERM", "CI", "TZ"]) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return {
    ...environment,
    LC_ALL: "C",
    ...Object.fromEntries(
      [
        "AZURE_STORAGE_CONNECTION_STRING",
        "AZURE_STORAGE_TABLE_NAME",
        "AZURE_STORAGE_CONTAINER_NAME",
        "AZURE_STORAGE_PARTITION_KEY",
      ].map((key) => [`TEST_${key}`, azure[key]]),
    ),
  };
}

export async function runTests(args = process.argv.slice(2)) {
  const [command, ...commandArgs] = testCommand(args);
  let fixture;
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
    const { startAzurite } = await import("./local-azurite.mjs");
    fixture = await startAzurite({ mode: "test" });
    if (interrupted) return interrupted;
    // Explicit argv, no shell; only the requested child receives the owned fixture.
    child = spawn(command, commandArgs, {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: testEnvironment(fixture.environment),
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
      await fixture?.stop();
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

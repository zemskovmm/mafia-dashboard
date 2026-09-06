import { URL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout, clearTimeout } from "node:timers";

export function testCommand(args) {
  if (args.length === 0) return ["npm", "run", "test"];
  if (args.length === 1 && args[0] === "--check") return ["npm", "run", "check"];
  if (args[0] === "--" && args.length > 1) return args.slice(1);
  throw new Error("Usage: npm run test:local [-- -- command args...] or npm run check:local");
}

export function testEnvironment(url, source = process.env) {
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
  const [command, ...commandArgs] = testCommand(args);
  const { startPostgres } = await import("./local-postgres.mjs");
  let database;
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
    database = await startPostgres({ disposable: true });
    if (interrupted) return interrupted;
    // Explicit argv, no shell; only the requested test command inherits the disposable URL.
    child = spawn(command, commandArgs, {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: testEnvironment(database.url),
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
      await database?.stop();
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

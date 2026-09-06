import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { testCommand, testEnvironment } from "./test-local.mjs";

test("local test command wraps existing checks without recursion", () => {
  assert.deepEqual(testCommand([]), ["npm", "run", "test"]);
  assert.deepEqual(testCommand(["--check"]), ["npm", "run", "check"]);
  assert.deepEqual(testCommand(["--", "npm", "run", "test", "-w", "@mafia/server"]), [
    "npm",
    "run",
    "test",
    "-w",
    "@mafia/server",
  ]);
  assert.throws(() => testCommand(["--remote"]), /Usage/);
  assert.throws(() => testCommand(["--"]), /Usage/);
});

test("test children receive owned database only, never development credentials or routes", () => {
  const url = "postgresql://mafia@127.0.0.1:55444/mafia_test";
  const environment = testEnvironment(url, {
    PATH: "/bin",
    HOME: "/home/test",
    TEST_DATABASE_URL: "postgresql://remote/test",
    DATABASE_URL: "postgresql://remote/live",
    GOOGLE_CLIENT_SECRET: "private",
    GOOGLE_CLIENT_ID: "private-id",
    PUBLIC_APP_URL: "https://production.example",
    PGHOST: "production.example",
    PGOPTIONS: "unsafe",
    MAFIA_API_PROXY_TARGET: "https://production.example",
    STATIC_DIR: "/production",
    SESSION_AUTH_COOKIE: "private-cookie",
    NODE_OPTIONS: "--import=unsafe.mjs",
  });
  assert.equal(environment.TEST_DATABASE_URL, url);
  assert.equal(environment.PATH, "/bin");
  for (const key of [
    "DATABASE_URL",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "PUBLIC_APP_URL",
    "PGHOST",
    "PGOPTIONS",
    "MAFIA_API_PROXY_TARGET",
    "STATIC_DIR",
    "SESSION_AUTH_COOKIE",
    "NODE_OPTIONS",
  ]) {
    assert.equal(environment[key], undefined, key);
  }
  assert.throws(
    () => testEnvironment("postgresql://remote/mafia_test", {}),
    /owned loopback test database/,
  );
  assert.throws(
    () => testEnvironment("postgresql://mafia@127.0.0.1:54328/mafia_local", {}),
    /owned loopback test database/,
  );
});

test(
  "disposable wrapper exercises PostgreSQL, preserves failure, and cleans up",
  {
    skip:
      spawnSync("pg_ctl", ["--version"]).status !== 0
        ? "Native PostgreSQL is not installed"
        : false,
    timeout: 60_000,
  },
  async () => {
    const run = promisify(execFile);
    let database;
    await assert.rejects(
      run(
        process.execPath,
        [
          "scripts/test-local.mjs",
          "--",
          process.execPath,
          "--input-type=module",
          "-e",
          "import pg from 'pg'; const p = new pg.Pool({connectionString:process.env.TEST_DATABASE_URL}); const r=await p.query(\"SELECT current_database() AS name, current_setting('data_directory') AS directory, current_setting('port') AS port\"); console.log(JSON.stringify(r.rows[0])); await p.end(); process.exit(37);",
        ],
        { timeout: 55_000 },
      ),
      (error) => {
        assert.equal(error.code, 37, error.stderr);
        database = JSON.parse(error.stdout.trim());
        assert.equal(database.name, "mafia_test");
        return true;
      },
    );
    await assert.rejects(stat(database.directory), { code: "ENOENT" });
    await new Promise((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: Number(database.port) });
      socket.once("connect", () => {
        socket.destroy();
        reject(new Error("Test database still running"));
      });
      socket.once("error", (error) => (error.code === "ECONNREFUSED" ? resolve() : reject(error)));
    });
  },
);

test(
  "interrupting a running test stops its disposable database",
  {
    skip:
      spawnSync("pg_ctl", ["--version"]).status !== 0
        ? "Native PostgreSQL is not installed"
        : false,
    timeout: 60_000,
  },
  async () => {
    const child = spawn(
      process.execPath,
      [
        "scripts/test-local.mjs",
        "--",
        process.execPath,
        "--input-type=module",
        "-e",
        "import pg from 'pg'; const p=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL}); const r=await p.query(\"SELECT current_setting('data_directory') AS directory\"); console.log(JSON.stringify(r.rows[0])); setInterval(()=>{},1000);",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = once(child, "close");
    let output = "";
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    let interrupted = false;
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("\n") && !interrupted) {
        interrupted = true;
        child.kill("SIGTERM");
      }
    });
    const [code] = await closed;
    assert.equal(code, 143, errors);
    const database = JSON.parse(output.trim());
    await assert.rejects(stat(database.directory), { code: "ENOENT" });
  },
);

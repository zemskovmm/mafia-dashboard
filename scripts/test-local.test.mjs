import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { URL } from "node:url";
import { testCommand, testEnvironment } from "./test-local.mjs";
import { startAzurite } from "./local-azurite.mjs";

const assertOwnedPortsClosed = async (ports) => {
  for (const port of ports) {
    await new Promise((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        reject(new Error("Owned Azurite is still running"));
      });
      socket.once("error", (error) => (error.code === "ECONNREFUSED" ? resolve() : reject(error)));
    });
  }
};

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

test("PostgreSQL is unsupported before any fixture or command starts", async () => {
  assert.throws(() => testCommand(["--postgres", "--check"]), /Usage/);
  const result = spawnSync(process.execPath, ["scripts/test-local.mjs", "--postgres", "--check"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Usage/);
  const source = await readFile(new URL("./test-local.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /local-postgres|startPostgres|referenceFixture/);
});

test("Azure test child gets only generated loopback fixture configuration", async () => {
  const fixture = await startAzurite();
  try {
    const environment = testEnvironment(fixture.environment, {
      PATH: "/bin",
      DATABASE_URL: "postgresql://remote/prod",
      TEST_DATABASE_URL: "postgresql://remote/test",
      AZURE_STORAGE_CONNECTION_STRING: "DefaultEndpointsProtocol=https;AccountName=production",
      TEST_AZURE_STORAGE_CONNECTION_STRING: "https://remote",
      AZURITE_ACCOUNTS: "production:key",
      GOOGLE_CLIENT_SECRET: "private",
      NODE_OPTIONS: "--import=unsafe.mjs",
    });
    assert.equal(environment.PATH, "/bin");
    assert.equal(
      environment.TEST_AZURE_STORAGE_CONNECTION_STRING,
      fixture.environment.AZURE_STORAGE_CONNECTION_STRING,
    );
    assert.equal(
      environment.TEST_AZURE_STORAGE_TABLE_NAME,
      fixture.environment.AZURE_STORAGE_TABLE_NAME,
    );
    assert.equal(
      environment.TEST_AZURE_STORAGE_CONTAINER_NAME,
      fixture.environment.AZURE_STORAGE_CONTAINER_NAME,
    );
    assert.equal(
      environment.TEST_AZURE_STORAGE_PARTITION_KEY,
      fixture.environment.AZURE_STORAGE_PARTITION_KEY,
    );
    for (const key of [
      "DATABASE_URL",
      "TEST_DATABASE_URL",
      "AZURE_STORAGE_CONNECTION_STRING",
      "AZURITE_ACCOUNTS",
      "GOOGLE_CLIENT_SECRET",
      "NODE_OPTIONS",
    ]) {
      assert.equal(environment[key], undefined, key);
    }
    assert.throws(
      () =>
        testEnvironment(
          { ...fixture.environment, AZURE_STORAGE_CONNECTION_STRING: "https://remote" },
          {},
        ),
      /loopback Azurite/,
    );
    assert.throws(
      () => testEnvironment({ ...fixture.environment, AZURE_STORAGE_TABLE_NAME: "wrong" }, {}),
      /loopback Azurite/,
    );
    for (const candidate of [
      "postgresql://remote/prod",
      "postgresql://mafia@127.0.0.1:55444/mafia_test",
      null,
    ]) {
      assert.throws(() => testEnvironment(candidate, {}), /owned loopback Azurite/);
    }
  } finally {
    await fixture.stop();
  }
});

test(
  "default test wrapper reaches Azurite and retains child failure status",
  { timeout: 60_000 },
  async () => {
    const run = promisify(execFile);
    let ports;
    await assert.rejects(
      run(
        process.execPath,
        [
          "scripts/test-local.mjs",
          "--",
          process.execPath,
          "--input-type=module",
          "-e",
          "import {TableServiceClient} from '@azure/data-tables'; const e=process.env; const t=TableServiceClient.fromConnectionString(e.TEST_AZURE_STORAGE_CONNECTION_STRING,{allowInsecureConnection:true}); await t.listTables().next(); if(e.DATABASE_URL || e.TEST_DATABASE_URL || e.AZURE_STORAGE_CONNECTION_STRING) throw Error('leaked target'); console.log(JSON.stringify([...e.TEST_AZURE_STORAGE_CONNECTION_STRING.matchAll(/(?:Blob|Queue|Table)Endpoint=([^;]+)/g)].map(m=>Number(new URL(m[1]).port)))); process.exit(37);",
        ],
        { timeout: 55_000 },
      ),
      (error) => {
        assert.equal(error.code, 37, error.stderr);
        ports = JSON.parse(error.stdout.trim());
        assert.equal(ports.length, 3);
        return true;
      },
    );
    await assertOwnedPortsClosed(ports);
  },
);

for (const [signal, status] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  test(
    `interrupting Azure test wrapper with ${signal} terminates its emulator`,
    { timeout: 60_000 },
    async () => {
      const child = spawn(
        process.execPath,
        [
          "scripts/test-local.mjs",
          "--",
          process.execPath,
          "--input-type=module",
          "-e",
          "const conn=process.env.TEST_AZURE_STORAGE_CONNECTION_STRING; console.log(JSON.stringify([...conn.matchAll(/(?:Blob|Queue|Table)Endpoint=([^;]+)/g)].map(m=>Number(new URL(m[1]).port)))); setInterval(()=>{},1000);",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const closed = once(child, "close");
      let output = "";
      let errors = "";
      let interrupted = false;
      child.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("\n") && !interrupted) {
          interrupted = true;
          child.kill(signal);
        }
      });
      const [code] = await closed;
      assert.equal(code, status, errors);
      const ports = JSON.parse(output.trim());
      assert.equal(ports.length, 3);
      await assertOwnedPortsClosed(ports);
    },
  );
}

test("test children never inherit development credentials or routes", async () => {
  const fixture = await startAzurite();
  try {
    const environment = testEnvironment(fixture.environment, {
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
    assert.equal(environment.TEST_DATABASE_URL, undefined);
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
  } finally {
    await fixture.stop();
  }
});

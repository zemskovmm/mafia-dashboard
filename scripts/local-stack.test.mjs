import assert from "node:assert/strict";
import { createServer } from "node:net";
import { execFileSync, spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { URL } from "node:url";
import test from "node:test";

const nativePostgresAvailable = ["initdb", "pg_ctl", "psql"].every(
  (command) => spawnSync(command, ["--version"]).status === 0,
);

// This test exercises a native PostgreSQL cluster created exclusively for the test.
test(
  "a disposable owned PostgreSQL cluster is loopback-only and removed after stop",
  { skip: nativePostgresAvailable ? false : "Native PostgreSQL tools are unavailable" },
  async () => {
    const { startPostgres } = await import("./local-postgres.mjs");
    const postgres = await startPostgres({ disposable: true });
    let dataDirectory;

    try {
      const parsed = new URL(postgres.url);
      assert.equal(parsed.protocol, "postgresql:");
      assert.equal(parsed.hostname, "127.0.0.1");
      assert.equal(parsed.username, "mafia");
      assert.equal(parsed.pathname, "/mafia_test");
      assert.notEqual(parsed.port, "54328");

      const result = execFileSync(
        "psql",
        [
          "-XAt",
          "--host=127.0.0.1",
          `--port=${parsed.port}`,
          "--username=mafia",
          "--dbname=mafia_test",
          "-F",
          "\t",
          "-c",
          "SELECT current_database(), inet_server_addr()::text, current_setting('data_directory'), current_setting('unix_socket_directories') = ''",
        ],
        { encoding: "utf8", env: { PATH: process.env.PATH, LC_ALL: "C" } },
      ).trim();
      const [database, address, directory, socketsDisabled] = result.split("\t");
      assert.equal(database, "mafia_test");
      assert.match(address, /^127\.0\.0\.1(?:\/32)?$/);
      assert.equal(socketsDisabled, "t");
      dataDirectory = directory;
    } finally {
      await postgres.stop();
    }

    await assert.rejects(stat(dataDirectory), { code: "ENOENT" });
  },
);

test("local launch rejects occupied ports before starting a database or watchers", async () => {
  const { assertAvailablePort } = await import("./dev-local.mjs");
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  try {
    await assert.rejects(assertAvailablePort(port), /already in use/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  await assertAvailablePort(port);
});

test("localhost mode is explicit and unknown launcher arguments fail closed", async () => {
  const { parseLaunchMode } = await import("./dev-local.mjs");
  assert.deepEqual(parseLaunchMode([]), { local: false });
  assert.deepEqual(parseLaunchMode(["--local"]), { local: true });
  assert.throws(() => parseLaunchMode(["--host", "0.0.0.0"]), /Usage/);
});

const tailscaleStatus = {
  BackendState: "Running",
  Self: { DNSName: "mbp16.tail102fab.ts.net.", Online: true },
};
const matchingServe = {
  TCP: { 443: { HTTPS: true } },
  Web: {
    "mbp16.tail102fab.ts.net:443": {
      Handlers: { "/": { Proxy: "http://127.0.0.1:5173" } },
    },
  },
};

test("Tailscale preflight accepts only the existing canonical HTTPS Serve route", async () => {
  const { canonicalOrigin, verifyTailscalePreflight } = await import("./dev-local.mjs");
  assert.equal(
    verifyTailscalePreflight({ status: tailscaleStatus, serve: matchingServe }),
    canonicalOrigin,
  );

  assert.throws(
    () =>
      verifyTailscalePreflight({
        status: tailscaleStatus,
        serve: { ...matchingServe, Web: {} },
      }),
    /Tailscale Serve must proxy https:\/\/mbp16\.tail102fab\.ts\.net to http:\/\/127\.0\.0\.1:5173/,
  );
  assert.throws(
    () =>
      verifyTailscalePreflight({
        status: { ...tailscaleStatus, BackendState: "Stopped" },
        serve: matchingServe,
      }),
    /Tailscale is not running/,
  );
  assert.throws(
    () =>
      verifyTailscalePreflight({
        status: { ...tailscaleStatus, Self: { ...tailscaleStatus.Self, Online: false } },
        serve: matchingServe,
      }),
    /Tailscale node is not online/,
  );
});

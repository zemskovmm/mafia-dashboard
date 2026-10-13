import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer } from "node:net";
import { execFileSync, spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { URL } from "node:url";
import test from "node:test";

const nativePostgresAvailable = ["initdb", "pg_ctl", "psql"].every(
  (command) => spawnSync(command, ["--version"]).status === 0,
);

test("local launch forwards explicit YouTube settings only to the API", async () => {
  const { apiSettings, canonicalOrigin, googleEnvironment, viteSettings } =
    await import("./dev-local.mjs");
  const google = {
    GOOGLE_CLIENT_ID: "test-client",
    GOOGLE_CLIENT_SECRET: "test-secret",
    GOOGLE_OAUTH_REDIRECT_URI: `${canonicalOrigin}/api/music/oauth/callback`,
    MUSIC_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64url"),
  };
  const selected = googleEnvironment({ ...google, UNRELATED_SECRET: "must-not-leak" });
  assert.deepEqual(selected, google);
  assert.deepEqual(googleEnvironment({ GOOGLE_CLIENT_ID: "" }), {});
  const storage = {
    STORAGE_PROVIDER: "azure",
    AZURE_STORAGE_CONNECTION_STRING:
      "DefaultEndpointsProtocol=http;AccountName=mafiadev;AccountKey=private-emulator-key;BlobEndpoint=http://127.0.0.1:13500/mafiadev;TableEndpoint=http://127.0.0.1:13502/mafiadev",
    AZURE_STORAGE_TABLE_NAME: "MafiaDevRecords",
    AZURE_STORAGE_CONTAINER_NAME: "mafia-dev-records",
    AZURE_STORAGE_PARTITION_KEY: "local",
    AZURE_STORAGE_INITIALIZE: "true",
  };
  const api = apiSettings({
    storage,
    origin: canonicalOrigin,
    google: selected,
  });
  for (const [key, value] of Object.entries(storage)) assert.equal(api[key], value);
  assert.equal(api.DATABASE_URL, undefined);
  for (const [key, value] of Object.entries(google)) assert.equal(api[key], value);
  assert.equal(api.UNRELATED_SECRET, undefined);
  const inherited = { ...google, UNRELATED_SECRET: "must-not-leak" };
  const previous = Object.fromEntries(Object.keys(inherited).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, inherited);
    const web = viteSettings();
    const apiWithoutExplicitConfig = apiSettings({
      storage,
      origin: canonicalOrigin,
      google: {},
    });
    for (const key of Object.keys(inherited)) {
      assert.equal(web[key], undefined);
      assert.equal(apiWithoutExplicitConfig[key], undefined);
    }
    assert.equal(web.MAFIA_API_PROXY_TARGET, "http://127.0.0.1:3000");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

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

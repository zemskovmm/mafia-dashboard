/* global URL */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";
import { startAzurite } from "./local-azurite.mjs";
import {
  assertLoopbackHttpOrigin,
  buildVerifierEnvironment,
  makeSession,
  sanitizeDiagnostic,
} from "./verify-local-backend.mjs";

const id = "a".repeat(32);
const storage = {
  STORAGE_PROVIDER: "azure",
  AZURE_STORAGE_CONNECTION_STRING: `DefaultEndpointsProtocol=http;AccountName=mafiatest;AccountKey=${"a".repeat(43)}=;BlobEndpoint=http://127.0.0.1:25100/mafiatest;QueueEndpoint=http://127.0.0.1:25101/mafiatest;TableEndpoint=http://127.0.0.1:25102/mafiatest`,
  AZURE_STORAGE_TABLE_NAME: `MafiaTest${id}`,
  AZURE_STORAGE_CONTAINER_NAME: `mafia-test-${id}`,
  AZURE_STORAGE_PARTITION_KEY: `test-${id}`,
  AZURE_STORAGE_INITIALIZE: "true",
};

test("local backend verifier accepts only separate non-default loopback origins", () => {
  assert.equal(assertLoopbackHttpOrigin("http://127.0.0.1:24101"), "http://127.0.0.1:24101");
  for (const candidate of [
    "https://127.0.0.1:24101",
    "http://localhost:24101",
    "http://0.0.0.0:24101",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "https://mafia.example.test",
  ]) {
    assert.throws(() => assertLoopbackHttpOrigin(candidate), /loopback|default|exact/i);
  }
});

test("local backend verifier passes only a minimal process-environment whitelist", () => {
  const { apiOrigin, serverEnv, webEnv, webOrigin } = buildVerifierEnvironment({
    apiPort: 24101,
    storage,
    inheritedEnv: {
      AWS_SECRET_ACCESS_KEY: "unrelated-secret",
      CI: "true",
      DATABASE_URL: "postgresql://developer:***@127.0.0.1:5432/mafia",
      TEST_DATABASE_URL: "postgresql://remote/test",
      AZURE_STORAGE_CONNECTION_STRING: "https://production.example.test",
      AZURE_STORAGE_TABLE_NAME: "Production",
      AZURITE_ACCOUNTS: "foreign:key",
      GOOGLE_CLIENT_ID: "real-client-id",
      GOOGLE_CLIENT_SECRET: "real-client-secret",
      GOOGLE_OAUTH_REDIRECT_URI: "https://accounts.example.test/callback",
      HOME: "/home/verifier",
      MAFIA_API_PROXY_TARGET: "https://remote.example.test",
      MUSIC_TOKEN_ENCRYPTION_KEY: "real-encryption-key",
      NODE_OPTIONS: "--import=unsafe.mjs",
      PATH: "/usr/bin",
      PGHOST: "developer-db.example.test",
      PORT: "3000",
      PUBLIC_APP_URL: "https://remote.example.test",
      SESSION_AUTH_COOKIE: "mafia_session=leaked-session-token",
      TMPDIR: "/tmp/verifier",
      UNRELATED_VALUE: "kept",
      VITE_LEAKED_ORIGIN: "https://remote.example.test",
    },
    webPort: 24102,
  });

  assert.equal(apiOrigin, "http://127.0.0.1:24101");
  assert.equal(webOrigin, "http://127.0.0.1:24102");
  for (const [key, value] of Object.entries(storage)) assert.equal(serverEnv[key], value, key);
  assert.equal(serverEnv.PUBLIC_APP_URL, webOrigin);
  assert.equal(serverEnv.GOOGLE_CLIENT_ID, "local-backend-verifier-client");
  assert.equal(serverEnv.GOOGLE_CLIENT_SECRET, "local-backend-verifier-secret");
  assert.equal(webEnv.MAFIA_API_PROXY_TARGET, apiOrigin);
  assert.equal(serverEnv.PATH, "/usr/bin");
  assert.equal(serverEnv.HOME, "/home/verifier");
  assert.equal(serverEnv.TMPDIR, "/tmp/verifier");
  assert.equal(serverEnv.CI, "true");
  assert.equal(serverEnv.LC_ALL, "C");
  for (const environment of [serverEnv, webEnv]) {
    assert.equal(environment.DATABASE_URL, undefined);
    assert.equal(environment.TEST_DATABASE_URL, undefined);
    assert.equal(environment.AZURITE_ACCOUNTS, undefined);
    assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(environment.NODE_OPTIONS, undefined);
    assert.equal(environment.PGHOST, undefined);
    assert.equal(environment.GOOGLE_OAUTH_REDIRECT_URI, undefined);
    assert.equal(environment.MUSIC_TOKEN_ENCRYPTION_KEY, undefined);
    assert.equal(environment.SESSION_AUTH_COOKIE, undefined);
    assert.equal(environment.UNRELATED_VALUE, undefined);
    assert.equal(environment.VITE_LEAKED_ORIGIN, undefined);
  }
  for (const key of Object.keys(storage)) assert.equal(webEnv[key], undefined, key);
});

test("local backend verifier accepts only the owned disposable Azurite namespace", () => {
  for (const target of [
    undefined,
    { ...storage, STORAGE_PROVIDER: "postgres" },
    {
      ...storage,
      AZURE_STORAGE_CONNECTION_STRING: storage.AZURE_STORAGE_CONNECTION_STRING.replace(
        "127.0.0.1",
        "remote.example.test",
      ),
    },
    {
      ...storage,
      AZURE_STORAGE_CONNECTION_STRING: storage.AZURE_STORAGE_CONNECTION_STRING.replace(
        "127.0.0.1",
        "user:password@127.0.0.1",
      ),
    },
    { ...storage, AZURE_STORAGE_TABLE_NAME: "MafiaDevRecords" },
    { ...storage, AZURE_STORAGE_CONTAINER_NAME: "mafia-dev-records" },
    { ...storage, AZURE_STORAGE_PARTITION_KEY: "production" },
    { ...storage, AZURE_STORAGE_INITIALIZE: "false" },
  ]) {
    assert.throws(
      () =>
        buildVerifierEnvironment({
          apiPort: 24101,
          storage: target,
          inheritedEnv: {},
          webPort: 24102,
        }),
      /owned loopback Azurite/i,
    );
  }
  assert.throws(
    () => buildVerifierEnvironment({ apiPort: 24101, storage, inheritedEnv: {}, webPort: 24101 }),
    /separate ports/,
  );
});

test("verifier diagnostics redact session cookies, storage and forbidden database credentials", () => {
  const diagnostic = sanitizeDiagnostic(
    [
      "SESSION_AUTH_COOKIE=mafia_session=opaque-session-token",
      "GOOGLE_CLIENT_SECRET=synthetic-google-secret",
      "DATABASE_PASSWORD=synthetic-password",
      "postgresql://mafia@127.0.0.1:25432/mafia_test",
      "AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=http;AccountKey=synthetic-storage-key;TableEndpoint=http://127.0.0.1:25102/mafiatest",
    ].join(" "),
  );
  assert.doesNotMatch(
    diagnostic,
    /opaque-session-token|synthetic-google-secret|synthetic-password|mafia_test|synthetic-storage-key|mafiatest/,
  );
  assert.match(diagnostic, /\[redacted-cookie\]|\[redacted-url\]/);
});

test(
  "verifier seeds ordinary Azure account/session records with expiry and revocation",
  { timeout: 60_000 },
  async () => {
    const { createAzureStores } = await tsImport(
      "../apps/server/src/azure-stores.ts",
      import.meta.url,
    );
    const fixture = await startAzurite({ mode: "test" });
    const environment = fixture.environment;
    const azure = createAzureStores({
      connectionString: environment.AZURE_STORAGE_CONNECTION_STRING,
      tableName: environment.AZURE_STORAGE_TABLE_NAME,
      containerName: environment.AZURE_STORAGE_CONTAINER_NAME,
      partitionKey: environment.AZURE_STORAGE_PARTITION_KEY,
    });
    try {
      await azure.initialize();
      const active = await makeSession(azure.auth, {
        displayName: "Verifier owner",
        expiresAt: new Date(Date.now() + 60_000),
      });
      const expired = await makeSession(azure.auth, {
        displayName: "Expired verifier",
        expiresAt: new Date(Date.now() - 60_000),
      });
      assert.deepEqual(await azure.auth.findSession(active.tokenHash, new Date()), {
        id: active.userId,
        email: `${active.userId}@local-backend-verifier.invalid`,
        name: "Verifier owner",
        picture: null,
      });
      assert.equal(await azure.auth.findSession(expired.tokenHash, new Date()), null);
      await azure.auth.removeSession(active.tokenHash);
      assert.equal(await azure.auth.findSession(active.tokenHash, new Date()), null);
    } finally {
      try {
        await azure.end();
      } finally {
        await fixture.stop();
      }
    }
  },
);

test("browser smoke preserves and measures the production Secure cookie setting", async () => {
  const source = await readFile(new URL("./verify-local-backend.mjs", import.meta.url), "utf8");
  assert.match(source, /secure:\s*true/u);
  assert.match(source, /chromium-secure-loopback-cookie-sent/u);
});

test("browser smoke code cannot fulfill or route API fixtures", async () => {
  const source = await readFile(new URL("./verify-local-backend.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /\.route\s*\(/,
    "real backend verification must not route browser requests",
  );
  assert.doesNotMatch(
    source,
    /route\.fulfill|fulfill\s*\(/,
    "real backend verification must not fulfill API fixtures",
  );
});

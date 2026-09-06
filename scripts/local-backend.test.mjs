/* global URL */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  assertLoopbackHttpOrigin,
  buildVerifierEnvironment,
  sanitizeDiagnostic,
} from "./verify-local-backend.mjs";

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
  const databaseUrl = "postgresql://mafia@127.0.0.1:25432/mafia_test";
  const { apiOrigin, serverEnv, webEnv, webOrigin } = buildVerifierEnvironment({
    apiPort: 24101,
    databaseUrl,
    inheritedEnv: {
      AWS_SECRET_ACCESS_KEY: "unrelated-secret",
      CI: "true",
      DATABASE_URL: "postgresql://developer:development-password@127.0.0.1:5432/mafia",
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
  assert.equal(serverEnv.DATABASE_URL, databaseUrl);
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
    assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(environment.NODE_OPTIONS, undefined);
    assert.equal(environment.PGHOST, undefined);
    assert.equal(environment.GOOGLE_OAUTH_REDIRECT_URI, undefined);
    assert.equal(environment.MUSIC_TOKEN_ENCRYPTION_KEY, undefined);
    assert.equal(environment.SESSION_AUTH_COOKIE, undefined);
    assert.equal(environment.UNRELATED_VALUE, undefined);
    assert.equal(environment.VITE_LEAKED_ORIGIN, undefined);
  }
});

test("local backend verifier accepts only the owned disposable PostgreSQL target", () => {
  for (const databaseUrl of [
    "postgresql://mafia@127.0.0.1:54328/mafia_test",
    "postgresql://mafia@127.0.0.1:25432/mafia_local",
    "postgresql://mafia@remote.example.test:25432/mafia_test",
    "postgresql://127.0.0.1:25432/mafia_test",
    "postgresql://other@127.0.0.1:25432/mafia_test",
  ]) {
    assert.throws(
      () =>
        buildVerifierEnvironment({ apiPort: 24101, databaseUrl, inheritedEnv: {}, webPort: 24102 }),
      /isolated loopback database/i,
    );
  }
});

test("verifier diagnostics redact session cookies and database credentials", () => {
  const diagnostic = sanitizeDiagnostic(
    [
      "SESSION_AUTH_COOKIE=mafia_session=opaque-session-token",
      "GOOGLE_CLIENT_SECRET=synthetic-google-secret",
      "DATABASE_PASSWORD=synthetic-password",
      "postgresql://mafia@127.0.0.1:25432/mafia_test",
    ].join(" "),
  );
  assert.doesNotMatch(
    diagnostic,
    /opaque-session-token|synthetic-google-secret|synthetic-password|mafia_test/,
  );
  assert.match(diagnostic, /\[redacted-cookie\]|\[redacted-url\]/);
});

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

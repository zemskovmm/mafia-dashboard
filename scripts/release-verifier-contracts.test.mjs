/* global URL */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  RELEASE_GATES,
  assertNoReleaseArguments,
  assertReleaseCandidate,
  assertReleaseEnvironment,
  composeAppVersion,
  redactDiagnostic,
  runGateMatrix,
} from "./release-verifier-contracts.mjs";

const commit = "a".repeat(40);
const environment = {
  APP_URL: "https://mafia.example.test",
  APP_BUILD_INDEX: "123",
  RELEASE_COMMIT: commit,
  SESSION_AUTH_COOKIE: "mafia_session=opaque-value",
  SESSION_CLUB_ID: "00000000-0000-4000-8000-000000000101",
  SESSION_VERIFY_ALLOW_REMOTE: "1",
  SESSION_VERIFY_EXPECTED_ORIGIN: "https://mafia.example.test",
};

test("release matrix is complete, fixed, and ordered", () => {
  assert.deepEqual(
    RELEASE_GATES.map(({ name }) => name),
    ["check", "compose", "backup", "ui", "ui-hardening", "session", "oauth"],
  );
  assert.deepEqual(
    RELEASE_GATES.map(({ command, args }) => [command, ...args]),
    RELEASE_GATES.map(({ name }) => ["npm", "run", name === "check" ? "check" : `verify:${name}`]),
  );
});

test("release gate rejects every positional or skip argument", () => {
  assert.doesNotThrow(() => assertNoReleaseArguments([]));
  for (const args of [["--skip-oauth"], ["compose"], ["--", "--skip-session"]]) {
    assert.throws(() => assertNoReleaseArguments(args), /does not accept arguments/i);
  }
});

test("release environment is fail-closed and normalized", () => {
  assert.deepEqual(assertReleaseEnvironment(environment), {
    appUrl: environment.APP_URL,
    buildIndex: environment.APP_BUILD_INDEX,
    commit,
    expectedOrigin: environment.APP_URL,
  });
  for (const key of Object.keys(environment)) {
    assert.throws(
      () => assertReleaseEnvironment({ ...environment, [key]: undefined }),
      new RegExp(key),
      `${key} must be mandatory`,
    );
  }
  assert.throws(
    () => assertReleaseEnvironment({ ...environment, APP_URL: "http://mafia.example.test" }),
    /HTTPS/i,
  );
  assert.throws(
    () => assertReleaseEnvironment({ ...environment, APP_URL: `${environment.APP_URL}/path` }),
    /origin/i,
  );
  assert.throws(
    () =>
      assertReleaseEnvironment({
        ...environment,
        SESSION_VERIFY_EXPECTED_ORIGIN: "https://other.example.test",
      }),
    /origin/i,
  );
});

test("app identity uses root package major/minor and replaces its patch with the build index", () => {
  assert.equal(composeAppVersion("2.7.9", "123"), "2.7.123");
  assert.equal(composeAppVersion("2.7.9", "0"), "2.7.0");
  assert.equal(composeAppVersion("0.0.0", "0"), "0.0.0");
  for (const index of ["", "01", "+1", "-1", "1.0", " 1", "9007199254740992", undefined]) {
    assert.throws(() => composeAppVersion("2.7.9", index), /APP_BUILD_INDEX/);
  }
  for (const version of [
    undefined,
    {},
    "-1.0.0",
    "1.0",
    "01.0.0",
    "1.0.0-beta",
    "1.0.0.1",
    "1.9007199254740992.0",
    "1.0.9007199254740992",
  ]) {
    assert.throws(() => composeAppVersion(version, "0"), /package.json version/);
  }
});

test("candidate contract binds local and deployed identity", () => {
  assert.doesNotThrow(() =>
    assertReleaseCandidate({
      appVersion: "2.7.123",
      head: commit,
      releaseCommit: commit,
      trackedStatus: "",
      deployedIdentity: { version: "2.7.123", commit },
    }),
  );
  for (const candidate of [
    { appVersion: "2.7.124" },
    { head: "b".repeat(40) },
    { trackedStatus: " M package.json" },
    { deployedIdentity: { version: "2.7.123", commit: "b".repeat(40) } },
    { deployedIdentity: { version: "2.7.124", commit } },
  ]) {
    assert.throws(() =>
      assertReleaseCandidate({
        appVersion: "2.7.123",
        head: commit,
        releaseCommit: commit,
        trackedStatus: "",
        deployedIdentity: { version: "2.7.123", commit },
        ...candidate,
      }),
    );
  }
});

test("workspace dependency pins stay consistent independently of the root app version", async () => {
  const paths = [
    "../package.json",
    "../apps/web/package.json",
    "../apps/server/package.json",
    "../packages/game-domain/package.json",
    "../package-lock.json",
  ];
  const [root, web, server, domain, lockfile] = await Promise.all(
    paths.map(async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"))),
  );
  for (const manifest of [root, web, server, domain]) {
    assert.equal(manifest.private, true);
  }
  assert.doesNotThrow(() => composeAppVersion(root.version, "0"));
  for (const manifest of [web, server, domain]) assert.equal(manifest.version, "1.0.0");
  assert.equal(web.dependencies["@mafia/game-domain"], "^1.0.0");
  assert.equal(server.dependencies["@mafia/game-domain"], "^1.0.0");
  assert.equal(lockfile.version, lockfile.packages[""].version);
  for (const path of ["apps/web", "apps/server", "packages/game-domain"]) {
    assert.equal(lockfile.packages[path].version, "1.0.0");
  }
  assert.equal(lockfile.packages["apps/web"].dependencies["@mafia/game-domain"], "^1.0.0");
  assert.equal(lockfile.packages["apps/server"].dependencies["@mafia/game-domain"], "^1.0.0");
});

test("gate runner executes once in order and stops on the first failure", async () => {
  const calls = [];
  const success = await runGateMatrix({
    gates: RELEASE_GATES,
    runCommand: async (gate) => {
      calls.push(gate.name);
      return { status: 0, signal: null, stdout: "ok", stderr: "" };
    },
    now: (() => {
      let value = 0;
      return () => (value += 10);
    })(),
  });
  assert.deepEqual(
    calls,
    RELEASE_GATES.map(({ name }) => name),
  );
  assert(success.every(({ status }) => status === "PASS"));

  for (const failedGate of RELEASE_GATES) {
    calls.length = 0;
    await assert.rejects(
      runGateMatrix({
        gates: RELEASE_GATES,
        runCommand: async (gate) => {
          calls.push(gate.name);
          return {
            status: gate.name === failedGate.name ? 7 : 0,
            signal: null,
            stdout: "",
            stderr: gate.name === failedGate.name ? "failed" : "",
          };
        },
      }),
      (error) => {
        assert.equal(error.gate, failedGate.name);
        assert.equal(error.results.at(-1).status, "FAIL");
        return true;
      },
    );
    assert.deepEqual(
      calls,
      RELEASE_GATES.slice(0, RELEASE_GATES.indexOf(failedGate) + 1).map(({ name }) => name),
    );
  }

  await assert.rejects(
    runGateMatrix({
      gates: [RELEASE_GATES[0]],
      runCommand: async () => {
        throw new Error("deployment drifted");
      },
    }),
    (error) => error.gate === "check" && error.outcome.error.message === "deployment drifted",
  );
});

test("diagnostic redaction is literal, bounded, and credential-safe", () => {
  const secret = environment.SESSION_AUTH_COOKIE;
  const output = redactDiagnostic(
    `${secret}\nAuthorization: Bearer token-value\n${"x".repeat(80_000)}`,
    [secret],
  );
  assert.doesNotMatch(output, /opaque-value|token-value/);
  assert.match(output, /\[redacted\]/);
  assert.match(output, /\[truncated\]$/);
  assert(output.length < 70_000);
});

test("root scripts expose release contracts without nesting operational drills in check", async () => {
  const [packageSource, verifier] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("./verify-release.mjs", import.meta.url), "utf8"),
  ]);
  const packageJson = JSON.parse(packageSource);
  assert.equal(
    packageJson.scripts["test:release-contracts"],
    "node --test scripts/release-verifier-contracts.test.mjs",
  );
  assert.equal(packageJson.scripts["verify:release"], "node scripts/verify-release.mjs");
  assert.match(packageJson.scripts.test, /test:release-contracts/);
  assert.doesNotMatch(packageJson.scripts.check, /verify:release|verify:compose|verify:oauth/);
  assert.match(
    verifier,
    /await verifyDeploymentIdentity\(\);[\s\S]*spawnSync\(gate\.command[\s\S]*await verifyDeploymentIdentity\(\);/,
  );
  assert.match(verifier, /readFileSync\(new URL\("\.\.\/package\.json", import\.meta\.url\)/);
  assert.match(verifier, /composeAppVersion\(packageVersion, release\.buildIndex\)/);
  assert.doesNotMatch(verifier, /version\.json/);
});

test("v1 checklist publishes the complete release contract without a false PASS", async () => {
  const checklist = await readFile(new URL("../docs/releases/v1.0.0.md", import.meta.url), "utf8");
  for (const heading of [
    "Release status",
    "Prerequisites and blockers",
    "Release gate matrix",
    "Operational drill matrix",
    "Supported deployment boundary",
    "Security and privacy residual risks",
    "Explicit v1 exclusions",
    "Linked deferrals",
    "Rollback",
    "Qualification evidence",
    "Sign-off",
  ]) {
    assert.match(checklist, new RegExp(`^## ${heading}$`, "m"));
  }
  for (const gate of RELEASE_GATES) {
    const command = gate.args.join(" ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(checklist, new RegExp(command));
  }
  for (const link of [
    "../self-hosted-deployment.md",
    "../azure-deployment.md",
    "../postgresql-backup-and-recovery.md",
    "../security-and-privacy.md",
    "https://github.com/zemskovmm/mafia-dashboard/issues/23",
    "https://github.com/zemskovmm/mafia-dashboard/issues/48",
  ]) {
    assert.match(checklist, new RegExp(link.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(checklist, /skipped\s*[|:]\s*PASS/i);
  assert.match(checklist, /Export is not included in v1\.0\.0/);
});

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { composeAppVersion } from "./release-verifier-contracts.mjs";

const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;

function run(command, env) {
  return spawnSync(process.execPath, ["scripts/azure-release.mjs", command], {
    env: {
      PATH: process.env.PATH,
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REPOSITORY: "zemskovmm/mafia-dashboard",
      GITHUB_SHA: head,
      GITHUB_RUN_NUMBER: "431",
      GITHUB_RUN_ID: "5001",
      GITHUB_RUN_ATTEMPT: "1",
      ...env,
    },
    encoding: "utf8",
    timeout: 5_000,
  });
}

test("build CLI derives identity from the checked-out commit; a retry gets a unique tag but the original version", () => {
  const dir = mkdtempSync(join(tmpdir(), "mafia-release-cli-"));
  try {
    for (const attempt of ["1", "2"]) {
      const output = join(dir, `release-${attempt}.out`);
      const result = run("build-identity", { GITHUB_OUTPUT: output, GITHUB_RUN_ATTEMPT: attempt });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        readFileSync(output, "utf8"),
        [
          `commit=${head}`,
          "build_index=431",
          `app_version=${composeAppVersion(packageVersion, "431")}`,
          `tag=ghcr.io/zemskovmm/mafia-dashboard:${head}-5001-${attempt}`,
          "",
        ].join("\n"),
      );
    }
    const output = join(dir, "rejected.out");
    for (const env of [
      { GITHUB_SHA: "0".repeat(40) },
      { GITHUB_REF: "refs/heads/side" },
      { GITHUB_RUN_ID: "test-fixture-private-value" },
      { GITHUB_RUN_ATTEMPT: "01" },
    ]) {
      const result = run("build-identity", { ...env, GITHUB_OUTPUT: output });
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stdout + result.stderr, /test-fixture-private-value/);
      assert.throws(() => readFileSync(output), { code: "ENOENT" });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deployment CLI rejects an incorrect target without revealing the supplied value", () => {
  const result = run("deploy", { AZURE_SUBSCRIPTION_ID: "test-fixture-private-value" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Production target mismatch: AZURE_SUBSCRIPTION_ID\n");
});

/* global Buffer */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RELEASE_TARGETS, STAGING_WORKFLOW } from "./azure-release.mjs";

const repository = "zemskovmm/mafia-dashboard";
const commit = "a".repeat(40);
const image = `ghcr.io/${repository}@sha256:${"b".repeat(64)}`;
const stagingUrl = "https://mafiadashboard-stg-app.fixture.northeurope.azurecontainerapps.io";
const script = "scripts/azure-release.mjs";

function run(command, env) {
  return spawnSync(process.execPath, [script, command], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
}

function targetEnv(environment) {
  const target = RELEASE_TARGETS[environment];
  return {
    AZURE_SUBSCRIPTION_ID: target.subscriptionId,
    AZURE_RESOURCE_GROUP: target.resourceGroup,
    AZURE_LOCATION: target.location,
    AZURE_NAME_PREFIX: target.namePrefix,
    AZURE_STORAGE_ACCOUNT_NAME: target.storageAccountName,
    AZURE_STORAGE_TABLE_NAME: target.storageTableName,
    AZURE_STORAGE_CONTAINER_NAME: target.storageContainerName,
    AZURE_STORAGE_PARTITION_KEY: target.storagePartitionKey,
    RELEASE_ENVIRONMENT: environment,
    GITHUB_REPOSITORY: repository,
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: environment === "production" ? "workflow_dispatch" : "push",
    GITHUB_WORKFLOW_REF: `${repository}/${environment === "production" ? ".github/workflows/deploy-production.yml" : STAGING_WORKFLOW}@refs/heads/main`,
    EXPECTED_COMMIT: commit,
    APP_BUILD_INDEX: "170",
    EXPECTED_VERSION: "1.0.170",
    INITIALIZE_STORAGE: "false",
  };
}

test("real target CLI rejects cross-environment/caller/trigger identity and preserves selected production identity", () => {
  for (const environment of ["staging", "production"]) {
    const env = targetEnv(environment);
    assert.equal(run("validate-target", env).status, 0);
    for (const mutation of [
      {
        AZURE_STORAGE_ACCOUNT_NAME:
          RELEASE_TARGETS[environment === "staging" ? "production" : "staging"].storageAccountName,
      },
      { GITHUB_REPOSITORY: "untrusted/repo" },
      { GITHUB_REF: "refs/heads/feature" },
      { GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/ci.yml@refs/heads/main` },
      { APP_BUILD_INDEX: "0170" },
      { EXPECTED_VERSION: "1.0.171" },
      { EXPECTED_COMMIT: "main" },
    ])
      assert.notEqual(
        run("validate-target", { ...env, ...mutation }).status,
        0,
        JSON.stringify(mutation),
      );
  }
  const env = targetEnv("production");
  assert.equal(
    run("validate-target", { ...env, GITHUB_SHA: "c".repeat(40), GITHUB_RUN_NUMBER: "999" }).status,
    0,
  );
  assert.notEqual(run("validate-target", { ...env, INITIALIZE_STORAGE: "true" }).status, 0);
  assert.notEqual(run("validate-target", { ...env, GITHUB_EVENT_NAME: "push" }).status, 0);
  assert.equal(
    run("validate-target", { ...targetEnv("staging"), INITIALIZE_STORAGE: "true" }).status,
    0,
  );
});

test("real selection CLI verifies downloaded ZIP digest and exact record, readiness and safe outputs", () => {
  const directory = mkdtempSync(join(tmpdir(), "mafia-release-cli-"));
  const output = join(directory, "outputs");
  const summary = join(directory, "summary");
  const calls = join(directory, "calls");
  const dataPath = join(directory, "api.json");
  const zipPath = join(directory, "release.zip");
  const env = {
    PATH: `${directory}:${process.env.PATH}`,
    RUNNER_TEMP: directory,
    TMPDIR: directory,
    GITHUB_REPOSITORY: repository,
    GITHUB_SHA: commit,
    GITHUB_EVENT_NAME: "push",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_RUN_NUMBER: "170",
    DEPLOY_IMAGE: image,
    STAGING_APP_URL: stagingUrl,
    STAGING_RUN_ID: "",
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    MOCK_API: dataPath,
    MOCK_ZIP: zipPath,
    MOCK_CALLS: calls,
  };
  try {
    const recorded = run("record", env);
    assert.equal(recorded.status, 0, recorded.stderr);
    const release = JSON.parse(readFileSync(join(directory, "release.json"), "utf8"));
    assert.equal(release.buildIndex, "170");
    assert.equal(release.commit, commit);
    assert.equal(release.appVersion, "1.0.170");
    const zipped = spawnSync("zip", ["-q", zipPath, "release.json"], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.equal(zipped.status, 0, zipped.stderr);
    const bytes = readFileSync(zipPath);
    const runMetadata = {
      id: 123,
      run_attempt: 2,
      run_number: 170,
      head_sha: commit,
      head_branch: "main",
      event: "push",
      path: STAGING_WORKFLOW,
      workflow_id: 42,
      status: "completed",
      conclusion: "success",
      repository: { full_name: repository, id: 55 },
      head_repository: { full_name: repository, id: 55 },
    };
    const artifact = {
      id: 456,
      name: "staging-release-123-2",
      expired: false,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      workflow_run: {
        id: 123,
        repository_id: 55,
        head_repository_id: 55,
        head_sha: commit,
        head_branch: "main",
      },
    };
    const base = `repos/${repository}/actions`;
    const responses = {
      [`${base}/workflows/deploy-azure.yml`]: { id: 42, path: STAGING_WORKFLOW, state: "active" },
      [`${base}/workflows/deploy-azure.yml/runs?branch=main&per_page=1`]: {
        workflow_runs: [runMetadata],
      },
      [`${base}/runs/123`]: runMetadata,
      [`${base}/runs/123/artifacts?name=staging-release-123-2&per_page=100`]: {
        total_count: 1,
        artifacts: [artifact],
      },
    };
    writeFileSync(dataPath, JSON.stringify(responses));
    writeFileSync(
      join(directory, "gh"),
      `#!${process.execPath}
const fs = require("node:fs");
const path = process.argv.at(-1);
fs.appendFileSync(process.env.MOCK_CALLS, path + "\\n");
if (path.endsWith("/zip")) {
  if (process.env.MOCK_UNAVAILABLE === "1") process.exit(1);
  process.stdout.write(fs.readFileSync(process.env.MOCK_ZIP));
} else {
  const response = JSON.parse(fs.readFileSync(process.env.MOCK_API, "utf8"))[path];
  if (!response) process.exit(2);
  process.stdout.write(JSON.stringify(response));
}
`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(directory, "curl"),
      `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(process.env.MOCK_CALLS, process.argv.at(-1) + "\\n");
if (process.argv.at(-1).endsWith("/health/ready")) process.exit(Number(process.env.MOCK_READY_STATUS || 0));
process.stdout.write(process.env.MOCK_CURRENT_IDENTITY);
`,
      { mode: 0o700 },
    );
    const select = (extra = {}) => {
      writeFileSync(output, "");
      writeFileSync(summary, "");
      return run("select", {
        ...env,
        GITHUB_RUN_NUMBER: "999",
        GITHUB_SHA: "c".repeat(40),
        MOCK_CURRENT_IDENTITY: JSON.stringify({ version: release.appVersion, commit }),
        ...extra,
      });
    };
    const selected = select();
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(
      readFileSync(output, "utf8"),
      `image=${image}\ncommit=${commit}\nbuild_index=170\napp_version=1.0.170\nrun_id=123\nrun_attempt=2\n`,
    );
    assert.match(readFileSync(summary, "utf8"), /Selection is frozen/);
    assert.match(readFileSync(calls, "utf8"), /\/health\/ready/);
    assert.notEqual(select({ MOCK_READY_STATUS: "1" }).status, 0);
    assert.equal(readFileSync(output, "utf8"), "");
    assert.notEqual(
      select({ MOCK_CURRENT_IDENTITY: JSON.stringify({ version: "1.0.171", commit }) }).status,
      0,
    );
    assert.equal(
      select({ STAGING_RUN_ID: "123", MOCK_READY_STATUS: "1" }).status,
      0,
      "explicit historical selection does not require current staging",
    );
    assert.notEqual(select({ MOCK_UNAVAILABLE: "1" }).status, 0);
    assert.equal(readFileSync(output, "utf8"), "");
    writeFileSync(zipPath, Buffer.from("altered archive"));
    const changed = select();
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /digest mismatch/i);
    assert.equal(readFileSync(output, "utf8"), "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/* global URL, Buffer, structuredClone */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const load = () => import("./azure-release.mjs");
const repository = "zemskovmm/mafia-dashboard";
const commit = "a".repeat(40);
const image = `ghcr.io/${repository}@sha256:${"b".repeat(64)}`;
const stagingUrl = "https://mafiadashboard-stg-app.fixture.northeurope.azurecontainerapps.io";
const run = {
  id: 123,
  run_attempt: 2,
  run_number: 170,
  head_sha: commit,
  head_branch: "main",
  event: "push",
  path: ".github/workflows/deploy-azure.yml",
  workflow_id: 42,
  status: "completed",
  conclusion: "success",
  repository: { full_name: repository, id: 55 },
  head_repository: { full_name: repository, id: 55 },
};
const release = {
  schemaVersion: 1,
  repository,
  workflow: ".github/workflows/deploy-azure.yml",
  branch: "main",
  runId: "123",
  runAttempt: "2",
  buildIndex: "170",
  commit,
  image,
  packageVersion: "1.0.0",
  appVersion: "1.0.170",
  stagingUrl,
  verification: "azure-readiness-version-configuration",
};
const artifact = {
  id: 456,
  name: "staging-release-123-2",
  expired: false,
  digest: `sha256:${"c".repeat(64)}`,
  workflow_run: {
    id: 123,
    repository_id: 55,
    head_repository_id: 55,
    head_sha: commit,
    head_branch: "main",
  },
};

function fixture(overrides = {}) {
  const calls = [];
  return {
    calls,
    repository,
    requestedRunId: "",
    stagingUrl,
    api: async (path) => {
      calls.push(path);
      if (path.endsWith("/workflows/deploy-azure.yml"))
        return { id: 42, path: run.path, state: "active" };
      if (path.includes("/workflows/deploy-azure.yml/runs?")) return { workflow_runs: [run] };
      if (path.includes("/artifacts?")) return { total_count: 1, artifacts: [artifact] };
      if (path.endsWith("/runs/123")) return run;
      throw new Error(`Unexpected API request ${path}`);
    },
    readArtifact: async () => structuredClone(release),
    currentIdentity: async () => ({ version: release.appVersion, commit }),
    ...overrides,
  };
}

test("release records freeze staging build identity, never the promotion's identity", async () => {
  const { validateReleaseRecord } = await load();
  const selected = validateReleaseRecord(release, run, { repository, workflowId: 42 });
  assert.deepEqual(selected, release);
  assert.ok(Object.isFrozen(selected));
  release.image = image; // Caller mutation cannot replace the selected snapshot.
  assert.equal(selected.buildIndex, "170");
  assert.equal(selected.appVersion, "1.0.170");
});

test("promotion rejects wrong repository/workflow/branch/status/event/attempt/build/digest evidence", async () => {
  const { validateReleaseRecord } = await load();
  for (const mutation of [
    { status: "in_progress" },
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { head_branch: "feature" },
    { event: "pull_request" },
    { path: ".github/workflows/other.yml" },
    { workflow_id: 99 },
    { head_sha: "d".repeat(40) },
    { run_attempt: 3 },
    { run_number: 171 },
    { repository: { full_name: "other/repo", id: 55 } },
    { head_repository: { full_name: repository, id: 56 } },
  ])
    assert.throws(
      () => validateReleaseRecord(release, { ...run, ...mutation }, { repository, workflowId: 42 }),
      undefined,
      JSON.stringify(mutation),
    );
  for (const mutation of [
    { schemaVersion: 2 },
    { repository: "other/repo" },
    { workflow: ".github/workflows/other.yml" },
    { branch: "feature" },
    { runId: "0123" },
    { runId: "124" },
    { runAttempt: "1" },
    { buildIndex: "171" },
    { commit: "d".repeat(40) },
    { appVersion: "1.0.171" },
    { image: `ghcr.io/${repository}:main` },
    { image: `ghcr.io/other/repo@sha256:${"b".repeat(64)}` },
    { image: `${image}\nunsafe=1` },
    { verification: undefined },
    { stagingUrl: "https://mafiadashboard-app.fixture.northeurope.azurecontainerapps.io" },
  ])
    assert.throws(
      () => validateReleaseRecord({ ...release, ...mutation }, run, { repository, workflowId: 42 }),
      undefined,
      JSON.stringify(mutation),
    );
});

test("default selects the newest run without filtering away failures, and matches current staging", async () => {
  const { selectStagingRelease } = await load();
  const options = fixture();
  assert.deepEqual(await selectStagingRelease(options), release);
  assert.ok(options.calls.some((path) => path.includes("branch=main")));
  assert.ok(options.calls.every((path) => !path.includes("status=success")));
  for (const current of [
    null,
    {},
    { version: "1.0.171", commit },
    { version: "1.0.170", commit: "d".repeat(40) },
  ]) {
    await assert.rejects(
      selectStagingRelease(fixture({ currentIdentity: async () => current })),
      /current staging/i,
    );
  }
  await assert.rejects(
    selectStagingRelease(fixture({ stagingUrl: `${stagingUrl}/path` })),
    /staging.*origin/i,
  );
  const base = fixture();
  await assert.rejects(
    selectStagingRelease(
      fixture({
        api: async (path) =>
          path.includes("/runs/123") ? { ...run, conclusion: "failure" } : base.api(path),
      }),
    ),
    /successful/i,
  );
  await assert.rejects(
    selectStagingRelease(
      fixture({
        api: async (path) => (path.includes("/runs?") ? { workflow_runs: [] } : base.api(path)),
      }),
    ),
    /staging run/i,
  );
});

test("explicit historical selection is exact, successful, and independent of current staging", async () => {
  const { selectStagingRelease } = await load();
  const options = fixture({
    requestedRunId: "123",
    currentIdentity: async () => {
      throw new Error("must not inspect current staging");
    },
  });
  const selected = await selectStagingRelease(options);
  assert.deepEqual(selected, release);
  assert.ok(options.calls.every((path) => !path.includes("/runs?")));
  for (const requestedRunId of ["0", "0123", "123\n", "-1", "1/../123", "9007199254740992"]) {
    await assert.rejects(selectStagingRelease(fixture({ requestedRunId })), /run ID/i);
  }
});

test("missing, expired, duplicate, mismatched and unavailable artifacts fail closed", async () => {
  const { selectStagingRelease } = await load();
  for (const artifacts of [
    [],
    [artifact, artifact],
    [{ ...artifact, expired: true }],
    [{ ...artifact, digest: null }],
    [{ ...artifact, name: "staging-release-123-1" }],
    [{ ...artifact, workflow_run: { ...artifact.workflow_run, head_sha: "d".repeat(40) } }],
  ]) {
    const base = fixture();
    await assert.rejects(
      selectStagingRelease(
        fixture({
          api: async (path) =>
            path.includes("/artifacts?")
              ? { total_count: artifacts.length, artifacts }
              : base.api(path),
        }),
      ),
      /artifact/i,
    );
  }
  await assert.rejects(
    selectStagingRelease(
      fixture({
        readArtifact: async () => {
          throw new Error("artifact unavailable");
        },
      }),
    ),
    /unavailable/,
  );
});

test("a rerun during selection invalidates evidence instead of changing the selected release", async () => {
  const { selectStagingRelease } = await load();
  const base = fixture();
  let reads = 0;
  await assert.rejects(
    selectStagingRelease(
      fixture({
        api: async (path) =>
          path.endsWith("/runs/123") && ++reads > 1
            ? { ...run, run_attempt: 3, status: "in_progress", conclusion: null }
            : base.api(path),
      }),
    ),
    /successful|attempt|changed/i,
  );
});

test("archive digest must match before parsing its immutable release record", async () => {
  const { verifyArtifactDigest } = await load();
  const { createHash } = await import("node:crypto");
  const bytes = Buffer.from("real downloaded artifact bytes");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  assert.doesNotThrow(() => verifyArtifactDigest(bytes, digest));
  assert.throws(() => verifyArtifactDigest(Buffer.from("changed bytes"), digest), /digest/i);
  assert.throws(() => verifyArtifactDigest(bytes, undefined), /digest/i);
});

test("environment bindings reject any cross-environment target before Azure login", async () => {
  const { RELEASE_TARGETS, assertReleaseTarget } = await load();
  for (const environment of ["staging", "production"]) {
    assert.doesNotThrow(() =>
      assertReleaseTarget(environment, { ...RELEASE_TARGETS[environment] }),
    );
    for (const field of Object.keys(RELEASE_TARGETS[environment])) {
      assert.throws(
        () =>
          assertReleaseTarget(environment, { ...RELEASE_TARGETS[environment], [field]: "wrong" }),
        /target/i,
        field,
      );
    }
    assert.throws(
      () =>
        assertReleaseTarget(
          environment,
          RELEASE_TARGETS[environment === "staging" ? "production" : "staging"],
        ),
      /target/i,
    );
  }
  assert.throws(() => assertReleaseTarget("preview", RELEASE_TARGETS.staging), /environment/i);
});

test("selected registry digest is available and exact before any Azure change", async () => {
  const { spawnSync } = await import("node:child_process");
  const source = await readFile(
    new URL("../.github/workflows/deploy-azure-release.yml", import.meta.url),
    "utf8",
  );
  const block = source
    .split("      - name: Verify selected registry digest\n")[1]
    ?.split("      - ")[0];
  const script = block
    ?.split("        run: |\n")[1]
    ?.split("\n")
    .map((line) => line.slice(10))
    .join("\n");
  assert.ok(script);
  for (const [digest, status, expected] of [
    [image.split("@")[1], "0", 0],
    [`sha256:${"d".repeat(64)}`, "0", 1],
    ["", "1", 1],
  ]) {
    const result = spawnSync(
      "bash",
      ["-c", `docker() { printf '%s' "$REGISTRY_DIGEST"; return "$REGISTRY_STATUS"; }\n${script}`],
      {
        env: { DEPLOY_IMAGE: image, REGISTRY_DIGEST: digest, REGISTRY_STATUS: status },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, expected, result.stderr);
  }
});

test("workflow routing is staging-first, production manual-only, and shares one release lock", async () => {
  const read = (path) => readFile(new URL(`../.github/workflows/${path}`, import.meta.url), "utf8");
  const [staging, production, deploy] = await Promise.all([
    read("deploy-azure.yml"),
    read("deploy-production.yml"),
    read("deploy-azure-release.yml"),
  ]);
  assert.match(staging, /vars.AZURE_STAGING_DEPLOY_ENABLED == 'true'/);
  assert.doesNotMatch(staging, /AZURE_DEPLOY_ENABLED|environment: production/);
  assert.match(production, /^on:\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(production, /^ {2}(push|pull_request|schedule|workflow_run):/m);
  for (const source of [staging, production]) {
    assert.match(source, /github.ref == 'refs\/heads\/main'/);
    assert.match(
      source,
      /concurrency:\n {2}group: azure-production\n {2}cancel-in-progress: false/,
    );
    assert.match(source, /uses: \.\/\.github\/workflows\/deploy-azure-release.yml/);
    const deploymentJob = source.split("\n  deploy:\n")[1]?.split(/\n {2}[a-z_-]+:\n/)[0];
    assert.match(deploymentJob, /^ {4}secrets: inherit$/m);
  }
  assert.match(production, /environment: production/);
  assert.match(production, /commit: \$\{\{ needs.select.outputs.commit \}\}/);
  assert.match(production, /build_index: \$\{\{ needs.select.outputs.build_index \}\}/);
  assert.match(production, /app_version: \$\{\{ needs.select.outputs.app_version \}\}/);
  assert.doesNotMatch(
    production,
    /docker\/build-push-action|docker push|APP_BUILD_INDEX=.*github.run_number/,
  );
  assert.match(deploy, /environment: \$\{\{ inputs.environment \}\}/);
  assert.match(deploy, /EXPECTED_COMMIT: \$\{\{ inputs.commit \}\}/);
  assert.match(deploy, /EXPECTED_VERSION: \$\{\{ inputs.app_version \}\}/);
  assert.match(deploy, /--arg commit "\$EXPECTED_COMMIT" --arg version "\$expected_version"/);
  assert.doesNotMatch(deploy, /--arg commit "\$GITHUB_SHA"|process.env.GITHUB_RUN_NUMBER/);
  assert.ok(
    deploy.indexOf("name: Validate environment binding") < deploy.indexOf("uses: azure/login@"),
  );
  const digestStep = deploy.indexOf("name: Verify selected registry digest");
  assert.ok(digestStep > deploy.indexOf("name: Validate environment binding"));
  assert.ok(digestStep < deploy.indexOf("name: Select infrastructure deployment"));
  assert.match(deploy, /docker buildx imagetools inspect "\$DEPLOY_IMAGE"/);
  assert.match(deploy, /password: \$\{\{ secrets.GHCR_PULL_TOKEN \}\}/);
  assert.ok(staging.indexOf("  record:\n") > staging.indexOf("  deploy:\n"));
  assert.match(staging, /needs: \[publish, deploy\]/);
  assert.match(staging, /if-no-files-found: error/);
  assert.match(staging, /overwrite: false/);
});

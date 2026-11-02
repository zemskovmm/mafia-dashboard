/* global URL */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deploymentTarget } from "./azure-deployment-plan.mjs";
import { composeAppVersion } from "./release-verifier-contracts.mjs";

export const STAGING_WORKFLOW = ".github/workflows/deploy-azure.yml";
const REPOSITORY = "zemskovmm/mafia-dashboard";
const commonTarget = {
  subscriptionId: "9f0da8f6-9da5-4bef-9738-cb26f2a19e58",
  location: "northeurope",
  storageTableName: "MafiaEntities",
  storageContainerName: "mafia-live",
};
export const RELEASE_TARGETS = Object.freeze({
  staging: Object.freeze({
    ...commonTarget,
    resourceGroup: "rg-mafia-dashboard-staging-neu",
    namePrefix: "mafiadashboard-stg",
    storageAccountName: "mafiastg6du4xvao4bfk2",
    storagePartitionKey: "staging-v1",
  }),
  production: Object.freeze({
    ...commonTarget,
    resourceGroup: "rg-mafia-dashboard-prod-weu",
    namePrefix: "mafiadashboard",
    storageAccountName: "mafiadata6du4xvao4bfk2",
    storagePartitionKey: "production-v1",
  }),
});

const requireCondition = (condition, message) => {
  if (!condition) throw new Error(message);
};
const canonicalId = (value) =>
  typeof value === "string" && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
const sameRun = (a, b) =>
  ["id", "run_attempt", "run_number", "head_sha", "status", "conclusion"].every(
    (key) => a[key] === b[key],
  );

export function assertReleaseTarget(environment, target) {
  requireCondition(
    environment === "staging" || environment === "production",
    "Unknown release environment",
  );
  const expected = RELEASE_TARGETS[environment];
  for (const [field, value] of Object.entries(expected)) {
    requireCondition(target[field] === value, `Release target mismatch: ${environment} ${field}`);
  }
}

function assertStagingOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid staging origin");
  }
  requireCondition(
    url.origin === value &&
      /^https:\/\/mafiadashboard-stg-app\.[a-z0-9-]+\.northeurope\.azurecontainerapps\.io$/.test(
        value,
      ),
    "Invalid staging origin",
  );
}

function assertSuccessfulRun(run, repository, workflowId) {
  requireCondition(
    repository === REPOSITORY &&
      run?.repository?.full_name === repository &&
      run?.head_repository?.full_name === repository &&
      Number.isSafeInteger(run.repository.id) &&
      run.head_repository.id === run.repository.id,
    "Staging run repository mismatch",
  );
  requireCondition(
    run.path === STAGING_WORKFLOW &&
      run.workflow_id === workflowId &&
      Number.isSafeInteger(workflowId),
    "Staging workflow mismatch",
  );
  requireCondition(
    run.head_branch === "main" && ["push", "workflow_dispatch"].includes(run.event),
    "Staging run must use trusted main",
  );
  requireCondition(
    run.status === "completed" && run.conclusion === "success",
    "Staging run must be completed and successful",
  );
  requireCondition(
    [run.id, run.run_attempt, run.run_number].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ),
    "Invalid staging run identity",
  );
  requireCondition(/^[0-9a-f]{40}$/.test(run.head_sha), "Invalid staging commit");
}

function assertRecordShape(record) {
  requireCondition(
    record?.schemaVersion === 1 && record.verification === "azure-readiness-version-configuration",
    "Missing verified staging release record",
  );
  requireCondition(
    record.repository === REPOSITORY &&
      record.workflow === STAGING_WORKFLOW &&
      record.branch === "main",
    "Release record repository/workflow/branch mismatch",
  );
  requireCondition(
    [record.runId, record.runAttempt, record.buildIndex].every(canonicalId),
    "Invalid release record run/attempt/build identity",
  );
  requireCondition(
    typeof record.commit === "string" && /^[0-9a-f]{40}$/.test(record.commit),
    "Invalid release record commit",
  );
  requireCondition(
    typeof record.image === "string" &&
      record.image.startsWith(`ghcr.io/${REPOSITORY}@sha256:`) &&
      /^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+@sha256:[0-9a-f]{64}$/.test(record.image),
    "Release image must be the repository's immutable digest",
  );
  requireCondition(
    record.appVersion === composeAppVersion(record.packageVersion, record.buildIndex),
    "Release record baked version mismatch",
  );
  assertStagingOrigin(record.stagingUrl);
}

export function validateReleaseRecord(record, run, { repository, workflowId }) {
  assertSuccessfulRun(run, repository, workflowId);
  assertRecordShape(record);
  for (const [field, value] of Object.entries({
    runId: run.id,
    runAttempt: run.run_attempt,
    buildIndex: run.run_number,
  })) {
    requireCondition(record[field] === String(value), `Release record ${field} mismatch`);
  }
  requireCondition(record.commit === run.head_sha, "Release record commit mismatch");
  return Object.freeze({ ...record });
}

export function verifyArtifactDigest(bytes, digest) {
  requireCondition(
    typeof digest === "string" && /^sha256:[0-9a-f]{64}$/.test(digest),
    "Missing artifact digest",
  );
  requireCondition(
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` === digest,
    "Downloaded artifact digest mismatch",
  );
}

export async function selectStagingRelease({
  repository,
  requestedRunId = "",
  stagingUrl,
  api,
  readArtifact,
  currentIdentity,
}) {
  requireCondition(repository === REPOSITORY, "Release repository mismatch");
  requireCondition(
    requestedRunId === "" || canonicalId(requestedRunId),
    "Staging run ID must be a canonical positive safe integer",
  );
  const base = `repos/${repository}/actions`;
  const workflow = await api(`${base}/workflows/deploy-azure.yml`);
  requireCondition(
    workflow?.path === STAGING_WORKFLOW && workflow.state === "active",
    "Staging workflow unavailable",
  );
  let runId = requestedRunId;
  if (!runId) {
    assertStagingOrigin(stagingUrl);
    // Do not filter for success: the latest failed/incomplete run must block default promotion.
    const response = await api(`${base}/workflows/deploy-azure.yml/runs?branch=main&per_page=1`);
    requireCondition(response.workflow_runs?.length === 1, "No current staging run available");
    runId = String(response.workflow_runs[0].id);
    requireCondition(canonicalId(runId), "Invalid staging run ID");
  }
  const run = await api(`${base}/runs/${runId}`);
  assertSuccessfulRun(run, repository, workflow.id);
  requireCondition(String(run.id) === runId, "Staging run ID mismatch");
  const artifactName = `staging-release-${run.id}-${run.run_attempt}`;
  const response = await api(`${base}/runs/${runId}/artifacts?name=${artifactName}&per_page=100`);
  requireCondition(
    response.total_count === 1 && response.artifacts?.length === 1,
    "Exactly one staging release artifact is required",
  );
  const artifact = response.artifacts[0];
  const artifactRun = artifact.workflow_run;
  requireCondition(
    artifact.name === artifactName &&
      artifact.expired === false &&
      Number.isSafeInteger(artifact.id) &&
      artifact.id > 0 &&
      /^sha256:[0-9a-f]{64}$/.test(artifact.digest ?? "") &&
      artifactRun?.id === run.id &&
      artifactRun.repository_id === run.repository.id &&
      artifactRun.head_repository_id === run.head_repository.id &&
      artifactRun.head_sha === run.head_sha &&
      artifactRun.head_branch === "main",
    "Staging release artifact metadata mismatch or expired",
  );
  const record = validateReleaseRecord(await readArtifact(artifact), run, {
    repository,
    workflowId: workflow.id,
  });
  if (!requestedRunId) {
    requireCondition(
      record.stagingUrl === stagingUrl,
      "Release origin does not match current staging origin",
    );
    const identity = await currentIdentity(stagingUrl);
    requireCondition(
      identity?.commit === record.commit && identity?.version === record.appVersion,
      "Release does not match current staging identity",
    );
    const latest = await api(`${base}/workflows/deploy-azure.yml/runs?branch=main&per_page=1`);
    requireCondition(
      latest.workflow_runs?.length === 1 && sameRun(latest.workflow_runs[0], run),
      "Current staging run changed during selection",
    );
  }
  const currentRun = await api(`${base}/runs/${runId}`);
  assertSuccessfulRun(currentRun, repository, workflow.id);
  requireCondition(sameRun(currentRun, run), "Staging run changed during selection");
  return record;
}

const gh = (path) =>
  execFileSync("gh", ["api", "-H", "X-GitHub-Api-Version: 2022-11-28", path], {
    timeout: 60_000,
    maxBuffer: 5 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
const api = async (path) => JSON.parse(gh(path).toString("utf8"));

function readArtifact(artifact) {
  const bytes = gh(`repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip`);
  verifyArtifactDigest(bytes, artifact.digest);
  const directory = mkdtempSync(join(tmpdir(), "mafia-release-"));
  const archive = join(directory, "release.zip");
  try {
    writeFileSync(archive, bytes);
    const entries = execFileSync("unzip", ["-Z1", archive], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    requireCondition(entries === "release.json", "Unexpected staging release artifact contents");
    return JSON.parse(
      execFileSync("unzip", ["-p", archive, "release.json"], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const currentIdentity = async (origin) => {
  // Readiness failure is not permission to promote a matching stale version response.
  execFileSync(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--connect-timeout",
      "5",
      "--max-time",
      "30",
      `${origin}/health/ready`,
    ],
    { timeout: 35_000, stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(
    execFileSync(
      "curl",
      [
        "--fail",
        "--silent",
        "--show-error",
        "--connect-timeout",
        "5",
        "--max-time",
        "30",
        `${origin}/health/version`,
      ],
      { encoding: "utf8", timeout: 35_000, stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
};

async function main(command) {
  const env = process.env;
  if (command === "validate-target") {
    requireCondition(
      env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_REF === "refs/heads/main",
      "Release requires trusted repository main",
    );
    const caller =
      env.RELEASE_ENVIRONMENT === "production"
        ? ".github/workflows/deploy-production.yml"
        : STAGING_WORKFLOW;
    requireCondition(
      env.GITHUB_WORKFLOW_REF === `${REPOSITORY}/${caller}@refs/heads/main`,
      "Release caller workflow mismatch",
    );
    requireCondition(
      ["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME) &&
        (env.RELEASE_ENVIRONMENT !== "production" || env.GITHUB_EVENT_NAME === "workflow_dispatch"),
      "Production requires manual dispatch",
    );
    assertReleaseTarget(env.RELEASE_ENVIRONMENT, deploymentTarget());
    requireCondition(
      /^[0-9a-f]{40}$/.test(env.EXPECTED_COMMIT ?? "") && canonicalId(env.APP_BUILD_INDEX),
      "Invalid selected release commit/build index",
    );
    requireCondition(
      typeof env.EXPECTED_VERSION === "string" &&
        /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.[1-9][0-9]*$/.test(env.EXPECTED_VERSION) &&
        env.EXPECTED_VERSION.split(".")[2] === env.APP_BUILD_INDEX,
      "Invalid selected release version",
    );
    requireCondition(
      env.RELEASE_ENVIRONMENT !== "production" || env.INITIALIZE_STORAGE === "false",
      "Production promotion cannot initialize Storage",
    );
  } else if (command === "record") {
    const { version } = JSON.parse(readFileSync("package.json", "utf8"));
    const record = {
      schemaVersion: 1,
      repository: env.GITHUB_REPOSITORY,
      workflow: STAGING_WORKFLOW,
      branch: "main",
      runId: env.GITHUB_RUN_ID,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
      buildIndex: env.GITHUB_RUN_NUMBER,
      commit: env.GITHUB_SHA,
      image: env.DEPLOY_IMAGE,
      packageVersion: version,
      appVersion: composeAppVersion(version, env.GITHUB_RUN_NUMBER),
      stagingUrl: env.STAGING_APP_URL,
      verification: "azure-readiness-version-configuration",
    };
    // The caller runs this job only after deployment readback passed. GitHub's
    // completed run status is checked independently during promotion.
    assertRecordShape(record);
    writeFileSync(join(env.RUNNER_TEMP, "release.json"), `${JSON.stringify(record, null, 2)}\n`);
  } else if (command === "select") {
    const record = await selectStagingRelease({
      repository: env.GITHUB_REPOSITORY,
      requestedRunId: env.STAGING_RUN_ID ?? "",
      stagingUrl: env.STAGING_APP_URL,
      api,
      readArtifact,
      currentIdentity,
    });
    appendFileSync(
      env.GITHUB_OUTPUT,
      `image=${record.image}\ncommit=${record.commit}\nbuild_index=${record.buildIndex}\napp_version=${record.appVersion}\nrun_id=${record.runId}\nrun_attempt=${record.runAttempt}\n`,
    );
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `### Selected verified staging release\n- Staging run: ${record.runId} (attempt ${record.runAttempt})\n- Commit: \`${record.commit}\`\n- Version: \`${record.appVersion}\`\n- Image: \`${record.image}\`\n\nSelection is frozen; production uses its own configuration and data.\n`,
    );
  } else {
    throw new Error("Expected validate-target, record or select command");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

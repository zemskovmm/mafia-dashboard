import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

const scope =
  "/subscriptions/9f0da8f6-9da5-4bef-9738-cb26f2a19e58/resourceGroups/rg-mafia-dashboard-prod-weu";
export const target = Object.freeze({
  group: "rg-mafia-dashboard-prod-weu",
  app: "mafiadashboard-app",
  revision: "mafiadashboard-app--0000091",
  environmentId: `${scope}/providers/Microsoft.App/managedEnvironments/mafiadashboard-env`,
  identityId: `${scope}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/mafiadashboard-storage`,
  image:
    "ghcr.io/zemskovmm/mafia-dashboard@sha256:ad0692a29dc6fce90ce8d0ff6e05467a0f30233129e4b0e97c5b55e464fcc1d6",
});

export function buildJob(input, runtime) {
  validateInput(input);
  const secrets = [{ name: "registry-token", value: input.registryToken }];
  const env = [
    { name: "MIGRATION_MODE", value: input.mode },
    { name: "MIGRATION_ARCHIVE", value: input.archive },
  ];
  if (input.mode === "apply") env.push({ name: "MIGRATION_SHA256", value: input.sha256 });
  if (input.mode === "export") {
    secrets.push({ name: "postgres-password", value: input.postgresPassword });
    env.push({ name: "POSTGRES_PASSWORD", secretRef: "postgres-password" });
  }
  const bootstrap = `const fs=require('node:fs');const {spawnSync}=require('node:child_process');const p='/app/apps/server/.AI/migration-runtime.mjs';fs.mkdirSync('/app/apps/server/.AI',{recursive:true,mode:0o700});fs.writeFileSync(p,Buffer.from('${Buffer.from(runtime).toString("base64")}','base64'),{mode:0o600,flag:'wx'});process.exit(spawnSync(process.execPath,[p],{stdio:'inherit',cwd:'/app/apps/server'}).status??1);`;
  return {
    location: "northeurope",
    tags: { purpose: "one-time-postgres-import", run: input.runId, archive: input.archive },
    identity: { type: "UserAssigned", userAssignedIdentities: { [target.identityId]: {} } },
    properties: {
      environmentId: target.environmentId,
      workloadProfileName: "Consumption",
      configuration: {
        triggerType: "Manual",
        replicaTimeout: 1800,
        replicaRetryLimit: 0,
        manualTriggerConfig: { replicaCompletionCount: 1, parallelism: 1 },
        secrets,
        registries: [
          { server: "ghcr.io", username: input.registryUser, passwordSecretRef: "registry-token" },
        ],
      },
      template: {
        containers: [
          {
            name: "migration",
            image: target.image,
            command: ["node"],
            args: ["-e", bootstrap],
            env,
            resources: { cpu: 1, memory: "2Gi" },
          },
        ],
      },
    },
  };
}

export function validateInput(input) {
  if (
    !["export", "apply"].includes(input.mode) ||
    !/^migration-[a-f0-9]{32}$/.test(input.archive) ||
    !/^[0-9]{1,12}$/.test(input.runId) ||
    !/^[0-9]{1,3}$/.test(input.attempt) ||
    !input.registryUser ||
    !input.registryToken ||
    (input.mode === "export" && (!input.postgresPassword || input.sha256 !== "")) ||
    (input.mode === "apply" && !/^[a-f0-9]{64}$/.test(input.sha256))
  )
    throw new Error("Invalid migration input");
}

export function assertLiveTarget(app, revisions, mode) {
  const active = revisions.filter((revision) => revision.properties.active);
  if (
    app.properties.managedEnvironmentId.toLowerCase() !== target.environmentId.toLowerCase() ||
    app.properties.latestReadyRevisionName !== target.revision ||
    app.properties.template.containers.length !== 1 ||
    app.properties.template.containers[0].image !== target.image ||
    (mode === "apply"
      ? active.length !== 0
      : active.length !== 1 ||
        active[0].name !== target.revision ||
        active[0].properties.template.containers[0].image !== target.image)
  )
    throw new Error("Live target or active-writer mismatch");
}

function azure(args, json = true) {
  try {
    const output = execFileSync("az", [...args, "--only-show-errors"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return json ? JSON.parse(output || "null") : output;
  } catch {
    throw new Error("Azure command failed; raw output suppressed");
  }
}

function assertJob(actual, expected) {
  const config = actual.properties.configuration;
  const container = actual.properties.template.containers[0];
  const intended = expected.properties.template.containers[0];
  if (
    actual.properties.environmentId.toLowerCase() !== target.environmentId.toLowerCase() ||
    !Object.keys(actual.identity.userAssignedIdentities).some(
      (id) => id.toLowerCase() === target.identityId.toLowerCase(),
    ) ||
    config.triggerType !== "Manual" ||
    config.replicaRetryLimit !== 0 ||
    config.replicaTimeout !== 1800 ||
    config.manualTriggerConfig.parallelism !== 1 ||
    config.manualTriggerConfig.replicaCompletionCount !== 1 ||
    actual.properties.template.containers.length !== 1 ||
    container.image !== target.image ||
    !isDeepStrictEqual(container.command, intended.command) ||
    !isDeepStrictEqual(container.args, intended.args) ||
    !isDeepStrictEqual(container.env, intended.env)
  )
    throw new Error("Job readback mismatch");
}

function forwardResult(output, log) {
  for (const line of output.split("\n")) {
    const offset = line.indexOf("MIGRATION_RESULT ");
    if (offset < 0) continue;
    try {
      const result = JSON.parse(line.slice(offset + "MIGRATION_RESULT ".length));
      if (!/^[a-f0-9]{64}$/.test(result.sha256)) continue;
      const safe = { sha256: result.sha256 };
      if (["export", "apply"].includes(result.mode)) safe.mode = result.mode;
      for (const key of ["entityCount", "blobCount"]) {
        if (Number.isSafeInteger(result[key]) && result[key] >= 0) safe[key] = result[key];
      }
      log(`MIGRATION_RESULT ${JSON.stringify(safe)}`);
    } catch {
      /* Ignore non-result and malformed log lines, never relay raw output. */
    }
  }
}

export async function runMigration(
  input,
  { az = azure, runtime, wait = pause, log = console.log } = {},
) {
  validateInput(input);
  if (!runtime) throw new Error("Missing reviewed runtime");
  const jobName = `mafia-migrate-${input.runId}-${input.attempt}`;
  const cliScope = ["-g", target.group, "--subscription", "9f0da8f6-9da5-4bef-9738-cb26f2a19e58"];
  const app = await az(["containerapp", "show", "-n", target.app, ...cliScope, "-o", "json"]);
  const revisions = await az([
    "containerapp",
    "revision",
    "list",
    "-n",
    target.app,
    ...cliScope,
    "-o",
    "json",
  ]);
  assertLiveTarget(app, revisions, input.mode);
  const jobs = await az(["containerapp", "job", "list", ...cliScope, "-o", "json"]);
  if (jobs.some((job) => job.name === jobName))
    throw new Error("Job name already exists; never overwrite");
  const body = buildJob(input, runtime);
  const url = `https://management.azure.com${scope}/providers/Microsoft.App/jobs/${jobName}?api-version=2025-01-01`;
  await mkdir(resolve(".AI"), { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(resolve(".AI/production-migration-request-"));
  try {
    const request = resolve(directory, "request.json");
    await writeFile(request, JSON.stringify(body), { mode: 0o600, flag: "wx" });
    await az(["rest", "--method", "put", "--url", url, "--body", `@${request}`, "-o", "json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const job = await az(["rest", "--method", "get", "--url", url, "-o", "json"]);
    if (job.properties.provisioningState === "Succeeded") {
      assertJob(job, body);
      ready = true;
      break;
    }
    if (["Failed", "Canceled"].includes(job.properties.provisioningState))
      throw new Error("Job provisioning failed");
    await wait(5000);
  }
  if (!ready) throw new Error("Job provisioning timed out");
  // Do not retry Start: an ambiguous response may already have launched the job.
  const execution = await az([
    "containerapp",
    "job",
    "start",
    "-n",
    jobName,
    ...cliScope,
    "-o",
    "json",
  ]);
  if (!/^[a-z0-9-]{1,80}$/.test(execution?.name)) throw new Error("Invalid execution response");
  log(
    `MIGRATION_JOB ${JSON.stringify({ jobName, execution: execution.name, mode: input.mode, archive: input.archive })}`,
  );
  for (let attempt = 0; attempt < 190; attempt++) {
    const executions = await az([
      "containerapp",
      "job",
      "execution",
      "list",
      "-n",
      jobName,
      ...cliScope,
      "-o",
      "json",
    ]);
    const status = executions.find((entry) => entry.name === execution.name)?.properties.status;
    if (["Succeeded", "Failed", "Stopped", "Degraded"].includes(status)) {
      try {
        const logs = await az(
          [
            "containerapp",
            "job",
            "logs",
            "show",
            "-n",
            jobName,
            ...cliScope,
            "--execution",
            execution.name,
            "--container",
            "migration",
            "--format",
            "text",
            "--tail",
            "50",
          ],
          false,
        );
        forwardResult(logs, log);
      } catch {
        log("Runtime logs unavailable; retained archive receipt is authoritative.");
      }
      const result = { jobName, execution: execution.name, status };
      log(`MIGRATION_EXECUTION ${JSON.stringify(result)}`);
      if (status !== "Succeeded")
        throw new Error("Migration execution did not succeed; retained state requires inspection");
      return result;
    }
    await wait(10_000);
  }
  throw new Error("Execution wait timed out; inspect exact job before any retry");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (
      process.env.GITHUB_REPOSITORY !== "zemskovmm/mafia-dashboard" ||
      process.env.GITHUB_REF !== "refs/heads/main" ||
      process.env.GITHUB_EVENT_NAME !== "workflow_dispatch"
    )
      throw new Error("Manual trusted main workflow required");
    await runMigration(
      {
        mode: process.env.MIGRATION_MODE,
        archive: process.env.MIGRATION_ARCHIVE,
        sha256: process.env.MIGRATION_SHA256 ?? "",
        runId: process.env.GITHUB_RUN_ID,
        attempt: process.env.GITHUB_RUN_ATTEMPT,
        registryUser: process.env.GHCR_USERNAME,
        registryToken: process.env.GHCR_TOKEN,
        postgresPassword: process.env.POSTGRES_PASSWORD,
      },
      {
        runtime: await readFile(
          new URL("./production-postgres-migration-runtime.mjs", import.meta.url),
          "utf8",
        ),
      },
    );
  } catch {
    console.error(
      "MIGRATION_CONTROLLER_FAILED: inspect exact job and retained archive; do not blindly rerun.",
    );
    process.exitCode = 1;
  }
}

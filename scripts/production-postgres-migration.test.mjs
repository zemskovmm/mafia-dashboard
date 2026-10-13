import assert from "node:assert/strict";
import test from "node:test";
import { readFile, stat } from "node:fs/promises";
import { URL } from "node:url";

const load = () => import("./production-postgres-migration.mjs");
const input = {
  mode: "export",
  archive: `migration-${"a".repeat(32)}`,
  sha256: "",
  runId: "12345678901",
  attempt: "1",
  registryUser: "fixture-user",
  registryToken: "registry-secret-sentinel",
  postgresPassword: "postgres-secret-sentinel",
};

test("production job binds the approved image and identity without exposing secrets in argv", async () => {
  const { buildJob, target } = await load();
  const job = buildJob(input, "console.log('fixture-runtime');");
  const config = job.properties.configuration;
  const container = job.properties.template.containers[0];
  assert.equal(job.properties.environmentId, target.environmentId);
  assert.deepEqual(Object.keys(job.identity.userAssignedIdentities), [target.identityId]);
  assert.equal(config.triggerType, "Manual");
  assert.equal(config.replicaRetryLimit, 0);
  assert.equal(config.replicaTimeout, 1800);
  assert.deepEqual(config.manualTriggerConfig, { replicaCompletionCount: 1, parallelism: 1 });
  assert.equal(container.image, target.image);
  assert.equal(
    container.env.some((entry) => entry.name === "MIGRATION_SHA256"),
    false,
  );
  assert.equal(
    container.env.find((entry) => entry.name === "POSTGRES_PASSWORD").secretRef,
    "postgres-password",
  );
  assert.equal(
    config.secrets.find((entry) => entry.name === "postgres-password").value,
    input.postgresPassword,
  );
  for (const secret of [input.registryToken, input.postgresPassword]) {
    assert.equal(JSON.stringify(container).includes(secret), false);
  }
  assert.equal(job.properties.template.initContainers, undefined);
});

test("apply requires an exact manifest hash and never carries SQL credentials", async () => {
  const { buildJob, validateInput } = await load();
  assert.throws(() => validateInput({ ...input, mode: "apply" }), /Invalid migration input/);
  assert.throws(
    () => validateInput({ ...input, archive: "mafia-live" }),
    /Invalid migration input/,
  );
  assert.throws(() => validateInput({ ...input, runId: "../unsafe" }), /Invalid migration input/);
  assert.throws(
    () => validateInput({ ...input, mode: "export", sha256: "a".repeat(64) }),
    /Invalid migration input/,
  );
  const apply = { ...input, mode: "apply", sha256: "b".repeat(64) };
  validateInput(apply);
  const job = buildJob(apply, "fixture");
  assert.equal(JSON.stringify(job).includes(input.postgresPassword), false);
  assert.equal(
    job.properties.template.containers[0].env.some((entry) => entry.name === "POSTGRES_PASSWORD"),
    false,
  );
});

test("live target or active-writer drift refuses before job creation", async () => {
  const { assertLiveTarget, target } = await load();
  const app = {
    properties: {
      managedEnvironmentId: target.environmentId,
      latestReadyRevisionName: target.revision,
      template: { containers: [{ image: target.image }] },
    },
  };
  const revision = {
    name: target.revision,
    properties: { active: true, template: { containers: [{ image: target.image }] } },
  };
  assertLiveTarget(app, [revision], "export");
  assertLiveTarget(
    app,
    [{ ...revision, properties: { ...revision.properties, active: false } }],
    "apply",
  );
  assert.throws(() => assertLiveTarget(app, [revision], "apply"), /Live target/);
  assert.throws(() => assertLiveTarget(app, [], "export"), /Live target/);
  assert.throws(
    () =>
      assertLiveTarget(
        {
          properties: {
            ...app.properties,
            template: { containers: [{ image: "foreign:latest" }] },
          },
        },
        [revision],
        "export",
      ),
    /Live target/,
  );
});

test("controller verifies the written job before starting exactly one execution", async () => {
  const { runMigration, target } = await load();
  let body;
  let starts = 0;
  let requestPath;
  const az = async (args) => {
    if (args[0] === "rest") {
      const method = args[args.indexOf("--method") + 1];
      if (method === "put") {
        requestPath = args[args.indexOf("--body") + 1].slice(1);
        assert.equal((await stat(requestPath)).mode & 0o777, 0o600);
        body = JSON.parse(await readFile(requestPath, "utf8"));
        return {};
      }
      if (method === "get")
        return { ...body, properties: { ...body.properties, provisioningState: "Succeeded" } };
    }
    if (args[1] === "show")
      return {
        properties: {
          managedEnvironmentId: target.environmentId,
          latestReadyRevisionName: target.revision,
          template: { containers: [{ image: target.image }] },
        },
      };
    if (args[1] === "revision")
      return [
        {
          name: target.revision,
          properties: { active: true, template: { containers: [{ image: target.image }] } },
        },
      ];
    if (args[2] === "list") return [];
    if (args[2] === "start") {
      starts++;
      return { name: "migration-execution-1" };
    }
    if (args[2] === "execution")
      return [{ name: "migration-execution-1", properties: { status: "Succeeded" } }];
    if (args[2] === "logs") throw new Error("secret-sentinel raw remote error");
    throw new Error("Unexpected command");
  };
  const logs = [];
  const result = await runMigration(input, {
    az,
    runtime: "fixture",
    wait: async () => {},
    log: (line) => logs.push(line),
  });
  assert.equal(result.status, "Succeeded");
  assert.equal(starts, 1);
  assert.equal(logs.join("\n").includes("secret-sentinel"), false);
  await assert.rejects(stat(requestPath), { code: "ENOENT" });
});

test("workflow is manual-only, serialized with deployment, and main-only", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/migrate-postgres-to-azure.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n {2}(push|pull_request|schedule):/);
  assert.match(workflow, /group: azure-production/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /node scripts\/production-postgres-migration.mjs/);
  assert.doesNotMatch(workflow, /upload-artifact|ACTIONS_STEP_DEBUG|set -x/);
});

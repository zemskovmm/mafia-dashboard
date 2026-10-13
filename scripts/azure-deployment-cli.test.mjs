import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function workflowRun(name) {
  const source = readFileSync(".github/workflows/deploy-azure.yml", "utf8");
  const step = source.split(`      - name: ${name}\n`)[1]?.split("      - ")[0];
  assert.ok(step, `missing workflow step ${name}`);
  const run = step.split("        run: |\n")[1];
  assert.ok(run, `missing literal run block ${name}`);
  return run
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
}

test("workflow retains publication hold/digest identity and routes explicit Storage parameters without SQL", () => {
  const source = readFileSync(".github/workflows/deploy-azure.yml", "utf8");
  assert.match(source, /vars\.AZURE_DEPLOY_ENABLED == 'true'/);
  assert.match(source, /github\.event_name == 'workflow_dispatch' && inputs\.deploy/);
  assert.match(source, /cancel-in-progress: false/);
  assert.match(source, /initialize_storage:[\s\S]*?type: boolean\n\s+default: false/);
  assert.match(
    source,
    /INITIALIZE_STORAGE: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.initialize_storage == true \}\}/,
  );
  assert.doesNotMatch(
    source,
    /AZURE_DATABASE_NAME|POSTGRES_PASSWORD|postgresPassword|databaseName=|--container migrate/,
  );
  for (const name of [
    "AZURE_STORAGE_ACCOUNT_NAME",
    "AZURE_STORAGE_TABLE_NAME",
    "AZURE_STORAGE_CONTAINER_NAME",
    "AZURE_STORAGE_PARTITION_KEY",
  ])
    assert.ok(source.includes(`${name}: \${{ vars.${name} }}`), name);
  assert.match(source, /storagePartitionKey="\$AZURE_STORAGE_PARTITION_KEY"/);
  assert.match(source, /initializeStorage="\$INITIALIZE_STORAGE"/);
  assert.match(source, /--container initialize-storage/);
  assert.match(source, /--mode Incremental/);
  assert.doesNotMatch(source, /--mode Complete/);
  assert.match(source, /node scripts\/azure-deployment-plan\.mjs/);
  assert.match(source, /\/health\/ready/);
  assert.match(source, /\/health\/version/);
  assert.match(source, /\.version == \$version and \.commit == \$commit/);
});

test("workflow input validation executes Storage/digest guards before any Azure side effect", () => {
  const script = workflowRun("Validate deployment inputs");
  const env = {
    ...process.env,
    AZURE_SUBSCRIPTION_ID: "sub",
    AZURE_RESOURCE_GROUP: "group",
    AZURE_LOCATION: "northeurope",
    AZURE_NAME_PREFIX: "app",
    AZURE_STORAGE_ACCOUNT_NAME: "appstorage",
    AZURE_STORAGE_TABLE_NAME: "MafiaEntities",
    AZURE_STORAGE_CONTAINER_NAME: "mafia-live",
    AZURE_STORAGE_PARTITION_KEY: "production-v1",
    GHCR_USERNAME: "fixture",
    GHCR_TOKEN: "test-only-fixture",
    DEPLOY_IMAGE: `ghcr.io/owner/app@sha256:${"a".repeat(64)}`,
    INITIALIZE_STORAGE: "false",
  };
  const run = (extra) =>
    spawnSync("bash", ["-c", script], { env: { ...env, ...extra }, encoding: "utf8" });
  assert.equal(run({}).status, 0, run({}).stderr);
  for (const extra of [
    { AZURE_STORAGE_ACCOUNT_NAME: "" },
    { AZURE_STORAGE_PARTITION_KEY: "bad/value" },
    { DEPLOY_IMAGE: "ghcr.io/owner/app:latest" },
    { INITIALIZE_STORAGE: "reset" },
  ])
    assert.notEqual(run(extra).status, 0, JSON.stringify(extra));
});

test("foundation what-if gate rejects deletions and retained resource writes", () => {
  const script = workflowRun("Inspect foundation changes");
  const directory = mkdtempSync(join(tmpdir(), "mafia-foundation-what-if-"));
  const env = {
    ...process.env,
    RUNNER_TEMP: directory,
    AZURE_RESOURCE_GROUP: "group",
    AZURE_LOCATION: "northeurope",
    AZURE_NAME_PREFIX: "app",
    AZURE_STORAGE_ACCOUNT_NAME: "appstorage",
    AZURE_STORAGE_TABLE_NAME: "MafiaEntities",
    AZURE_STORAGE_CONTAINER_NAME: "mafia-live",
    FOUNDATION_FINGERPRINT: "a".repeat(64),
  };
  const run = (changes) => {
    const fixture = JSON.stringify({ status: "Succeeded", changes });
    return spawnSync("bash", ["-c", `az() { printf '%s\\n' '${fixture}'; }\n${script}`], {
      env,
      encoding: "utf8",
    });
  };
  const change = (type, changeType) => ({
    resourceId: `/subscriptions/sub/resourceGroups/group/providers/${type}/fixture`,
    changeType,
  });
  try {
    const safe = run([
      change("Microsoft.Storage/storageAccounts", "Create"),
      change("Microsoft.ManagedIdentity/userAssignedIdentities", "NoChange"),
    ]);
    assert.equal(safe.status, 0, safe.stderr);
    for (const changes of [
      [change("Microsoft.Storage/storageAccounts", "Delete")],
      [change("Microsoft.Network/virtualNetworks", "Modify")],
      [change("Microsoft.DBforPostgreSQL/flexibleServers", "Modify")],
      [change("Microsoft.App/managedEnvironments", "Create")],
    ])
      assert.notEqual(run(changes).status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workflow release readback rejects SQL/provider/identity/namespace drift before public health checks", async () => {
  const script = workflowRun("Verify Azure deployment").replaceAll(
    "${{ steps.app.outputs.public_url }}",
    "https://fixture.invalid",
  );
  const { composeAppVersion } = await import("./release-verifier-contracts.mjs");
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  const image = `ghcr.io/owner/app@sha256:${"a".repeat(64)}`;
  const fields = {
    STORAGE_PROVIDER: "azure",
    AZURE_STORAGE_ACCOUNT_NAME: "appstorage",
    AZURE_STORAGE_TABLE_NAME: "MafiaEntities",
    AZURE_STORAGE_CONTAINER_NAME: "mafia-live",
    AZURE_STORAGE_PARTITION_KEY: "production-v1",
    AZURE_CLIENT_ID: "identity-client",
    AZURE_STORAGE_INITIALIZE: "false",
  };
  const config = {
    provisioningState: "Succeeded",
    minReplicas: 1,
    maxReplicas: 1,
    targetPort: 3000,
    image,
    initImage: image,
    identity: {
      type: "UserAssigned",
      userAssignedIdentities: {
        "/subscriptions/sub/resourceGroups/group/providers/Microsoft.ManagedIdentity/userAssignedIdentities/app-storage":
          { clientId: "identity-client" },
      },
    },
    env: Object.entries(fields).map(([name, value]) => ({ name, value })),
    initEnv: Object.entries(fields).map(([name, value]) => ({ name, value })),
  };
  const env = {
    ...process.env,
    AZURE_SUBSCRIPTION_ID: "sub",
    AZURE_RESOURCE_GROUP: "group",
    AZURE_NAME_PREFIX: "app",
    AZURE_STORAGE_ACCOUNT_NAME: "appstorage",
    AZURE_STORAGE_TABLE_NAME: "MafiaEntities",
    AZURE_STORAGE_CONTAINER_NAME: "mafia-live",
    AZURE_STORAGE_PARTITION_KEY: "production-v1",
    INITIALIZE_STORAGE: "false",
    DEPLOY_IMAGE: image,
    APP_NAME: "app-app",
    GITHUB_SHA: "fixture-commit",
    GITHUB_RUN_NUMBER: "17",
    RELEASE_FIXTURE: JSON.stringify({
      commit: "fixture-commit",
      version: composeAppVersion(version, "17"),
    }),
  };
  const run = (fixture) =>
    spawnSync(
      "bash",
      [
        "-c",
        `az() { printf '%s\\n' "$CONFIG_FIXTURE"; }\ncurl() { printf '%s\\n' "$RELEASE_FIXTURE"; }\n${script}`,
      ],
      { env: { ...env, CONFIG_FIXTURE: JSON.stringify(fixture) }, encoding: "utf8" },
    );
  const healthy = run(config);
  assert.equal(healthy.status, 0, healthy.stderr);
  for (const fixture of [
    { ...config, provisioningState: "Failed" },
    { ...config, minReplicas: 0 },
    { ...config, maxReplicas: 2 },
    { ...config, targetPort: 80 },
    { ...config, initImage: `${image}-wrong` },
    { ...config, identity: { type: "None" } },
    {
      ...config,
      env: config.env.map((item) =>
        item.name === "STORAGE_PROVIDER" ? { ...item, value: "postgres" } : item,
      ),
    },
    {
      ...config,
      env: config.env.map((item) =>
        item.name === "AZURE_STORAGE_ACCOUNT_NAME" ? { ...item, value: "unknownstorage" } : item,
      ),
    },
    { ...config, env: [...config.env, { name: "DATABASE_URL", secretRef: "database-url" }] },
    {
      ...config,
      env: config.env.map((item) =>
        item.name === "AZURE_CLIENT_ID" ? { ...item, value: "wrong-client" } : item,
      ),
    },
  ])
    assert.notEqual(run(fixture).status, 0);
});

test("selection CLI emits safe outputs and fails closed on Azure errors", () => {
  const directory = mkdtempSync(join(tmpdir(), "mafia-azure-cli-"));
  const output = join(directory, "outputs");
  const resources = [
    ["Microsoft.Storage/storageAccounts/appstorage", "2025-01-01"],
    ["Microsoft.Storage/storageAccounts/appstorage/blobServices/default", "2025-01-01"],
    [
      "Microsoft.Storage/storageAccounts/appstorage/blobServices/default/containers/mafia-live",
      "2025-01-01",
    ],
    ["Microsoft.Storage/storageAccounts/appstorage/tableServices/default", "2025-01-01"],
    [
      "Microsoft.Storage/storageAccounts/appstorage/tableServices/default/tables/MafiaEntities",
      "2025-01-01",
    ],
    ["Microsoft.ManagedIdentity/userAssignedIdentities/app-storage", "2023-01-31"],
    [
      "Microsoft.Storage/storageAccounts/appstorage/providers/Microsoft.Authorization/roleAssignments/blob-role",
      "2022-04-01",
    ],
    [
      "Microsoft.Storage/storageAccounts/appstorage/providers/Microsoft.Authorization/roleAssignments/table-role",
      "2022-04-01",
    ],
  ].map(([path, version]) => [
    `/subscriptions/sub/resourceGroups/group/providers/${path}`,
    version,
  ]);
  const calls = join(directory, "calls");
  const env = {
    PATH: `${directory}:${process.env.PATH}`,
    AZURE_SUBSCRIPTION_ID: "sub",
    AZURE_RESOURCE_GROUP: "group",
    AZURE_LOCATION: "northeurope",
    AZURE_NAME_PREFIX: "app",
    AZURE_STORAGE_ACCOUNT_NAME: "appstorage",
    AZURE_STORAGE_TABLE_NAME: "MafiaEntities",
    AZURE_STORAGE_CONTAINER_NAME: "mafia-live",
    AZURE_STORAGE_PARTITION_KEY: "production-v1",
    GITHUB_OUTPUT: output,
  };
  const run = (fixture, extra = {}) => {
    writeFileSync(join(directory, "az"), `#!${process.execPath}\n${fixture}\n`, { mode: 0o700 });
    writeFileSync(output, "");
    return spawnSync(process.execPath, ["scripts/azure-deployment-plan.mjs"], {
      env: { ...env, ...extra },
      encoding: "utf8",
    });
  };
  const outputs = () =>
    Object.fromEntries(
      readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
  try {
    const missing = run(
      'process.stderr.write("ERROR: (DeploymentNotFound) fixture\\n"); process.exit(3);',
    );
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(outputs().deploy, "true");
    assert.equal(outputs().storage_account_name, "appstorage");
    assert.equal(outputs().storage_table_name, "MafiaEntities");
    assert.equal(outputs().storage_container_name, "mafia-live");
    assert.equal(outputs().storage_partition_key, "production-v1");
    assert.equal(outputs().database_name, undefined);
    assert.equal(outputs().app_name, "app-app");
    const fingerprint = outputs().fingerprint;
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    const record = {
      provisioningState: "Succeeded",
      outputs: {
        foundationFingerprint: { value: fingerprint },
        containerAppName: { value: "app-app" },
        storageAccountName: { value: "appstorage" },
        storageTableName: { value: "MafiaEntities" },
        storageContainerName: { value: "mafia-live" },
        environmentName: { value: "app-env" },
        resourceIds: { value: resources.map(([id]) => id) },
      },
    };
    const success = `
      const args = process.argv.slice(2);
      if (args[0] === "deployment") {
        process.stdout.write(JSON.stringify(${JSON.stringify(record)}));
      } else {
        const id = args[args.indexOf("--ids") + 1];
        const versions = new Map(${JSON.stringify(resources)});
        const versionIndex = args.indexOf("--api-version");
        if (versionIndex < 0 || args[versionIndex + 1] !== versions.get(id)) {
          process.stderr.write("ERROR: (NoRegisteredProviderFound) unsupported API version fixture");
          process.exit(1);
        }
        require("node:fs").appendFileSync(${JSON.stringify(calls)}, id + "\\n");
        process.stdout.write(JSON.stringify(id));
      }
    `;
    const selected = run(success);
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(outputs().deploy, "false");
    assert.deepEqual(
      readFileSync(calls, "utf8").trim().split("\n"),
      resources.map(([id]) => id),
    );
    assert.equal(
      run('throw new Error("force must not query Azure")', { DEPLOY_INFRASTRUCTURE: "true" })
        .status,
      0,
    );
    assert.equal(outputs().reason, "manual override");
    for (const fixture of [
      'process.stderr.write("ERROR: (AuthorizationFailed) fixture\\n"); process.exit(1);',
      'process.stderr.write("network fixture\\n"); process.exit(1);',
      'process.stdout.write("invalid JSON");',
      'process.stdout.write("null");',
    ]) {
      assert.notEqual(run(fixture).status, 0);
      assert.equal(
        readFileSync(output, "utf8"),
        "",
        "failed lookups must not emit deployment outputs",
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

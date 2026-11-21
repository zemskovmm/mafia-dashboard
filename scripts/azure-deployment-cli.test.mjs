import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("routine production deployment only updates the image of the existing app", () => {
  const source = readFileSync(".github/workflows/deploy-azure-release.yml", "utf8");
  const caller = readFileSync(".github/workflows/deploy-production.yml", "utf8");
  assert.match(caller, /group: azure-production\n {2}cancel-in-progress: false/);
  assert.match(source, /^ {4}environment: production$/m);
  assert.match(source, /node scripts\/azure-release\.mjs deploy/);
  assert.doesNotMatch(
    source + caller,
    /deploy_infrastructure|initialize_storage|--template-file|node scripts\/azure-deployment-plan\.mjs/,
  );
  for (const name of [
    "AZURE_STORAGE_ACCOUNT_NAME",
    "AZURE_STORAGE_TABLE_NAME",
    "AZURE_STORAGE_CONTAINER_NAME",
    "AZURE_STORAGE_PARTITION_KEY",
  ])
    assert.ok(source.includes(`${name}: \${{ vars.${name} }}`), name);
});

test("standalone foundation what-if gate rejects deletions and retained resource writes", () => {
  const directory = mkdtempSync(join(tmpdir(), "mafia-foundation-what-if-"));
  const file = join(directory, "what-if.json");
  const env = {
    AZURE_SUBSCRIPTION_ID: "sub",
    AZURE_RESOURCE_GROUP: "group",
    AZURE_LOCATION: "northeurope",
    AZURE_NAME_PREFIX: "app",
    AZURE_STORAGE_ACCOUNT_NAME: "appstorage",
    AZURE_STORAGE_TABLE_NAME: "MafiaEntities",
    AZURE_STORAGE_CONTAINER_NAME: "mafia-live",
    AZURE_STORAGE_PARTITION_KEY: "production-v1",
    // This check consumes only the local result; it must not call Azure CLI.
    PATH: directory,
  };
  const run = (result) => {
    writeFileSync(file, JSON.stringify(result));
    return spawnSync(
      process.execPath,
      ["scripts/azure-deployment-plan.mjs", "--check-foundation-what-if", file],
      { env, encoding: "utf8" },
    );
  };
  const change = (resource, changeType) => ({
    resourceId: `/subscriptions/sub/resourceGroups/group/providers/${resource}`,
    changeType,
  });
  const account = "Microsoft.Storage/storageAccounts/appstorage";
  try {
    const safe = run({
      status: "Succeeded",
      changes: [
        change(account, "Create"),
        change(`${account}/tableServices/default/tables/MafiaEntities`, "Modify"),
        change("Microsoft.ManagedIdentity/userAssignedIdentities/app-storage", "Create"),
        change(
          `${account}/providers/Microsoft.Authorization/roleAssignments/00000000-0000-0000-0000-000000000001`,
          "Create",
        ),
        change("Microsoft.Network/virtualNetworks/retained", "Ignore"),
      ],
    });
    assert.equal(safe.status, 0, safe.stderr);
    for (const changes of [
      [change(account, "Delete")],
      [change(account, "Unsupported")],
      [change("Microsoft.Storage/storageAccounts/other", "Modify")],
      [change(`${account}/tableServices/default/tables/OtherTable`, "Modify")],
      [
        change(
          "Microsoft.Authorization/roleAssignments/00000000-0000-0000-0000-000000000001",
          "Create",
        ),
      ],
      [change("Microsoft.Network/virtualNetworks/retained", "Modify")],
      [change("Microsoft.DBforPostgreSQL/flexibleServers/retained", "Modify")],
      [change("Microsoft.App/managedEnvironments/retained", "Create")],
      [
        {
          resourceId: `/subscriptions/sub/resourceGroups/other/providers/${account}`,
          changeType: "Create",
        },
      ],
    ]) {
      const refused = run({ status: "Succeeded", changes });
      assert.equal(refused.status, 1, JSON.stringify(changes));
      assert.match(refused.stderr, /Foundation what-if includes/);
    }
    for (const result of [{ status: "Failed", changes: [] }, { status: "Succeeded" }]) {
      const refused = run(result);
      assert.equal(refused.status, 1, JSON.stringify(result));
      assert.match(refused.stderr, /did not return a successful change list/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

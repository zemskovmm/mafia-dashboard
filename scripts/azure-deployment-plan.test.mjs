/* global URL */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { foundationFingerprint, selectFoundation } from "./azure-deployment-plan.mjs";

const target = {
  subscriptionId: "test-subscription",
  resourceGroup: "test-group",
  location: "northeurope",
  namePrefix: "testapp",
  databaseName: "mafia_current",
};
const resourceId = `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}/providers/Microsoft.App/managedEnvironments/testapp-env`;
const fingerprint = "a".repeat(64);
const record = {
  provisioningState: "Succeeded",
  outputs: {
    foundationFingerprint: { value: fingerprint },
    containerAppName: { value: "testapp-app" },
    deployedDatabaseName: { value: "mafia_current" },
    resourceIds: { value: [resourceId] },
  },
};

// Import inside the test so an absent implementation is an explicit behavior failure.
test("unchanged successful foundation with existing resources selects app-only", async () => {
  const source = await readFile(
    new URL("./azure-deployment-plan.mjs", import.meta.url),
    "utf8",
  ).catch(() => "");
  assert.ok(source.length > 0, "deployment selection helper must exist");
  const { selectFoundation } = await import("./azure-deployment-plan.mjs");
  const calls = [];
  const selection = selectFoundation({
    target,
    fingerprint,
    force: false,
    readAzure(args) {
      calls.push(args);
      return args[0] === "deployment" ? record : resourceId;
    },
  });
  assert.equal(selection.deploy, false);
  assert.equal(selection.reason, "unchanged");
  assert.equal(calls.length, 2);
});

test("missing, changed, failed, forced and deleted foundations cannot select app-only", () => {
  for (const [name, previous, force, resource] of [
    ["first deploy", null, false, resourceId],
    [
      "changed inputs",
      { ...record, outputs: { ...record.outputs, foundationFingerprint: { value: "old" } } },
      false,
      resourceId,
    ],
    ["failed", { ...record, provisioningState: "Failed" }, false, resourceId],
    ["cancelled", { ...record, provisioningState: "Canceled" }, false, resourceId],
    ["in progress", { ...record, provisioningState: "Running" }, false, resourceId],
    ["forced", record, true, resourceId],
    ["deleted resource", record, false, null],
  ]) {
    const calls = [];
    const result = selectFoundation({
      target,
      fingerprint,
      force,
      readAzure(args) {
        calls.push(args);
        return args[0] === "deployment" ? previous : resource;
      },
    });
    assert.equal(result.deploy, true, name);
    if (force) assert.equal(calls.length, 0);
  }
});

test("lookup failures and malformed successful records stop deployment", () => {
  for (const bad of [
    "not a deployment record",
    {},
    { ...record, outputs: { ...record.outputs, deployedDatabaseName: { value: "other" } } },
    { ...record, outputs: { ...record.outputs, containerAppName: { value: "other-app" } } },
    { ...record, outputs: { ...record.outputs, resourceIds: { value: [] } } },
    {
      ...record,
      outputs: {
        ...record.outputs,
        resourceIds: {
          value: ["/subscriptions/other/resourceGroups/other/providers/example/resource"],
        },
      },
    },
  ]) {
    assert.throws(() =>
      selectFoundation({ target, fingerprint, force: false, readAzure: () => bad }),
    );
  }
  for (const failAt of ["deployment", "resource"]) {
    assert.throws(
      () =>
        selectFoundation({
          target,
          fingerprint,
          force: false,
          readAzure(args) {
            if (args[0] === failAt) throw new Error("authorization/network failure fixture");
            return record;
          },
        }),
      /authorization\/network/,
    );
  }
});

test("fingerprint covers complete deployment inputs independent of commit history", () => {
  const files = [
    ["infra/main.bicep", "foundation"],
    ["infra/app.bicep", "app"],
    [".github/workflows/deploy-azure.yml", "workflow"],
    ["scripts/azure-deployment-plan.mjs", "helper"],
  ];
  const hash = foundationFingerprint(files, target);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(foundationFingerprint([...files].reverse(), target), hash);
  for (const [index] of files.entries()) {
    const changed = files.map(([path, content], i) => [
      path,
      content + (i === index ? " changed" : ""),
    ]);
    assert.notEqual(foundationFingerprint(changed, target), hash);
  }
  for (const key of Object.keys(target)) {
    assert.notEqual(foundationFingerprint(files, { ...target, [key]: "changed" }), hash);
  }
  assert.notEqual(foundationFingerprint(files.slice(1), target), hash, "deleted input file");
});

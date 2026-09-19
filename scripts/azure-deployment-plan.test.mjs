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

test("unknown and malformed resource types fail before resource lookup", () => {
  const prefix = `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}/providers/`;
  for (const suffix of [
    "Microsoft.Unknown/widgets/test",
    "Microsoft.App/managedEnvironments",
    "Microsoft.App/managedEnvironments/",
    "Microsoft.Network/virtualNetworks//subnets/test",
    "Microsoft.Network/virtualNetworks/test/subnets",
  ]) {
    const previous = {
      ...record,
      outputs: { ...record.outputs, resourceIds: { value: [prefix + suffix] } },
    };
    const calls = [];
    assert.throws(
      () =>
        selectFoundation({
          target,
          fingerprint,
          force: false,
          readAzure(args) {
            calls.push(args);
            return previous;
          },
        }),
      /unsupported or malformed resource ID/,
    );
    assert.equal(calls.length, 1, "only the foundation record may be read");
  }
});

test("resource lookup versions match every foundation Bicep type", async () => {
  const template = await readFile(new URL("../infra/main.bicep", import.meta.url), "utf8");
  const declarations = [...template.matchAll(/resource\s+\w+\s+'([^'@]+)@([^']+)'/g)];
  assert.ok(declarations.length > 0);
  for (const [, type, version] of declarations) {
    const [namespace, ...types] = type.split("/");
    const id = `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}/providers/${namespace}/${types.map((part) => `${part}/test`).join("/")}`;
    const result = selectFoundation({
      target,
      fingerprint,
      force: false,
      readAzure(args) {
        if (args[0] === "deployment") {
          return {
            ...record,
            outputs: { ...record.outputs, resourceIds: { value: [id.toUpperCase()] } },
          };
        }
        assert.equal(args[args.indexOf("--api-version") + 1], version, type);
        assert.equal(args[args.indexOf("--ids") + 1], id.toUpperCase());
        return id;
      },
    });
    assert.equal(result.deploy, false);
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

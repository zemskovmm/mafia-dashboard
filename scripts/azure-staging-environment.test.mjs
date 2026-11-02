/* global URL */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const compiledPath = process.env.AZURE_STAGING_ENVIRONMENT_TEMPLATE_PATH;
const template = compiledPath ? JSON.parse(await readFile(compiledPath, "utf8")) : undefined;
const compiledTest = (name, fn) =>
  test(name, { skip: !compiledPath && "requires AZURE_STAGING_ENVIRONMENT_TEMPLATE_PATH" }, fn);
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("staging environment bootstrap stays separately invoked from foundation and ordinary app releases", async () => {
  const [source, foundation, app] = await Promise.all(
    ["infra/staging-environment.bicep", "infra/main.bicep", "infra/app.bicep"].map(read),
  );
  assert.match(source, /targetScope = 'resourceGroup'/);
  assert.doesNotMatch(foundation + app, /staging-environment\.bicep/);
  assert.match(app, /resource environment 'Microsoft\.App\/managedEnvironments@[^']+' existing/);
  assert.doesNotMatch(foundation, /resource \w+ 'Microsoft\.App\/managedEnvironments/);
});

compiledTest(
  "compiled staging bootstrap owns only Consumption workload-profile environment and minimal logs",
  () => {
    assert.deepEqual(template.resources.map(({ type }) => type).sort(), [
      "Microsoft.App/managedEnvironments",
      "Microsoft.OperationalInsights/workspaces",
    ]);
    assert.deepEqual(Object.keys(template.parameters).sort(), ["location", "namePrefix"]);
    assert.equal(template.parameters.location.defaultValue, "northeurope");
    assert.deepEqual(template.parameters.location.allowedValues, ["northeurope"]);
    assert.equal(template.parameters.namePrefix.defaultValue, "mafiadashboard-stg");
    assert.deepEqual(template.parameters.namePrefix.allowedValues, ["mafiadashboard-stg"]);
    const environment = template.resources.find(
      ({ type }) => type === "Microsoft.App/managedEnvironments",
    );
    const logs = template.resources.find(
      ({ type }) => type === "Microsoft.OperationalInsights/workspaces",
    );
    assert.equal(environment.apiVersion, "2024-03-01");
    assert.equal(environment.name, "[format('{0}-env', parameters('namePrefix'))]");
    assert.equal(environment.location, "[parameters('location')]");
    assert.deepEqual(environment.properties.workloadProfiles, [
      { name: "Consumption", workloadProfileType: "Consumption" },
    ]);
    assert.equal(environment.properties.zoneRedundant, false);
    assert.equal(environment.properties.appLogsConfiguration.destination, "log-analytics");
    assert.match(
      environment.properties.appLogsConfiguration.logAnalyticsConfiguration.customerId,
      /Microsoft\.OperationalInsights\/workspaces/,
    );
    assert.match(
      environment.properties.appLogsConfiguration.logAnalyticsConfiguration.sharedKey,
      /^\[listKeys\(.*\.primarySharedKey\]$/,
    );
    assert.deepEqual(environment.dependsOn, [
      "[resourceId('Microsoft.OperationalInsights/workspaces', format('{0}-logs', parameters('namePrefix')))]",
    ]);
    assert.equal(logs.name, "[format('{0}-logs', parameters('namePrefix'))]");
    assert.equal(logs.location, "[parameters('location')]");
    assert.deepEqual(logs.properties, { sku: { name: "PerGB2018" }, retentionInDays: 30 });
    assert.doesNotMatch(
      JSON.stringify(template.resources),
      /Microsoft\.Network|Microsoft\.DBforPostgreSQL|Microsoft\.Storage|Microsoft\.Authorization|Microsoft\.ManagedIdentity|containerApps|vnetConfiguration|infrastructureSubnetId|production/,
    );
  },
);

compiledTest(
  "compiled staging bootstrap exposes only non-secret names and exact resource IDs",
  () => {
    assert.deepEqual(Object.keys(template.outputs).sort(), [
      "environmentId",
      "environmentName",
      "logAnalyticsWorkspaceId",
      "resourceIds",
    ]);
    assert.equal(
      template.outputs.environmentName.value,
      "[format('{0}-env', parameters('namePrefix'))]",
    );
    assert.equal(
      template.outputs.environmentId.value,
      "[resourceId('Microsoft.App/managedEnvironments', format('{0}-env', parameters('namePrefix')))]",
    );
    assert.equal(
      template.outputs.logAnalyticsWorkspaceId.value,
      "[resourceId('Microsoft.OperationalInsights/workspaces', format('{0}-logs', parameters('namePrefix')))]",
    );
    assert.deepEqual(template.outputs.resourceIds.value, [
      template.outputs.logAnalyticsWorkspaceId.value,
      template.outputs.environmentId.value,
    ]);
    assert.doesNotMatch(JSON.stringify(template.outputs), /listKeys|sharedKey|secret|password/i);
  },
);

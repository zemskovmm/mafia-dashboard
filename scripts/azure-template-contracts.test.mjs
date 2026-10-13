/* global URL */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const foundationTemplatePath = process.env.AZURE_FOUNDATION_TEMPLATE_PATH;
const appTemplatePath = process.env.AZURE_APP_TEMPLATE_PATH;
const compiledTemplatePathsProvided = Boolean(foundationTemplatePath && appTemplatePath);
if (Boolean(foundationTemplatePath) !== Boolean(appTemplatePath)) {
  throw new Error("Set both AZURE_FOUNDATION_TEMPLATE_PATH and AZURE_APP_TEMPLATE_PATH.");
}
const [foundationTemplate, appTemplate] = compiledTemplatePathsProvided
  ? await Promise.all(
      [foundationTemplatePath, appTemplatePath].map(async (path) =>
        JSON.parse(await readFile(path, "utf8")),
      ),
    )
  : [];
const compiledTemplateTest = (name, fn) =>
  test(
    name,
    { skip: !compiledTemplatePathsProvided && "requires explicit compiled template paths" },
    fn,
  );
const resourceTypes = (template) => template.resources.map(({ type }) => type).sort();
const parameterNames = (template) => Object.keys(template.parameters ?? {}).sort();
const outputNames = (template) => Object.keys(template.outputs ?? {}).sort();
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

compiledTemplateTest(
  "foundation adds only private Storage, namespace, identity and data RBAC without writing retained SQL/network/environment",
  () => {
    assert.deepEqual(resourceTypes(foundationTemplate), [
      "Microsoft.Authorization/roleAssignments",
      "Microsoft.Authorization/roleAssignments",
      "Microsoft.ManagedIdentity/userAssignedIdentities",
      "Microsoft.Storage/storageAccounts",
      "Microsoft.Storage/storageAccounts/blobServices",
      "Microsoft.Storage/storageAccounts/blobServices/containers",
      "Microsoft.Storage/storageAccounts/tableServices",
      "Microsoft.Storage/storageAccounts/tableServices/tables",
    ]);
    assert.deepEqual(parameterNames(foundationTemplate), [
      "foundationFingerprint",
      "location",
      "namePrefix",
      "storageAccountName",
      "storageContainerName",
      "storageTableName",
    ]);
    assert.deepEqual(outputNames(foundationTemplate), [
      "containerAppName",
      "environmentName",
      "foundationFingerprint",
      "resourceIds",
      "storageAccountName",
      "storageContainerName",
      "storageIdentityClientId",
      "storageTableName",
    ]);
    assert.equal(foundationTemplate.outputs.resourceIds.value.length, 8);
    const account = foundationTemplate.resources.find(
      ({ type }) => type === "Microsoft.Storage/storageAccounts",
    );
    assert.equal(account.kind, "StorageV2");
    assert.deepEqual(account.sku, { name: "Standard_LRS" });
    assert.equal(account.properties.minimumTlsVersion, "TLS1_2");
    assert.equal(account.properties.supportsHttpsTrafficOnly, true);
    assert.equal(account.properties.allowBlobPublicAccess, false);
    assert.equal(account.properties.allowSharedKeyAccess, false);
    assert.equal(account.properties.defaultToOAuthAuthentication, true);
    const container = foundationTemplate.resources.find(({ type }) => type.endsWith("/containers"));
    assert.equal(container.properties.publicAccess, "None");
    const roles = foundationTemplate.resources.filter(
      ({ type }) => type === "Microsoft.Authorization/roleAssignments",
    );
    for (const role of roles) {
      assert.equal(role.properties.principalType, "ServicePrincipal");
      assert.match(role.scope, /Microsoft\.Storage\/storageAccounts/);
      assert.match(
        role.properties.principalId,
        /Microsoft\.ManagedIdentity\/userAssignedIdentities/,
      );
    }
    assert.match(JSON.stringify(foundationTemplate), /ba92f5b4-2d11-453d-a403-e96b0029c9fe/);
    assert.match(JSON.stringify(foundationTemplate), /0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3/);
    assert.doesNotMatch(
      JSON.stringify(foundationTemplate),
      /listKeys|postgresPassword|Microsoft\.Network|Microsoft\.DBforPostgreSQL|Microsoft\.App\/managedEnvironments/,
    );
  },
);

compiledTemplateTest(
  "app-only release explicitly uses managed-identity Azure storage with gated seed-free initialization and retained release probes",
  () => {
    assert.deepEqual(resourceTypes(appTemplate), ["Microsoft.App/containerApps"]);
    assert.deepEqual(parameterNames(appTemplate), [
      "ghcrToken",
      "ghcrUsername",
      "googleClientId",
      "googleClientSecret",
      "image",
      "initializeStorage",
      "location",
      "musicTokenEncryptionKey",
      "namePrefix",
      "publicAppUrl",
      "storageAccountName",
      "storageContainerName",
      "storagePartitionKey",
      "storageTableName",
    ]);
    for (const name of ["ghcrToken", "googleClientSecret", "musicTokenEncryptionKey"])
      assert.equal(appTemplate.parameters[name].type, "securestring");
    assert.equal(appTemplate.parameters.initializeStorage.defaultValue, false);
    assert.equal(appTemplate.parameters.image.defaultValue, undefined, "image must be explicit");
    assert.deepEqual(outputNames(appTemplate), ["appFqdn", "publicUrl"]);
    const app = appTemplate.resources[0];
    assert.equal(app.identity.type, "UserAssigned");
    assert.match(
      JSON.stringify(app.identity.userAssignedIdentities),
      /Microsoft\.ManagedIdentity\/userAssignedIdentities/,
    );
    const text = JSON.stringify(appTemplate);
    assert.doesNotMatch(
      text,
      /DATABASE_URL|database-url|postgresPassword|Microsoft\.DBforPostgreSQL|migrate\.js|AZURE_STORAGE_CONNECTION_STRING|listKeys/,
    );
    assert.match(text, /Microsoft\.App\/managedEnvironments/);
    for (const value of [
      "PUBLIC_APP_URL",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_OAUTH_REDIRECT_URI",
      "api/music/oauth/callback",
      "MUSIC_TOKEN_ENCRYPTION_KEY",
      "ghcr.io",
    ])
      assert.ok(text.includes(value), value);
    const { containers, initContainers, scale } = app.properties.template;
    const env = containers[0].env;
    assert.ok(env.includes("createObject('name', 'STORAGE_PROVIDER', 'value', 'azure')"));
    for (const [name, parameter] of [
      ["AZURE_STORAGE_ACCOUNT_NAME", "storageAccountName"],
      ["AZURE_STORAGE_TABLE_NAME", "storageTableName"],
      ["AZURE_STORAGE_CONTAINER_NAME", "storageContainerName"],
      ["AZURE_STORAGE_PARTITION_KEY", "storagePartitionKey"],
    ]) {
      const field = `createObject('name', '${name}', 'value', parameters('${parameter}'))`;
      assert.ok(env.includes(field), name);
      assert.ok(initContainers[0].env.includes(field), `init ${name}`);
    }
    assert.match(env, /'AZURE_CLIENT_ID', 'value', reference\(.*\.clientId/);
    assert.match(env, /'AZURE_STORAGE_INITIALIZE', 'value', 'false'/);
    assert.match(
      initContainers[0].env,
      /'AZURE_STORAGE_INITIALIZE', 'value', string\(parameters\('initializeStorage'\)\)/,
    );
    assert.equal(containers.length, 1);
    assert.equal(initContainers.length, 1);
    assert.equal(initContainers[0].name, "initialize-storage");
    assert.deepEqual(initContainers[0].command, ["node"]);
    assert.deepEqual(initContainers[0].args, ["apps/server/dist/initialize-storage.js"]);
    assert.ok(initContainers[0].env.startsWith("[concat(createArray("));
    assert.equal(containers[0].image, "[parameters('image')]");
    assert.equal(containers[0].image, initContainers[0].image);
    assert.deepEqual(containers[0].resources, { cpu: "[json('0.5')]", memory: "1Gi" });
    assert.deepEqual(initContainers[0].resources, { cpu: "[json('0.25')]", memory: "0.5Gi" });
    assert.equal(scale.minReplicas, 1);
    assert.equal(scale.maxReplicas, 1);
    assert.equal(app.properties.configuration.activeRevisionsMode, "Single");
    assert.deepEqual(app.properties.configuration.ingress, {
      external: true,
      allowInsecure: false,
      targetPort: 3000,
      transport: "auto",
    });
    assert.deepEqual(
      containers[0].probes.map(({ type, httpGet }) => [type, httpGet.path, httpGet.port]),
      [
        ["Startup", "/health/live", 3000],
        ["Liveness", "/health/live", 3000],
        ["Readiness", "/health/ready", 3000],
      ],
    );
  },
);

test("example parameters target only the foundation and require an explicit Storage account", async () => {
  const example = JSON.parse(await read("infra/parameters.example.json"));
  assert.deepEqual(Object.keys(example.parameters).sort(), [
    "foundationFingerprint",
    "location",
    "namePrefix",
    "storageAccountName",
    "storageContainerName",
    "storageTableName",
  ]);
  assert.equal(example.parameters.storageTableName.value, "MafiaEntities");
  assert.equal(example.parameters.storageContainerName.value, "mafia-live");
  assert.doesNotMatch(JSON.stringify(example), /postgres|ghcrToken|deployApp/i);
});

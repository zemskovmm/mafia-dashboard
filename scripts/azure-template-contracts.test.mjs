import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const foundationTemplatePath = process.env.AZURE_FOUNDATION_TEMPLATE_PATH;
const appTemplatePath = process.env.AZURE_APP_TEMPLATE_PATH;
const compiledTemplatePathsProvided = Boolean(foundationTemplatePath && appTemplatePath);

if (Boolean(foundationTemplatePath) !== Boolean(appTemplatePath)) {
  throw new Error(
    "Set both AZURE_FOUNDATION_TEMPLATE_PATH and AZURE_APP_TEMPLATE_PATH, or neither for the Azure CLI-free default test run.",
  );
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

const foundationResourceTypes = [
  "Microsoft.App/managedEnvironments",
  "Microsoft.DBforPostgreSQL/flexibleServers",
  "Microsoft.DBforPostgreSQL/flexibleServers/databases",
  "Microsoft.Network/privateDnsZones",
  "Microsoft.Network/privateDnsZones/virtualNetworkLinks",
  "Microsoft.Network/virtualNetworks",
];

const foundationResourceIdTypes = [
  "Microsoft.App/managedEnvironments",
  "Microsoft.DBforPostgreSQL/flexibleServers",
  "Microsoft.DBforPostgreSQL/flexibleServers/databases",
  "Microsoft.Network/privateDnsZones",
  "Microsoft.Network/privateDnsZones/virtualNetworkLinks",
  "Microsoft.Network/virtualNetworks",
  "Microsoft.Network/virtualNetworks/subnets",
  "Microsoft.Network/virtualNetworks/subnets",
];

const appResourceTypes = ["Microsoft.App/containerApps"];

const resourceTypes = (template) => template.resources.map(({ type }) => type).sort();
const parameterNames = (template) => Object.keys(template.parameters ?? {}).sort();
const outputNames = (template) => Object.keys(template.outputs ?? {}).sort();
const templateText = (template) => JSON.stringify(template);

const requireContainerApp = (template) => {
  const app = template.resources.find(({ type }) => type === "Microsoft.App/containerApps");
  assert.ok(app, "app template must write a Container App");
  return app;
};

compiledTemplateTest(
  "foundation template owns only durable network, database, and environment resources",
  () => {
    assert.deepEqual(resourceTypes(foundationTemplate), foundationResourceTypes);
    assert.deepEqual(parameterNames(foundationTemplate), [
      "databaseName",
      "foundationFingerprint",
      "location",
      "namePrefix",
      "postgresAdminUser",
      "postgresPassword",
    ]);
    assert.equal(foundationTemplate.parameters.postgresPassword.type, "securestring");
    assert.deepEqual(outputNames(foundationTemplate), [
      "containerAppName",
      "deployedDatabaseName",
      "environmentName",
      "foundationFingerprint",
      "postgresServerName",
      "resourceIds",
    ]);
    assert.equal(foundationTemplate.outputs.foundationFingerprint.type, "string");
    assert.equal(foundationTemplate.outputs.resourceIds.type, "array");
    assert.equal(
      foundationTemplate.outputs.resourceIds.value.length,
      foundationResourceIdTypes.length,
    );

    const resourceIdOutput = JSON.stringify(foundationTemplate.outputs.resourceIds.value);
    for (const type of foundationResourceIdTypes) {
      assert.match(resourceIdOutput, new RegExp(type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  },
);

compiledTemplateTest(
  "application template writes only the Container App and exposes its URL",
  () => {
    assert.deepEqual(resourceTypes(appTemplate), appResourceTypes);
    assert.deepEqual(parameterNames(appTemplate), [
      "databaseName",
      "ghcrToken",
      "ghcrUsername",
      "googleClientId",
      "googleClientSecret",
      "image",
      "location",
      "musicTokenEncryptionKey",
      "namePrefix",
      "postgresAdminUser",
      "postgresPassword",
      "publicAppUrl",
    ]);
    for (const name of [
      "ghcrToken",
      "googleClientSecret",
      "musicTokenEncryptionKey",
      "postgresPassword",
    ]) {
      assert.equal(appTemplate.parameters[name].type, "securestring", `${name} must remain secure`);
    }
    assert.deepEqual(outputNames(appTemplate), ["appFqdn", "publicUrl"]);
    assert.equal(appTemplate.outputs.appFqdn.type, "string");
    assert.equal(appTemplate.outputs.publicUrl.type, "string");
    assert.match(appTemplate.outputs.appFqdn.value, /Microsoft\.App\/containerApps/);
    assert.match(appTemplate.outputs.publicUrl.value, /https/);

    const app = requireContainerApp(appTemplate);
    const text = templateText(appTemplate);
    assert.match(text, /Microsoft\.App\/managedEnvironments/);
    assert.match(text, /Microsoft\.DBforPostgreSQL\/flexibleServers/);
    assert.match(text, /sslmode=verify-full/);
    assert.match(text, /database-url/);
    assert.match(text, /PUBLIC_APP_URL/);
    assert.match(text, /parameters\('publicAppUrl'\)/);
    assert.match(text, /GOOGLE_OAUTH_REDIRECT_URI/);
    assert.match(text, /api\/music\/oauth\/callback/);
    assert.match(text, /MUSIC_TOKEN_ENCRYPTION_KEY/);
    assert.match(text, /ghcr\.io/);

    assert.equal(app.properties.configuration.activeRevisionsMode, "Single");
    assert.deepEqual(app.properties.configuration.ingress, {
      allowInsecure: false,
      external: true,
      targetPort: 3000,
      transport: "auto",
    });

    const { initContainers, containers, scale } = app.properties.template;
    assert.equal(initContainers.length, 1);
    assert.equal(initContainers[0].name, "migrate");
    assert.deepEqual(initContainers[0].command, ["node"]);
    assert.deepEqual(initContainers[0].args, ["apps/server/dist/migrate.js"]);
    assert.equal(initContainers[0].env, "[variables('migrationEnv')]");
    assert.deepEqual(initContainers[0].resources, { cpu: "[json('0.25')]", memory: "0.5Gi" });
    assert.deepEqual(appTemplate.variables.migrationEnv, [
      { name: "DATABASE_URL", secretRef: "database-url" },
    ]);
    assert.equal(containers.length, 1);
    assert.equal(containers[0].name, "app");
    assert.equal(containers[0].image, initContainers[0].image);
    assert.deepEqual(containers[0].resources, { cpu: "[json('0.5')]", memory: "1Gi" });
    assert.equal(scale.minReplicas, 1);
    assert.equal(scale.maxReplicas, 1);

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

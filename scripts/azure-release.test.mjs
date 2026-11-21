import assert from "node:assert/strict";
import { test } from "node:test";
import { deployRelease, readHealth, validateRelease } from "./azure-release.mjs";

const commit = "a".repeat(40);
const image = `ghcr.io/zemskovmm/mafia-dashboard@sha256:${"b".repeat(64)}`;
const source = { head: commit, packageVersion: "2.7.9" };
const environment = {
  GITHUB_REPOSITORY: "zemskovmm/mafia-dashboard",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_SHA: commit,
  GITHUB_RUN_NUMBER: "17",
  DEPLOY_IMAGE: image,
  EXPECTED_COMMIT: commit,
  EXPECTED_VERSION: "2.7.17",
  APP_BUILD_INDEX: "17",
  AZURE_SUBSCRIPTION_ID: "9f0da8f6-9da5-4bef-9738-cb26f2a19e58",
  AZURE_RESOURCE_GROUP: "rg-mafia-dashboard-prod-weu",
  AZURE_LOCATION: "northeurope",
  AZURE_NAME_PREFIX: "mafiadashboard",
  AZURE_STORAGE_ACCOUNT_NAME: "mafiadata6du4xvao4bfk2",
  AZURE_STORAGE_TABLE_NAME: "MafiaEntities",
  AZURE_STORAGE_CONTAINER_NAME: "mafia-live",
  AZURE_STORAGE_PARTITION_KEY: "production-v1",
};
const release = { commit, buildIndex: "17", version: "2.7.17", image };
const group = `/subscriptions/${environment.AZURE_SUBSCRIPTION_ID}/resourceGroups/${environment.AZURE_RESOURCE_GROUP}/providers`;
const fqdn = "mafiadashboard-app.fixture.northeurope.azurecontainerapps.io";
const origin = `https://${fqdn}`;
const runtimeClient = "test-runtime-client";
const storageEnv = Object.fromEntries(
  Object.entries(environment).filter(([key]) => key.startsWith("AZURE_STORAGE_")),
);

function app(currentImage = `ghcr.io/zemskovmm/mafia-dashboard@sha256:${"c".repeat(64)}`) {
  const common = {
    ...storageEnv,
    AZURE_STORAGE_INITIALIZE: "false",
    AZURE_CLIENT_ID: runtimeClient,
    STORAGE_PROVIDER: "azure",
  };
  const entries = (fields) => Object.entries(fields).map(([name, value]) => ({ name, value }));
  return {
    id: `${group}/Microsoft.App/containerApps/mafiadashboard-app`,
    location: "North Europe",
    identity: {
      type: "UserAssigned",
      userAssignedIdentities: {
        [`${group}/Microsoft.ManagedIdentity/userAssignedIdentities/mafiadashboard-storage`]: {
          clientId: runtimeClient,
        },
      },
    },
    properties: {
      managedEnvironmentId: `${group}/Microsoft.App/managedEnvironments/mafiadashboard-env`,
      provisioningState: "Succeeded",
      latestRevisionName: "mafiadashboard-app--active",
      latestReadyRevisionName: "mafiadashboard-app--active",
      configuration: {
        activeRevisionsMode: "Single",
        ingress: { fqdn, targetPort: 3000, external: true, allowInsecure: false },
        registries: [{ server: "ghcr.io", passwordSecretRef: "ghcr-token" }],
        secrets: [{ name: "ghcr-token" }, { name: "google-client-secret" }],
      },
      template: {
        scale: { minReplicas: 1, maxReplicas: 1 },
        containers: [
          {
            name: "app",
            image: currentImage,
            resources: { cpu: 0.5, memory: "1Gi" },
            env: [
              ...entries({
                ...common,
                PUBLIC_APP_URL: origin,
                TRUST_PROXY_HOPS: "1",
                CUSTOM_RUNTIME_FLAG: "test-fixture-private-value",
              }),
              { name: "GOOGLE_CLIENT_SECRET", secretRef: "google-client-secret" },
            ],
            probes: [{ type: "Readiness", httpGet: { path: "/health/ready", port: 3000 } }],
          },
        ],
        initContainers: [
          {
            name: "initialize-storage",
            image: currentImage,
            command: ["node"],
            args: ["apps/server/dist/initialize-storage.js"],
            env: entries(common),
          },
        ],
      },
    },
  };
}

test("release accepts only same-run immutable production identity", () => {
  assert.deepEqual(validateRelease(environment, source), release);
  for (const [key, value] of Object.entries({
    GITHUB_REF: "refs/tags/main",
    GITHUB_EVENT_NAME: "push",
    GITHUB_REPOSITORY: "fork/mafia-dashboard",
    GITHUB_SHA: "b".repeat(40),
    GITHUB_RUN_NUMBER: "017",
    EXPECTED_COMMIT: "c".repeat(40),
    EXPECTED_VERSION: "2.7.18",
    APP_BUILD_INDEX: "18",
    DEPLOY_IMAGE: "ghcr.io/zemskovmm/mafia-dashboard:main",
  }))
    assert.throws(() => validateRelease({ ...environment, [key]: value }, source), Error, key);
  for (const bad of [
    undefined,
    `${image}\n`,
    image.replace("zemskovmm", "different"),
    image.slice(0, -1),
  ]) {
    assert.throws(
      () => validateRelease({ ...environment, DEPLOY_IMAGE: bad }, source),
      /immutable GHCR digest/,
    );
  }
  for (const key of Object.keys(environment).filter((name) => name.startsWith("AZURE_"))) {
    assert.throws(
      () => validateRelease({ ...environment, [key]: "wrong-fixture" }, source),
      new RegExp(key),
    );
  }
});

function revision(id, template = app(image).properties.template) {
  return { id, properties: { active: true, healthState: "Healthy", trafficWeight: 100, template } };
}

function harness(...responses) {
  const patches = [];
  const reports = [];
  const checks = [];
  const io = {
    readApp: () => responses.shift(),
    readRevision: (id) => revision(id),
    updateApp: (patch) => patches.push(patch),
    health: (...args) => {
      checks.push(args);
      return true;
    },
    report: (message) => reports.push(message),
    attempts: responses.length - 1,
    pause: () => {},
  };
  return { io, patches, reports, checks };
}

test("only app and init images change; both must be ready before health verifies success", async () => {
  const prior = app();
  const inProgress = app(image);
  inProgress.properties.latestReadyRevisionName = "previous";
  const wrongDigest = app(image);
  wrongDigest.properties.template.initContainers[0].image =
    prior.properties.template.initContainers[0].image;
  const { io, patches, reports, checks } = harness(
    prior,
    inProgress,
    wrongDigest,
    app(image),
    app(image),
  );
  const revisions = [];
  io.readRevision = (id) => {
    revisions.push(id);
    return revision(id, revisions.length === 1 ? prior.properties.template : undefined);
  };
  await deployRelease(release, io);
  assert.deepEqual(revisions, Array(2).fill(`${prior.id}/revisions/mafiadashboard-app--active`));
  assert.deepEqual(patches, [
    {
      properties: {
        template: {
          revisionSuffix: "",
          containers: app(image).properties.template.containers,
          initContainers: app(image).properties.template.initContainers,
        },
      },
    },
  ]);
  assert.deepEqual(checks, [[origin, release]]);
  assert.match(reports[0], /verification pending/);
  assert.equal(reports[1], `Verified production release: ${commit} / 2.7.17 / ${image}`);
  assert.doesNotMatch(reports.join("\n"), /test-fixture-private-value/);
});

test("wrong live bindings prevent mutation; configuration drift prevents a verified release", async () => {
  for (const [diagnostic, mutate] of [
    [
      "app resource",
      (a) => {
        a.id += "-wrong";
      },
    ],
    [
      "managed environment",
      (a) => {
        a.properties.managedEnvironmentId += "-wrong";
      },
    ],
    [
      "HTTPS ingress",
      (a) => {
        a.properties.configuration.ingress.fqdn = "not-the-app.invalid";
      },
    ],
    [
      "replica count",
      (a) => {
        a.properties.template.scale.maxReplicas = 2;
      },
    ],
    [
      "Storage identity",
      (a) => {
        a.identity.type = "SystemAssigned";
      },
    ],
    [
      "unique environment bindings",
      (a) => {
        a.properties.template.containers[0].env.push({ name: "PUBLIC_APP_URL", value: origin });
      },
    ],
    [
      "credential fallback",
      (a) => {
        a.properties.template.initContainers[0].env.push({
          name: "AZURE_STORAGE_CONNECTION_STRING",
          value: "test-fixture-private-value",
        });
      },
    ],
    ...[
      "PUBLIC_APP_URL",
      "TRUST_PROXY_HOPS",
      ...Object.keys(storageEnv),
      "STORAGE_PROVIDER",
      "AZURE_CLIENT_ID",
      "AZURE_STORAGE_INITIALIZE",
    ].map((name) => [
      name,
      (a) => {
        const container = ["PUBLIC_APP_URL", "TRUST_PROXY_HOPS"].includes(name)
          ? a.properties.template.containers[0]
          : a.properties.template.initContainers[0];
        container.env.find((field) => field.name === name).value = "test-fixture-private-value";
      },
    ]),
  ]) {
    for (const phase of ["before", "after"]) {
      const before = app();
      const after = app(image);
      mutate(phase === "before" ? before : after);
      const { io, patches, reports, checks } = harness(before, after);
      await assert.rejects(deployRelease(release, io), {
        message: `Production binding mismatch: ${diagnostic}`,
      });
      assert.equal(patches.length, phase === "before" ? 0 : 1);
      assert.equal(checks.length, 0);
      assert.doesNotMatch(reports.join("\n"), /Verified|test-fixture-private-value/);
    }
  }
  const after = app(image);
  after.properties.template.containers[0].env.pop();
  const { io, checks } = harness(app(), after);
  await assert.rejects(deployRelease(release, io), /runtime configuration changed/);
  assert.equal(checks.length, 0);
});

test("an inactive or non-serving revision cannot pass even when its digest matches", async () => {
  for (const overrides of [{ active: false }, { trafficWeight: 0 }, { healthState: "Unhealthy" }]) {
    const { io, reports, checks } = harness(app(image), app(image));
    io.readRevision = (id) => {
      const serving = revision(id);
      return { ...serving, properties: { ...serving.properties, ...overrides } };
    };
    await assert.rejects(deployRelease(release, io), /verification timed out/);
    assert.deepEqual(checks, []);
    assert.doesNotMatch(reports.join("\n"), /Verified/);
  }
});

test("already-applied digest is not updated; unverifiable health does not report success", async () => {
  const { io, patches, reports } = harness(app(image), app(image));
  io.health = () => false;
  await assert.rejects(deployRelease(release, io), /verification timed out/);
  assert.equal(patches.length, 0);
  assert.doesNotMatch(reports.join("\n"), /Verified/);
});

test("health checks the same origin with no redirects and requires exact baked identity", async () => {
  for (const [readiness, version, expected] of [
    [true, { commit, version: "2.7.17" }, true],
    [false, { commit, version: "2.7.17" }, false],
    [true, { commit: "wrong", version: "2.7.17" }, false],
    [true, { commit, version: "2.7.170" }, false],
    [true, null, false],
  ]) {
    const calls = [];
    const check = (url, options) => {
      calls.push(url);
      assert.equal(options.redirect, "error");
      if (url.endsWith("/ready")) return { ok: readiness };
      return { ok: true, json: () => version };
    };
    assert.equal(await readHealth(origin, release, check), expected);
    assert.deepEqual(
      calls,
      readiness
        ? [`${origin}/health/ready`, `${origin}/health/version`]
        : [`${origin}/health/ready`],
    );
  }
});

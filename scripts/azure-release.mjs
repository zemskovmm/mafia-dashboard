import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { URL, fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { composeAppVersion } from "./release-verifier-contracts.mjs";

const repository = "zemskovmm/mafia-dashboard";
const registryImage = `ghcr.io/${repository}`;
const production = Object.freeze({
  AZURE_SUBSCRIPTION_ID: "9f0da8f6-9da5-4bef-9738-cb26f2a19e58",
  AZURE_RESOURCE_GROUP: "rg-mafia-dashboard-prod-weu",
  AZURE_LOCATION: "northeurope",
  AZURE_NAME_PREFIX: "mafiadashboard",
  AZURE_STORAGE_ACCOUNT_NAME: "mafiadata6du4xvao4bfk2",
  AZURE_STORAGE_TABLE_NAME: "MafiaEntities",
  AZURE_STORAGE_CONTAINER_NAME: "mafia-live",
  AZURE_STORAGE_PARTITION_KEY: "production-v1",
});
const group = `/subscriptions/${production.AZURE_SUBSCRIPTION_ID}/resourceGroups/${production.AZURE_RESOURCE_GROUP}/providers`;
const appId = `${group}/Microsoft.App/containerApps/${production.AZURE_NAME_PREFIX}-app`;
const environmentId = `${group}/Microsoft.App/managedEnvironments/${production.AZURE_NAME_PREFIX}-env`;
const storageIdentityId = `${group}/Microsoft.ManagedIdentity/userAssignedIdentities/${production.AZURE_NAME_PREFIX}-storage`;
const managementUrl = (id) => `https://management.azure.com${id}?api-version=2024-03-01`;

class ReleaseError extends Error {}

function requireCondition(condition, message) {
  if (!condition) throw new ReleaseError(message);
}

const canonicalId = (value) =>
  typeof value === "string" && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
const sameId = (actual, expected) =>
  typeof actual === "string" && actual.toLowerCase() === expected.toLowerCase();

export function buildIdentity(env, { head, packageVersion }) {
  const commit = env.GITHUB_SHA;
  const buildIndex = env.GITHUB_RUN_NUMBER;
  requireCondition(
    env.GITHUB_REPOSITORY === repository &&
      env.GITHUB_REF === "refs/heads/main" &&
      env.GITHUB_EVENT_NAME === "workflow_dispatch",
    "Production release requires a manual dispatch from trusted main",
  );
  requireCondition(
    /^[0-9a-f]{40}$/.test(commit) && commit === head,
    "Release checkout SHA mismatch",
  );
  requireCondition(canonicalId(buildIndex), "Invalid workflow build index");
  return { commit, buildIndex, version: composeAppVersion(packageVersion, buildIndex) };
}

export function validateRelease(env, source) {
  const identity = buildIdentity(env, source);
  for (const [key, value] of Object.entries(production)) {
    requireCondition(env[key] === value, `Production target mismatch: ${key}`);
  }
  requireCondition(env.EXPECTED_COMMIT === identity.commit, "Published commit mismatch");
  requireCondition(env.APP_BUILD_INDEX === identity.buildIndex, "Published build index mismatch");
  requireCondition(env.EXPECTED_VERSION === identity.version, "Published version mismatch");
  const image = env.DEPLOY_IMAGE;
  requireCondition(
    typeof image === "string" &&
      image.startsWith(`${registryImage}@`) &&
      /^sha256:[0-9a-f]{64}$/.test(image.slice(registryImage.length + 1)),
    "Release image must be the repository's immutable GHCR digest",
  );
  return { ...identity, image };
}

function assertBindings(app) {
  const require = (condition, label) =>
    requireCondition(condition, `Production binding mismatch: ${label}`);
  const properties = app?.properties;
  const config = properties?.configuration;
  const template = properties?.template;
  const containers = template?.containers;
  const init = template?.initContainers;
  // ARM returns either the region code or its display name on this resource.
  require(sameId(app?.id, appId) &&
    [production.AZURE_LOCATION, "North Europe"].includes(app.location), "app resource");
  require(sameId(properties?.managedEnvironmentId ?? properties?.environmentId, environmentId) &&
    (!properties.environmentId ||
      sameId(properties.environmentId, environmentId)), "managed environment");
  require(config?.activeRevisionsMode === "Single", "single revision mode");
  const ingress = config.ingress;
  const fqdn = ingress?.fqdn;
  require(ingress?.external === true &&
    ingress.allowInsecure === false &&
    ingress.targetPort === 3000 &&
    /^mafiadashboard-app\.[a-z0-9-]+\.northeurope\.azurecontainerapps\.io$/.test(
      fqdn,
    ), "HTTPS ingress");
  const origin = `https://${fqdn}`;
  require(template?.scale?.minReplicas === 1 && template.scale.maxReplicas === 1, "replica count");
  require(Array.isArray(containers) &&
    containers.length === 1 &&
    containers[0]?.name === "app" &&
    Array.isArray(init) &&
    init.length === 1 &&
    init[0]?.name === "initialize-storage", "app and init containers");
  require(isDeepStrictEqual(init[0].command, ["node"]) &&
    isDeepStrictEqual(init[0].args, [
      "apps/server/dist/initialize-storage.js",
    ]), "Storage readiness command");
  const identities = Object.entries(app.identity?.userAssignedIdentities ?? {});
  const clientId = identities[0]?.[1]?.clientId;
  require(app.identity?.type === "UserAssigned" &&
    identities.length === 1 &&
    sameId(identities[0]?.[0], storageIdentityId) &&
    typeof clientId === "string" &&
    clientId !== "", "Storage identity");
  for (const container of [containers[0], init[0]]) {
    require(Array.isArray(container.env), "container environment");
    const entries = new Map(container.env.map((entry) => [entry?.name, entry]));
    require(entries.size === container.env.length &&
      !entries.has(undefined), "unique environment bindings");
    const expected = {
      STORAGE_PROVIDER: "azure",
      AZURE_CLIENT_ID: clientId,
      AZURE_STORAGE_INITIALIZE: "false",
      ...Object.fromEntries(
        Object.entries(production).filter(([name]) => name.startsWith("AZURE_STORAGE_")),
      ),
      ...(container.name === "app" ? { PUBLIC_APP_URL: origin, TRUST_PROXY_HOPS: "1" } : {}),
    };
    for (const [name, value] of Object.entries(expected)) {
      const entry = entries.get(name);
      require(entry?.value === value && !entry.secretRef, name);
    }
    require(!entries.has("DATABASE_URL") &&
      !entries.has("AZURE_STORAGE_CONNECTION_STRING"), "credential fallback");
    if (entries.has("GOOGLE_OAUTH_REDIRECT_URI")) {
      require(entries.get("GOOGLE_OAUTH_REDIRECT_URI")?.value ===
        `${origin}/api/music/oauth/callback`, "music callback origin");
    }
  }
  return { origin, containers, init, properties };
}

// JSON Merge Patch replaces arrays in full: copy every existing container field,
// changing only its image. Leave secrets, ingress, identity, and scale out of PATCH.
const replaceImages = (containers, image) =>
  containers.map((container) => ({ ...container, image }));
const withoutImages = (template) => ({
  ...template,
  revisionSuffix: null,
  containers: replaceImages(template.containers, null),
  initContainers: replaceImages(template.initContainers, null),
});

function hasServingDigest(revision, id, image) {
  const properties = revision?.properties;
  const containers = properties?.template?.containers;
  const init = properties?.template?.initContainers;
  return (
    sameId(revision?.id, id) &&
    properties?.active === true &&
    properties.healthState === "Healthy" &&
    properties.trafficWeight === 100 &&
    containers?.length === 1 &&
    containers[0]?.name === "app" &&
    containers[0].image === image &&
    init?.length === 1 &&
    init[0]?.name === "initialize-storage" &&
    init[0].image === image
  );
}

export async function deployRelease(
  release,
  { readApp, readRevision, updateApp, health, pause, report, attempts = 30 },
) {
  const before = await readApp();
  const current = assertBindings(before);
  requireCondition(
    current.properties.provisioningState === "Succeeded",
    "Production app is not provisioned successfully",
  );
  if ([...current.containers, ...current.init].some(({ image }) => image !== release.image)) {
    await updateApp({
      properties: {
        template: {
          revisionSuffix: "", // Let Azure assign a unique revision name.
          containers: replaceImages(current.containers, release.image),
          initContainers: replaceImages(current.init, release.image),
        },
      },
    });
  }
  report(
    `Production image update accepted or already applied; verification pending: ${release.image}`,
  );

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const after = await readApp();
    const properties = after?.properties;
    requireCondition(
      properties?.provisioningState !== "Failed",
      "Production image update failed in Azure",
    );
    if (
      properties?.provisioningState === "Succeeded" &&
      /^mafiadashboard-app--[a-z0-9-]+$/.test(properties.latestRevisionName) &&
      properties.latestRevisionName === properties.latestReadyRevisionName
    ) {
      const applied = assertBindings(after);
      requireCondition(
        applied.origin === current.origin &&
          isDeepStrictEqual(properties.configuration, current.properties.configuration) &&
          isDeepStrictEqual(after.identity, before.identity) &&
          isDeepStrictEqual(
            withoutImages(properties.template),
            withoutImages(current.properties.template),
          ),
        "Production runtime configuration changed during deployment",
      );
      if ([...applied.containers, ...applied.init].every(({ image }) => image === release.image)) {
        const id = `${appId}/revisions/${properties.latestRevisionName}`;
        if (
          hasServingDigest(await readRevision(id), id, release.image) &&
          (await health(applied.origin, release))
        ) {
          report(
            `Verified production release: ${release.commit} / ${release.version} / ${release.image}`,
          );
          return;
        }
      }
    }
    if (attempt + 1 < attempts) await pause();
  }
  throw new ReleaseError(
    "Production digest, revision readiness or serving version verification timed out; the image update may already be applied",
  );
}

function run(command, args, failure) {
  // Never forward Azure output/errors to Actions logs; they can contain settings.
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
  requireCondition(result.status === 0, failure);
  return result.stdout.trim();
}

function readAzureResource(id, failure) {
  const json = run(
    "az",
    [
      "rest",
      "--method",
      "get",
      "--url",
      managementUrl(id),
      "--output",
      "json",
      "--only-show-errors",
    ],
    failure,
  );
  try {
    return JSON.parse(json);
  } catch {
    throw new ReleaseError("Invalid Azure production readback");
  }
}

export async function readHealth(origin, release, requestUrl = globalThis.fetch) {
  const request = (path) =>
    requestUrl(`${origin}${path}`, {
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(5_000),
    });
  try {
    const ready = await request("/health/ready");
    await ready.body?.cancel();
    if (!ready.ok) return false;
    const version = await request("/health/version");
    if (!version.ok) {
      await version.body?.cancel();
      return false;
    }
    const identity = await version.json();
    return identity?.version === release.version && identity?.commit === release.commit;
  } catch {
    return false;
  }
}

async function main(command, env) {
  const source = {
    head: run("git", ["rev-parse", "HEAD"], "Cannot read release checkout SHA"),
    packageVersion: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
      .version,
  };
  if (command === "build-identity") {
    const { commit, buildIndex, version } = buildIdentity(env, source);
    requireCondition(
      canonicalId(env.GITHUB_RUN_ID) && canonicalId(env.GITHUB_RUN_ATTEMPT),
      "Invalid release run identity",
    );
    const tag = `${registryImage}:${commit}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
    appendFileSync(
      env.GITHUB_OUTPUT,
      `commit=${commit}\nbuild_index=${buildIndex}\napp_version=${version}\ntag=${tag}\n`,
    );
    return;
  }
  const release = validateRelease(env, source);
  if (command === "validate") return;
  requireCondition(command === "deploy", "Unknown Azure release command");
  await deployRelease(release, {
    readApp: () => readAzureResource(appId, "Cannot read the existing production app"),
    readRevision: (id) => readAzureResource(id, "Cannot read the active production revision"),
    updateApp: (patch) => {
      // Existing template values are private; do not pass them in CLI arguments.
      const directory = mkdtempSync(join(tmpdir(), "mafia-production-patch-"));
      try {
        const body = join(directory, "template.json");
        writeFileSync(body, JSON.stringify(patch), { mode: 0o600 });
        run(
          "az",
          [
            "rest",
            "--method",
            "patch",
            "--url",
            managementUrl(appId),
            "--headers",
            "Content-Type=application/json",
            "--body",
            `@${body}`,
            "--output",
            "none",
            "--only-show-errors",
          ],
          "Azure did not confirm acceptance of the production image update",
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    health: readHealth,
    pause: () => delay(10_000),
    report: (message) => appendFileSync(env.GITHUB_STEP_SUMMARY, `${message}\n`),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv[2], process.env);
  } catch (error) {
    // Only fixed diagnostics and validated release identity reach the logs.
    console.error(
      error instanceof ReleaseError
        ? error.message
        : "Production release could not complete safely",
    );
    process.exitCode = 1;
  }
}

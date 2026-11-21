/* global URL */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);

// Keep resource GETs on the same supported API versions as infra/main.bicep.
const resourceApiVersions = new Map([
  ["microsoft.app/managedenvironments", "2024-03-01"],
  ["microsoft.storage/storageaccounts", "2025-01-01"],
  ["microsoft.storage/storageaccounts/blobservices", "2025-01-01"],
  ["microsoft.storage/storageaccounts/blobservices/containers", "2025-01-01"],
  ["microsoft.storage/storageaccounts/tableservices", "2025-01-01"],
  ["microsoft.storage/storageaccounts/tableservices/tables", "2025-01-01"],
  ["microsoft.managedidentity/userassignedidentities", "2023-01-31"],
  ["microsoft.authorization/roleassignments", "2022-04-01"],
]);

export function foundationFingerprint(files, target) {
  return createHash("sha256")
    .update(JSON.stringify({ target, files: [...files].sort(([a], [b]) => a.localeCompare(b)) }))
    .digest("hex");
}

// Keep a read-only what-if gate for separately authorized Incremental maintenance.
export function assertSafeFoundationChanges(result, target) {
  if (result?.status !== "Succeeded" || !Array.isArray(result.changes)) {
    throw new Error("Foundation what-if did not return a successful change list");
  }
  const scope =
    `/subscriptions/${target.subscriptionId}/resourcegroups/${target.resourceGroup}/providers/`.toLowerCase();
  const storage = `microsoft.storage/storageaccounts/${target.storageAccountName}`.toLowerCase();
  const writable = new Set([
    storage,
    `${storage}/blobservices/default`,
    `${storage}/blobservices/default/containers/${target.storageContainerName}`.toLowerCase(),
    `${storage}/tableservices/default`,
    `${storage}/tableservices/default/tables/${target.storageTableName}`.toLowerCase(),
    `microsoft.managedidentity/userassignedidentities/${target.namePrefix}-storage`.toLowerCase(),
  ]);
  const storageRole = `${storage}/providers/microsoft.authorization/roleassignments/`;
  const roleIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  for (const change of result.changes) {
    const id = typeof change?.resourceId === "string" ? change.resourceId.toLowerCase() : "";
    if (id.length <= scope.length || !id.startsWith(scope)) {
      throw new Error("Foundation what-if includes a resource outside the selected target");
    }
    if (["NoChange", "Ignore"].includes(change.changeType)) continue;
    const relative = id.slice(scope.length);
    const isStorageRole =
      relative.startsWith(storageRole) && roleIdPattern.test(relative.slice(storageRole.length));
    if (
      !["Create", "Modify", "Deploy"].includes(change.changeType) ||
      (!writable.has(relative) && !isStorageRole)
    ) {
      throw new Error("Foundation what-if includes an unsafe change");
    }
  }
}

export function selectFoundation({ target, fingerprint, force, readAzure }) {
  if (force) return { deploy: true, reason: "manual override" };
  const record = readAzure([
    "deployment",
    "group",
    "show",
    "--resource-group",
    target.resourceGroup,
    "--name",
    "mafia-foundation",
    "--query",
    "properties.{provisioningState:provisioningState,outputs:outputs}",
  ]);
  if (record === null) return { deploy: true, reason: "no foundation record" };
  if (typeof record !== "object" || typeof record.provisioningState !== "string") {
    throw new Error("Malformed Azure foundation record");
  }
  if (record.provisioningState !== "Succeeded") {
    return { deploy: true, reason: "foundation not successful" };
  }
  const outputs = record.outputs;
  if (outputs?.foundationFingerprint?.value !== fingerprint) {
    return { deploy: true, reason: "foundation inputs changed or unrecorded" };
  }
  if (
    outputs.containerAppName?.value !== `${target.namePrefix}-app` ||
    outputs.environmentName?.value !== `${target.namePrefix}-env` ||
    outputs.storageAccountName?.value !== target.storageAccountName ||
    outputs.storageTableName?.value !== target.storageTableName ||
    outputs.storageContainerName?.value !== target.storageContainerName
  ) {
    throw new Error("Foundation record target does not match deployment inputs");
  }
  const ids = outputs.resourceIds?.value;
  const prefix =
    `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}/providers/`.toLowerCase();
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.some((id) => typeof id !== "string" || !id.toLowerCase().startsWith(prefix))
  ) {
    throw new Error("Foundation record has invalid resource IDs");
  }
  for (const id of ids) {
    const scopes = id.slice(prefix.length).toLowerCase().split("/providers/");
    if (
      scopes.length > 2 ||
      (scopes.length === 2 &&
        (!/^microsoft\.storage\/storageaccounts\/[^/]+$/.test(scopes[0]) ||
          !scopes[1].startsWith("microsoft.authorization/roleassignments/")))
    ) {
      throw new Error("Foundation record has an unsupported or malformed resource ID");
    }
    const [namespace, ...segments] = scopes.at(-1).split("/");
    const type = [namespace, ...segments.filter((_, index) => index % 2 === 0)].join("/");
    const apiVersion = resourceApiVersions.get(type);
    if (!apiVersion || segments.length % 2 !== 0 || segments.some((segment) => !segment)) {
      throw new Error("Foundation record has an unsupported or malformed resource ID");
    }
    const existingId = readAzure([
      "resource",
      "show",
      "--ids",
      id,
      "--api-version",
      apiVersion,
      "--query",
      "id",
    ]);
    if (existingId === null) return { deploy: true, reason: "foundation resource missing" };
    if (typeof existingId !== "string" || existingId.toLowerCase() !== id.toLowerCase()) {
      throw new Error("Unexpected foundation resource lookup response");
    }
  }
  return { deploy: false, reason: "unchanged" };
}

export function readAzure(args) {
  let output;
  try {
    output = execFileSync("az", [...args, "--output", "json", "--only-show-errors"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
  } catch (error) {
    if (
      /\((DeploymentNotFound|ResourceGroupNotFound|ResourceNotFound|ParentResourceNotFound)\)/.test(
        String(error.stderr),
      )
    ) {
      return null;
    }
    throw new Error("Azure foundation lookup failed; refusing an unverified app-only deployment", {
      cause: error,
    });
  }
  const value = JSON.parse(output);
  if (value === null) throw new Error("Azure lookup returned null without a not-found error");
  return value;
}

export function deploymentTarget(env = process.env) {
  const fields = {
    subscriptionId: "AZURE_SUBSCRIPTION_ID",
    resourceGroup: "AZURE_RESOURCE_GROUP",
    location: "AZURE_LOCATION",
    namePrefix: "AZURE_NAME_PREFIX",
    storageAccountName: "AZURE_STORAGE_ACCOUNT_NAME",
    storageTableName: "AZURE_STORAGE_TABLE_NAME",
    storageContainerName: "AZURE_STORAGE_CONTAINER_NAME",
    storagePartitionKey: "AZURE_STORAGE_PARTITION_KEY",
  };
  const patterns = {
    storageAccountName: /^[a-z0-9]{3,24}$/,
    storageTableName: /^[A-Za-z][A-Za-z0-9]{2,62}$/,
    storageContainerName: /^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,
    storagePartitionKey: /^[^/\\?#]{1,256}$/u,
    namePrefix: /^[a-z][a-z0-9-]{2,17}$/,
  };
  return Object.fromEntries(
    Object.entries(fields).map(([field, key]) => {
      const value = env[key];
      if (
        typeof value !== "string" ||
        !value ||
        [...value].some((character) => {
          const code = character.codePointAt(0);
          return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
        }) ||
        (patterns[field] && !patterns[field].test(value))
      ) {
        throw new Error(`Missing or invalid ${key}`);
      }
      return [field, value];
    }),
  );
}

function main(args) {
  const target = deploymentTarget();
  if (args.length === 2 && args[0] === "--check-foundation-what-if") {
    assertSafeFoundationChanges(JSON.parse(readFileSync(args[1], "utf8")), target);
    console.log("Foundation what-if passed change-scope checks");
    return;
  }
  if (args.length !== 0)
    throw new Error("Expected --check-foundation-what-if <json-file> or no arguments");
  const paths = [
    ...readdirSync(new URL("infra/", root), { recursive: true })
      .filter((path) => path.endsWith(".bicep"))
      .map((path) => `infra/${path}`),
    ".github/workflows/deploy-azure-release.yml",
    ".github/workflows/deploy-production.yml",
    "scripts/azure-release.mjs",
    "scripts/azure-deployment-plan.mjs",
  ];
  const files = paths.map((path) => [path, readFileSync(new URL(path, root), "utf8")]);
  const fingerprint = foundationFingerprint(files, target);
  const selection = selectFoundation({
    target,
    fingerprint,
    force: process.env.DEPLOY_INFRASTRUCTURE === "true",
    readAzure,
  });
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `deploy=${selection.deploy}\nreason=${selection.reason}\nfingerprint=${fingerprint}\napp_name=${target.namePrefix}-app\nstorage_account_name=${target.storageAccountName}\nstorage_table_name=${target.storageTableName}\nstorage_container_name=${target.storageContainerName}\nstorage_partition_key=${target.storagePartitionKey}\n`,
  );
  console.log(`Infrastructure deployment: ${selection.deploy} (${selection.reason})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));

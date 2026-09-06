/* global URL */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);

export function foundationFingerprint(files, target) {
  return createHash("sha256")
    .update(JSON.stringify({ target, files: [...files].sort(([a], [b]) => a.localeCompare(b)) }))
    .digest("hex");
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
    outputs.deployedDatabaseName?.value !== target.databaseName
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
    const existingId = readAzure(["resource", "show", "--ids", id, "--query", "id"]);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = {
    subscriptionId: process.env.AZURE_SUBSCRIPTION_ID,
    resourceGroup: process.env.AZURE_RESOURCE_GROUP,
    location: process.env.AZURE_LOCATION,
    namePrefix: process.env.AZURE_NAME_PREFIX,
    databaseName: process.env.AZURE_DATABASE_NAME,
  };
  if (Object.values(target).some((value) => !value || /[\r\n]/.test(value))) {
    throw new Error("Missing or invalid non-secret deployment target");
  }
  const paths = [
    ...readdirSync(new URL("infra/", root), { recursive: true })
      .filter((path) => path.endsWith(".bicep"))
      .map((path) => `infra/${path}`),
    ".github/workflows/deploy-azure.yml",
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
    `deploy=${selection.deploy}\nreason=${selection.reason}\nfingerprint=${fingerprint}\napp_name=${target.namePrefix}-app\ndatabase_name=${target.databaseName}\n`,
  );
  console.log(`Infrastructure deployment: ${selection.deploy} (${selection.reason})`);
}

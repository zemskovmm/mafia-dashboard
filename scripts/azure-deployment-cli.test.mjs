import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("selection CLI emits safe outputs and fails closed on Azure errors", () => {
  const directory = mkdtempSync(join(tmpdir(), "mafia-azure-cli-"));
  const output = join(directory, "outputs");
  const resourceId =
    "/subscriptions/sub/resourceGroups/group/providers/Microsoft.App/managedEnvironments/app-env";
  const env = {
    PATH: `${directory}:${process.env.PATH}`,
    AZURE_SUBSCRIPTION_ID: "sub",
    AZURE_RESOURCE_GROUP: "group",
    AZURE_LOCATION: "northeurope",
    AZURE_NAME_PREFIX: "app",
    AZURE_DATABASE_NAME: "mafia_current",
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
    assert.equal(outputs().database_name, "mafia_current");
    assert.equal(outputs().app_name, "app-app");
    const fingerprint = outputs().fingerprint;
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    const record = {
      provisioningState: "Succeeded",
      outputs: {
        foundationFingerprint: { value: fingerprint },
        containerAppName: { value: "app-app" },
        deployedDatabaseName: { value: "mafia_current" },
        resourceIds: { value: [resourceId] },
      },
    };
    const success = `process.stdout.write(JSON.stringify(process.argv[2] === "deployment" ? ${JSON.stringify(record)} : ${JSON.stringify(resourceId)}));`;
    assert.equal(run(success).status, 0);
    assert.equal(outputs().deploy, "false");
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

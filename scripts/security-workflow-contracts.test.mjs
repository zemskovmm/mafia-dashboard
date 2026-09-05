/* global URL */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("root scripts expose one deterministic quality gate", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const { scripts } = packageJson;

  assert.equal(scripts["ci:install"], "npm ci --ignore-scripts --no-audit && npm rebuild esbuild");
  assert.equal(
    scripts["test:security-contracts"],
    "node --test scripts/security-workflow-contracts.test.mjs",
  );
  assert.equal(
    scripts.check,
    "npm run format:check && npm run lint && npm run typecheck && npm run test && npm run build",
  );
  assert.match(scripts.test, /test:security-contracts/);
  assert.equal(packageJson.allowScripts, undefined);
});

test("pull requests run CI while main pushes and manual dispatch run deployment", async () => {
  const directory = new URL(".github/workflows/", root);
  const workflows = (await readdir(directory)).filter((name) => name.endsWith(".yml")).sort();
  const [ci, deploy] = await Promise.all([
    read(".github/workflows/ci.yml"),
    read(".github/workflows/deploy-azure.yml"),
  ]);

  assert.deepEqual(workflows, ["ci.yml", "deploy-azure.yml"]);
  assert.match(ci, /^on:\n\s{2}pull_request:\n\npermissions:/m);
  assert.match(ci, /npm run ci:install[\s\S]*npm run check/);
  assert.match(deploy, /^on:\n\s{2}push:\n\s{4}branches: \[main\]\n\s{2}workflow_dispatch:/m);
});

test("every external workflow action is pinned to an immutable commit", async () => {
  const directory = new URL(".github/workflows/", root);
  const workflows = (await readdir(directory)).filter((name) => name.endsWith(".yml"));
  assert.equal(workflows.length, 2);

  for (const workflow of workflows) {
    const source = await read(`.github/workflows/${workflow}`);
    assert.doesNotMatch(source, /^\s*-\s*run:\s*npm ci\s*$/gm);
    for (const match of source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
      const action = match[1];
      if (action.startsWith("./")) continue;
      assert.match(action, /@[0-9a-f]{40}$/i, `${workflow} must pin ${action} to a commit`);
    }
  }
});

test("Azure publishes an immutable image and deploys its verified digest with least privilege", async () => {
  const source = await read(".github/workflows/deploy-azure.yml");
  const publishStart = source.indexOf("\n  publish:\n");
  const deployStart = source.indexOf("\n  deploy:\n", publishStart);
  const publish = source.slice(publishStart, deployStart);
  const deploy = source.slice(deployStart);

  assert.match(source, /^permissions:\n\s{2}contents: read$/m);
  assert.match(source, /^jobs:\n\s{2}publish:\n/m);
  assert.match(publish, /permissions:\n\s{6}contents: read\n\s{6}packages: write/);
  assert.doesNotMatch(publish, /id-token: write/);
  assert.match(publish, /load: true/);
  assert.doesNotMatch(publish, /push: true/);
  assert.match(publish, /outputs:\n\s{6}image: \$\{\{ steps\.publish\.outputs\.image \}\}/);
  assert.match(publish, /id: publish/);
  assert.match(publish, /build-args:[\s\S]*APP_COMMIT=\$\{\{ github\.sha \}\}/);
  assert.match(publish, /docker buildx imagetools inspect "\$IMAGE_REF"/);
  assert.match(publish, /image_ref="\$\{IMAGE_REF%:\*\}@\$digest"/);
  assert.match(publish, /docker push/);
  assert.match(deploy, /permissions:\n\s{6}contents: read\n\s{6}id-token: write/);
  assert.doesNotMatch(deploy, /packages: write/);
  assert.match(deploy, /DEPLOY_IMAGE: \$\{\{ needs\.publish\.outputs\.image \}\}/);
  assert.match(deploy, /image="\$DEPLOY_IMAGE"/);
  assert.match(deploy, /\/health\/version/);
  assert.match(deploy, /--arg commit "\$GITHUB_SHA"/);
  assert.match(deploy, /health\/version" 2>\/dev\/null \|\| true/);
  assert.match(deploy, /az containerapp revision list/);
  assert.match(deploy, /az containerapp logs show/);
  assert.match(deploy, /--revision "\$failed_revision"/);
  assert.match(deploy, /--container migrate/);
  assert.doesNotMatch(deploy, /image="ghcr\.io\/\$\{GITHUB_REPOSITORY\}:\$\{GITHUB_SHA\}"/);
});

test("Azure passes one explicit database target through every deployment path", async () => {
  const [workflow, template] = await Promise.all([
    read(".github/workflows/deploy-azure.yml"),
    read("infra/main.bicep"),
  ]);

  assert.match(workflow, /AZURE_DATABASE_NAME: \$\{\{ vars\.AZURE_DATABASE_NAME \}\}/);
  const invocations = workflow.match(
    /az deployment group (?:validate|create)[\s\S]*?--output (?:none|json)/g,
  );
  assert.equal(invocations?.length, 3);
  for (const invocation of invocations) {
    assert.match(invocation, /databaseName="\$AZURE_DATABASE_NAME"/);
  }
  assert.match(template, /@minLength\(1\)\s+@maxLength\(63\)\s+param databaseName string\s*\n/);
  assert.doesNotMatch(template, /(?:var|param) databaseName[^\n]*=/);
  assert.match(template, /parent: postgres\s+name: databaseName/);
  assert.match(template, /5432\/\$\{databaseName\}\?sslmode=verify-full/);
  assert.match(template, /output deployedDatabaseName string = database.name/);
  assert.match(workflow, /\.deployedDatabaseName\.value/);
  assert.match(workflow, /echo "- Database:.*steps\.foundation\.outputs\.database_name/);
});

test("Azure rejects missing or unsafe database names before resource mutation", async () => {
  const source = await read(".github/workflows/deploy-azure.yml");
  const start = source.indexOf("      - name: Validate deployment inputs\n");
  const end = source.indexOf("      - name: Create resource group\n", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end).split("        run: |\n")[1];
  assert.ok(block);
  const script = block.replace(/^ {10}/gm, "");
  const environment = {
    AZURE_RESOURCE_GROUP: "test-group",
    AZURE_LOCATION: "northeurope",
    AZURE_NAME_PREFIX: "testapp",
    GHCR_USERNAME: "testuser",
    GHCR_TOKEN: "test-fixture-token",
    POSTGRES_PASSWORD: "test-fixture-password",
  };
  for (const name of [
    undefined,
    "",
    " ",
    "Uppercase",
    "1name",
    "a-b",
    "a/b",
    "a?b",
    "a\nb",
    "a".repeat(64),
    "$(exit 0)",
  ]) {
    const result = spawnSync("/bin/bash", ["-c", script], {
      env: { ...environment, ...(name === undefined ? {} : { AZURE_DATABASE_NAME: name }) },
      encoding: "utf8",
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, `must reject ${JSON.stringify(name)}`);
    assert.match(result.stderr, /AZURE_DATABASE_NAME/);
    assert.doesNotMatch(result.stdout + result.stderr, /test-fixture/);
  }
  for (const name of ["a", "mafia_current_20260905", "a".repeat(63)]) {
    const result = spawnSync("/bin/bash", ["-c", script], {
      env: { ...environment, AZURE_DATABASE_NAME: name },
      encoding: "utf8",
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `must accept ${name}`);
    assert.equal(result.stdout + result.stderr, "");
  }
});

test("ESLint loads repository-owned security rules", async () => {
  const source = await read("eslint.config.js");

  assert.match(source, /eslint-plugin-security/);
  assert.match(source, /eslint-plugin-no-unsanitized/);
});

test("runtime image refreshes OS fixes and omits package managers", async () => {
  const source = await read("Dockerfile");

  assert.equal(source.match(/^FROM node:22-alpine@sha256:[0-9a-f]{64} AS /gm)?.length, 2);
  assert.match(source, /RUN apk upgrade --no-cache/);
  assert.match(source, /\/usr\/local\/lib\/node_modules\/(?:npm|corepack)/);
  assert.match(source, /\/usr\/local\/bin\/(?:npm|npx|corepack)/);
  assert.match(source, /\/opt\/yarn-v\*/);
  assert.match(source, /\/usr\/local\/bin\/(?:yarn|yarnpkg)/);
  assert.match(source, /\/sbin\/apk/);
  assert.match(source, /RUN npm run ci:install/);
  assert.match(source, /npm prune --omit=dev --ignore-scripts --no-audit/);
  assert.match(source, /^ARG APP_COMMIT="unknown"$/m);
  assert.match(source, /APP_COMMIT=\$\{APP_COMMIT\}/);
});

test("Compose passes source identity into immutable application builds", async () => {
  const [compose, verifier] = await Promise.all([
    read("compose.yaml"),
    read("scripts/verify-production-compose.mjs"),
  ]);

  assert.match(compose, /APP_COMMIT: \$\{APP_COMMIT:-unknown\}/);
  assert.match(verifier, /status.*--porcelain.*--untracked-files=no/s);
  assert.match(verifier, /trackedStatus.*\? appCommitResult\.stdout\.trim\(\) : "unknown"/s);
  assert.match(verifier, /APP_COMMIT: appCommit/);
  assert.match(verifier, /\/health\/version/);
});

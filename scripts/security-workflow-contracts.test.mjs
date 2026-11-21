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

test("PR and main push run CI only; Pages remains an independent manual workflow", async () => {
  const workflows = (await readdir(new URL(".github/workflows/", root)))
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort();
  assert.deepEqual(workflows, [
    "ci.yml",
    "deploy-azure-release.yml",
    "deploy-production.yml",
    "deploy-site-pages.yml",
  ]);
  const [ci, pages] = await Promise.all([
    read(".github/workflows/ci.yml"),
    read(".github/workflows/deploy-site-pages.yml"),
  ]);
  assert.match(
    ci,
    /^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_call:\n\npermissions:\n {2}contents: read\n\njobs:/m,
  );
  assert.match(
    ci,
    /- run: npm run ci:install\n\s+- run: npm run build -w @mafia\/game-domain\n\s+- run: npm run check:local/,
  );
  assert.doesNotMatch(
    ci,
    /postgres|TEST_DATABASE_URL|\bservices:|environment:|secrets:|id-token:|packages:|docker\/|azure\//i,
  );
  assert.match(pages, /^on:\n {2}workflow_dispatch:\n\npermissions:/m);
  assert.match(pages, / {4}if: github.ref == 'refs\/heads\/main'/);
  assert.match(pages, /name: github-pages/);
  assert.match(pages, /path: apps\/site\/dist/);
});

test("production release runs only on manual main dispatch and gates publication on CI", async () => {
  const source = await read(".github/workflows/deploy-production.yml");
  assert.match(
    source,
    /^on:\n {2}workflow_dispatch:\n\npermissions:\n {2}contents: read\n\nconcurrency:/m,
  );
  assert.match(
    source,
    /^concurrency:\n {2}group: azure-production\n {2}cancel-in-progress: false$/m,
  );
  assert.match(
    source,
    /^ {2}check:\n {4}if: github\.ref == 'refs\/heads\/main' && github\.event_name == 'workflow_dispatch'\n {4}uses: \.\/\.github\/workflows\/ci\.yml$/m,
  );
  assert.match(
    source,
    /^ {2}publish:\n {4}needs: check\n {4}if: github\.ref == 'refs\/heads\/main' && github\.event_name == 'workflow_dispatch'$/m,
  );
  assert.match(
    source,
    /^ {2}deploy:\n {4}needs: publish\n {4}if: github\.ref == 'refs\/heads\/main' && github\.event_name == 'workflow_dispatch'$/m,
  );
  assert.doesNotMatch(source, /continue-on-error|always\(\)|staging/i);
});

test("every external workflow action is pinned to an immutable commit", async () => {
  const directory = new URL(".github/workflows/", root);
  const workflows = (await readdir(directory)).filter((name) => /\.ya?ml$/i.test(name));
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

test("one build hands its exact digest and baked identity to the protected production job", async () => {
  const [source, deploy] = await Promise.all([
    read(".github/workflows/deploy-production.yml"),
    read(".github/workflows/deploy-azure-release.yml"),
  ]);
  const publish = source.split("\n  publish:\n")[1].split("\n  deploy:\n")[0];
  const caller = source.split("\n  deploy:\n")[1];
  assert.match(publish, /permissions:\n {6}contents: read\n {6}packages: write\n {4}outputs:/);
  assert.doesNotMatch(publish, /id-token:|environment:/);
  assert.equal(publish.match(/docker\/build-push-action@/g)?.length, 1);
  assert.match(publish, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(publish, /platforms: linux\/amd64\n {10}load: true\n {10}push: false/);
  assert.match(publish, /APP_COMMIT=\$\{\{ steps\.build_identity\.outputs\.commit \}\}/);
  assert.match(publish, /APP_BUILD_INDEX=\$\{\{ steps\.build_identity\.outputs\.build_index \}\}/);
  assert.ok(publish.includes("      image: ${{ steps.publish.outputs.image }}"));
  for (const [key, variable] of Object.entries({
    image: "DEPLOY_IMAGE",
    commit: "EXPECTED_COMMIT",
    build_index: "APP_BUILD_INDEX",
    app_version: "EXPECTED_VERSION",
  })) {
    assert.ok(caller.includes(`      ${key}: \${{ needs.publish.outputs.${key} }}`), key);
    assert.ok(deploy.includes(`      ${variable}: \${{ inputs.${key} }}`), variable);
    if (key !== "image")
      assert.ok(publish.includes(`      ${key}: \${{ steps.build_identity.outputs.${key} }}`), key);
  }
  assert.match(caller, /uses: \.\/\.github\/workflows\/deploy-azure-release.yml/);
  assert.match(deploy, /^on:\n {2}workflow_call:\n {4}inputs:/m);
  assert.match(
    deploy,
    /^ {2}deploy:\n {4}if: github\.ref == 'refs\/heads\/main' && github\.event_name == 'workflow_dispatch' && github\.workflow_ref == format\('\{0\}\/\.github\/workflows\/deploy-production\.yml@refs\/heads\/main', github\.repository\)\n {4}environment: production$/m,
  );
  assert.match(deploy, /permissions:\n {6}contents: read\n {6}id-token: write\n {4}env:/);
  for (const source of [caller, deploy]) {
    assert.doesNotMatch(
      source,
      /packages: write|secrets: inherit|initialize_storage|deploy_infrastructure|staging|docker\//i,
    );
  }
  assert.match(
    deploy,
    /node scripts\/azure-release\.mjs validate[\s\S]+uses: azure\/login@[\s\S]+node scripts\/azure-release\.mjs deploy/,
  );
  assert.doesNotMatch(deploy, /\$\{\{ secrets\.|az deployment|--debug/);
});

test("registry push outputs a digest only after exact registry readback", async () => {
  const source = await read(".github/workflows/deploy-production.yml");
  const script = source
    .split("      - name: Push immutable image\n")[1]
    .split("\n  deploy:")[0]
    .split("        run: |\n")[1]
    .replace(/^ {10}/gm, "");
  const digest = `sha256:${"a".repeat(64)}`;
  const run = (push, remote, pushStatus = "0") =>
    spawnSync(
      "/bin/bash",
      [
        "-c",
        `
    docker() {
      case "$1" in
        push) printf '%s\\n' "$PUSH"; return "$PUSH_STATUS" ;;
        buildx) printf '%s\\n' "$REMOTE" ;;
        *) return 99 ;;
      esac
    }
    ${script}
  `,
      ],
      {
        env: {
          PATH: process.env.PATH,
          PUSH: push,
          REMOTE: remote,
          PUSH_STATUS: pushStatus,
          IMAGE_REF: "ghcr.io/fixture/dashboard:build-1",
          GITHUB_OUTPUT: "/dev/stdout",
        },
        encoding: "utf8",
        timeout: 5_000,
      },
    );
  const success = run(`build-1: digest: ${digest} size: 42`, digest);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stdout, `image=ghcr.io/fixture/dashboard@${digest}\n`);
  for (const failure of [
    run("no digest", digest),
    run(`digest: ${digest} size: 1`, ""),
    run(`digest: ${digest} size: 1`, `sha256:${"b".repeat(64)}`),
    run(`digest: ${digest} size: 1`, digest, "1"),
  ]) {
    assert.equal(failure.status, 1);
    assert.equal(failure.stdout, "");
  }
});

test("production release checks the explicit Storage target and retained templates keep managed-identity bindings", async () => {
  const [workflow, template, app] = await Promise.all([
    read(".github/workflows/deploy-azure-release.yml"),
    read("infra/main.bicep"),
    read("infra/app.bicep"),
  ]);
  for (const [parameter, variable] of [
    ["storageAccountName", "AZURE_STORAGE_ACCOUNT_NAME"],
    ["storageTableName", "AZURE_STORAGE_TABLE_NAME"],
    ["storageContainerName", "AZURE_STORAGE_CONTAINER_NAME"],
    ["storagePartitionKey", "AZURE_STORAGE_PARTITION_KEY"],
  ]) {
    assert.ok(workflow.includes(`${variable}: \${{ vars.${variable} }}`));
    assert.ok(app.includes(`param ${parameter} string`));
    assert.ok(app.includes(`name: '${variable}'\n    value: ${parameter}`));
    if (parameter !== "storagePartitionKey")
      assert.ok(template.includes(`param ${parameter} string`));
  }
  for (const source of [template, app]) {
    assert.match(
      source,
      /@minLength\(3\)\s+@maxLength\(24\)\s+param storageAccountName string\s*\n/,
    );
    assert.doesNotMatch(source, /(?:var|param) storageAccountName[^\n]*=/);
    assert.doesNotMatch(
      source,
      /DATABASE_URL|AZURE_STORAGE_CONNECTION_STRING|postgresPassword|listKeys|migrate\.js/,
    );
  }
  assert.match(app, /@minLength\(1\)\s+@maxLength\(256\)\s+param storagePartitionKey string\s*\n/);
  assert.doesNotMatch(app, /(?:var|param) storagePartitionKey[^\n]*=/);
  assert.match(template, /parent: tableService\s+name: storageTableName/);
  assert.match(template, /parent: blobService\s+name: storageContainerName/);
  assert.match(template, /output storageAccountName string = storage.name/);
  assert.match(template, /output storageTableName string = table.name/);
  assert.match(template, /output storageContainerName string = container.name/);
  assert.match(template, /minimumTlsVersion: 'TLS1_2'/);
  assert.match(template, /supportsHttpsTrafficOnly: true/);
  assert.match(template, /allowBlobPublicAccess: false/);
  assert.match(template, /allowSharedKeyAccess: false/);
  assert.match(template, /publicAccess: 'None'/);
  for (const [role, definition] of [
    ["blobRole", "ba92f5b4-2d11-453d-a403-e96b0029c9fe"],
    ["tableRole", "0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3"],
  ]) {
    const block = template
      .slice(template.indexOf(`resource ${role} `))
      .split(/\nresource |\noutput /)[0];
    assert.match(block, /scope: storage/);
    assert.match(block, /principalId: storageIdentity.properties.principalId/);
    assert.match(block, /principalType: 'ServicePrincipal'/);
    assert.ok(block.includes(definition));
  }
  assert.match(app, /name: 'STORAGE_PROVIDER'\s+value: 'azure'/);
  assert.match(app, /name: 'AZURE_CLIENT_ID'\s+value: storageIdentity.properties.clientId/);
  assert.match(
    app,
    /type: 'UserAssigned'\s+userAssignedIdentities: \{\s+'\$\{storageIdentity.id\}': \{\}/,
  );
  assert.match(app, /param initializeStorage bool = false/);
  assert.match(app, /name: 'AZURE_STORAGE_INITIALIZE'\s+value: 'false'/);
  assert.match(
    app,
    /name: 'AZURE_STORAGE_INITIALIZE'\s+value: initializeStorage \? 'true' : 'false'/,
  );
  assert.match(app, /name: 'initialize-storage'\s+image: image/);
  assert.match(app, /'apps\/server\/dist\/initialize-storage.js'/);
  assert.match(app, /env: initializationEnv/);
  assert.match(app, /var initializationEnv = concat\(storageEnv/);
  assert.match(app, /var appEnv = concat\(\s+storageEnv/);
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
  assert.match(source, /^ARG APP_BUILD_INDEX="0"$/m);
  assert.match(source, /APP_BUILD_INDEX=\$\{APP_BUILD_INDEX\}/);
  assert.match(source, /COPY --from=build --chown=node:node \/app\/package\.json /);
  assert.doesNotMatch(source, /version\.json/);
});

test("SQL-only Compose and operational entrypoints are retired without replacing the runtime image", async () => {
  for (const path of [
    "compose.yaml",
    "compose.external-db.yaml",
    "compose.postgres-tools.yaml",
    ".github/workflows/migrate-postgres-to-azure.yml",
    "scripts/local-postgres.mjs",
    "scripts/verify-production-compose.mjs",
    "scripts/verify-postgres-backup.mjs",
    "scripts/postgres-backup-common.sh",
    "scripts/postgres-backup.sh",
    "scripts/postgres-restore.sh",
    "scripts/postgres-restore-test.sh",
    "scripts/postgres-backup-contracts.test.mjs",
    "scripts/production-postgres-migration.mjs",
    "scripts/production-postgres-migration-runtime.mjs",
    "scripts/production-postgres-migration.test.mjs",
    "scripts/production-postgres-migration-runtime.test.mjs",
  ]) {
    await assert.rejects(read(path), { code: "ENOENT" }, path);
  }
  const dockerfile = await read("Dockerfile");
  assert.match(dockerfile, /CMD \["node", "apps\/server\/dist\/main\.js"\]/);
  assert.doesNotMatch(dockerfile, /postgres|pg_dump|pg_restore/i);
});

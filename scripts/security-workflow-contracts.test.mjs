/* global URL */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const deploymentEnvironment = {
  AZURE_SUBSCRIPTION_ID: "11111111-1111-4111-8111-111111111111",
  AZURE_RESOURCE_GROUP: "test-group",
  AZURE_LOCATION: "northeurope",
  AZURE_NAME_PREFIX: "testapp",
  AZURE_STORAGE_ACCOUNT_NAME: "testappstorage",
  AZURE_STORAGE_TABLE_NAME: "MafiaEntities",
  AZURE_STORAGE_CONTAINER_NAME: "mafia-live",
  AZURE_STORAGE_PARTITION_KEY: "production-v1",
  DEPLOY_IMAGE: `ghcr.io/example/mafia-dashboard@sha256:${"a".repeat(64)}`,
  INITIALIZE_STORAGE: "false",
};
const storageIdentityId = `/subscriptions/${deploymentEnvironment.AZURE_SUBSCRIPTION_ID}/resourceGroups/${deploymentEnvironment.AZURE_RESOURCE_GROUP}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/testapp-storage`;
const storageClientId = "22222222-2222-4222-8222-222222222222";
const commit = "a".repeat(40);

function workflowStep(source, name) {
  const start = source.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `workflow must retain ${name}`);
  return source.slice(start).split(/\n {6}- /)[0];
}

function workflowScript(source, name) {
  const block = workflowStep(source, name).split("        run: |\n")[1];
  assert.ok(block, `${name} must have an executable shell block`);
  return block.replace(/^ {10}/gm, "");
}

function runShell(script, env) {
  const result = spawnSync("/bin/bash", ["-c", script], {
    cwd: root,
    env: { PATH: process.env.PATH, ...deploymentEnvironment, ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  return result;
}

function deploymentConfiguration(initialize = "false") {
  const storageEnv = [
    { name: "STORAGE_PROVIDER", value: "azure" },
    ...[
      "AZURE_STORAGE_ACCOUNT_NAME",
      "AZURE_STORAGE_TABLE_NAME",
      "AZURE_STORAGE_CONTAINER_NAME",
      "AZURE_STORAGE_PARTITION_KEY",
    ].map((name) => ({ name, value: deploymentEnvironment[name] })),
    { name: "AZURE_CLIENT_ID", value: storageClientId },
  ];
  return {
    provisioningState: "Succeeded",
    minReplicas: 1,
    maxReplicas: 1,
    targetPort: 3000,
    image: deploymentEnvironment.DEPLOY_IMAGE,
    initImage: deploymentEnvironment.DEPLOY_IMAGE,
    identity: {
      type: "UserAssigned",
      userAssignedIdentities: { [storageIdentityId]: { clientId: storageClientId } },
    },
    // Keep app and init entries independent so a single-container mismatch cannot
    // be hidden by the other container's validation.
    env: [
      ...storageEnv.map((entry) => ({ ...entry })),
      { name: "AZURE_STORAGE_INITIALIZE", value: "false" },
    ],
    initEnv: [
      ...storageEnv.map((entry) => ({ ...entry })),
      { name: "AZURE_STORAGE_INITIALIZE", value: initialize },
    ],
  };
}

function readbackFixture(source) {
  const block = workflowScript(source, "Verify Azure deployment");
  assert.ok(
    block.includes('const { version } = JSON.parse(readFileSync("package.json", "utf8"));'),
  );
  const fixture = block
    .replace(
      'const { version } = JSON.parse(readFileSync("package.json", "utf8"));',
      'const version = "2.7.9";',
    )
    .replaceAll("${{ steps.app.outputs.public_url }}", "https://mafia.example.test");
  return `
    az() { printf '%s\\n' "$MOCK_CONFIGURATION"; }
    curl() { if [[ "$*" == *"/health/version"* ]]; then printf '%s\\n' "$MOCK_IDENTITY"; else return "$MOCK_READY_STATUS"; fi; }
    sleep() { :; }
    ${fixture}
  `;
}

function runReadback(script, configuration, identity = { version: "2.7.123", commit }, env = {}) {
  return runShell(script, {
    APP_NAME: "testapp-app",
    GITHUB_SHA: commit,
    GITHUB_RUN_NUMBER: "123",
    MOCK_CONFIGURATION: JSON.stringify(configuration),
    MOCK_IDENTITY: JSON.stringify(identity),
    MOCK_READY_STATUS: "0",
    ...env,
  });
}

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

  assert.deepEqual(workflows, ["ci.yml", "deploy-azure.yml", "migrate-postgres-to-azure.yml"]);
  assert.match(ci, /^on:\n\s{2}pull_request:\n\npermissions:/m);
  assert.match(ci, /npm run ci:install[\s\S]*npm run check/);
  assert.match(deploy, /^on:\n\s{2}push:\n\s{4}branches: \[main\]\n\s{2}workflow_dispatch:/m);
});

test("every external workflow action is pinned to an immutable commit", async () => {
  const directory = new URL(".github/workflows/", root);
  const workflows = (await readdir(directory)).filter((name) => name.endsWith(".yml"));
  assert.equal(workflows.length, 3);

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
  assert.match(publish, /build-args:[\s\S]*APP_BUILD_INDEX=\$\{\{ github\.run_number \}\}/);
  assert.match(publish, /docker buildx imagetools inspect "\$IMAGE_REF"/);
  assert.match(publish, /image_ref="\$\{IMAGE_REF%:\*\}@\$digest"/);
  assert.match(publish, /docker push/);
  assert.match(deploy, /permissions:\n\s{6}contents: read\n\s{6}id-token: write/);
  assert.doesNotMatch(deploy, /packages: write/);
  assert.match(deploy, /DEPLOY_IMAGE: \$\{\{ needs\.publish\.outputs\.image \}\}/);
  assert.match(deploy, /image="\$DEPLOY_IMAGE"/);
  assert.match(deploy, /\/health\/version/);
  assert.match(deploy, /--arg commit "\$GITHUB_SHA"/);
  assert.match(deploy, /composeAppVersion\(version, process\.env\.GITHUB_RUN_NUMBER\)/);
  assert.match(deploy, /--arg version "\$expected_version"/);
  assert.match(deploy, /\.version == \$version and \.commit == \$commit/);
  assert.doesNotMatch(deploy, /\.version \| test\(/);
  assert.match(deploy, /health\/version" 2>\/dev\/null \|\| true/);
  assert.match(deploy, /az containerapp revision list/);
  assert.match(deploy, /az containerapp logs show/);
  assert.match(deploy, /--revision "\$failed_revision"/);
  assert.match(deploy, /--container initialize-storage/);
  assert.doesNotMatch(deploy, /--container migrate|POSTGRES_PASSWORD|AZURE_DATABASE_NAME/);
  assert.match(
    publish,
    /if: >-\n\s+github.event_name == 'workflow_dispatch' \|\|\n\s+vars.AZURE_DEPLOY_ENABLED == 'true'/,
  );
  assert.match(deploy, /needs: publish/);
  assert.match(deploy, /environment: production/);
  assert.match(
    deploy,
    /if: >-\n\s+\(github.event_name == 'workflow_dispatch' && inputs.deploy\) \|\|\n\s+\(github.event_name == 'push' && vars.AZURE_DEPLOY_ENABLED == 'true'\)\n\s+runs-on:/,
  );
  assert.doesNotMatch(
    publish,
    /azure\/login|secrets\.GHCR_PULL_TOKEN|secrets\.GOOGLE_CLIENT_SECRET|secrets\.MUSIC_TOKEN_ENCRYPTION_KEY/,
  );
  assert.match(publish, /if \[\[ "\$remote_digest" != "\$digest" \]\]/);
  assert.doesNotMatch(deploy, /image="ghcr\.io\/\$\{GITHUB_REPOSITORY\}:\$\{GITHUB_SHA\}"/);
});

test("Azure readback accepts only the configured version and exact commit", async () => {
  const script = readbackFixture(await read(".github/workflows/deploy-azure.yml"));
  for (const [identity, expectedStatus] of [
    [{ version: "2.7.123", commit }, 0],
    [{ version: "2.7.124", commit }, 1],
    [{ version: "2.7.123", commit: "b".repeat(40) }, 1],
    [{ version: "1.0.123", commit }, 1],
    [{ version: "2.7.123" }, 1],
    [{ commit }, 1],
    [null, 1],
  ]) {
    const result = runReadback(script, deploymentConfiguration(), identity);
    assert.equal(result.status, expectedStatus, result.stderr);
  }
  const notReady = runReadback(script, deploymentConfiguration(), undefined, {
    MOCK_READY_STATUS: "1",
  });
  assert.equal(notReady.status, 1, "version identity cannot bypass failed readiness");
});

test("Azure readback rejects wrong provider, namespace, identity, images and initialization", async () => {
  const script = readbackFixture(await read(".github/workflows/deploy-azure.yml"));
  for (const initialize of ["false", "true"]) {
    const result = runReadback(script, deploymentConfiguration(initialize), undefined, {
      INITIALIZE_STORAGE: initialize,
    });
    assert.equal(result.status, 0, result.stderr);
  }
  const mutations = [
    ...Object.entries({
      provisioningState: "Failed",
      minReplicas: 0,
      maxReplicas: 2,
      targetPort: 5432,
      image: `ghcr.io/example/mafia-dashboard@sha256:${"b".repeat(64)}`,
      initImage: `ghcr.io/example/mafia-dashboard@sha256:${"b".repeat(64)}`,
    }).map(([key, value]) => [
      key,
      (configuration) => {
        configuration[key] = value;
      },
    ]),
    [
      "system-assigned identity",
      (configuration) => {
        configuration.identity.type = "SystemAssigned";
      },
    ],
    [
      "missing identity",
      (configuration) => {
        delete configuration.identity;
      },
    ],
    [
      "wrong identity",
      (configuration) => {
        configuration.identity.userAssignedIdentities = {
          [`${storageIdentityId}-other`]: { clientId: storageClientId },
        };
      },
    ],
    [
      "extra identity",
      (configuration) => {
        configuration.identity.userAssignedIdentities[`${storageIdentityId}-other`] = {
          clientId: storageClientId,
        };
      },
    ],
    [
      "missing client ID",
      (configuration) => {
        delete configuration.identity.userAssignedIdentities[storageIdentityId].clientId;
      },
    ],
    [
      "empty client ID",
      (configuration) => {
        configuration.identity.userAssignedIdentities[storageIdentityId].clientId = "";
      },
    ],
    [
      "web initialization",
      (configuration) => {
        configuration.env.find(({ name }) => name === "AZURE_STORAGE_INITIALIZE").value = "true";
      },
    ],
    [
      "unrequested initialization",
      (configuration) => {
        configuration.initEnv.find(({ name }) => name === "AZURE_STORAGE_INITIALIZE").value =
          "true";
      },
    ],
  ];
  for (const field of ["env", "initEnv"]) {
    for (const name of [
      "STORAGE_PROVIDER",
      "AZURE_STORAGE_ACCOUNT_NAME",
      "AZURE_STORAGE_TABLE_NAME",
      "AZURE_STORAGE_CONTAINER_NAME",
      "AZURE_STORAGE_PARTITION_KEY",
      "AZURE_CLIENT_ID",
    ]) {
      mutations.push([
        `${field} wrong ${name}`,
        (configuration) => {
          configuration[field].find((entry) => entry.name === name).value = "other";
        },
      ]);
      mutations.push([
        `${field} missing ${name}`,
        (configuration) => {
          configuration[field] = configuration[field].filter((entry) => entry.name !== name);
        },
      ]);
    }
    for (const name of ["DATABASE_URL", "AZURE_STORAGE_CONNECTION_STRING"]) {
      mutations.push([
        `${field} forbidden ${name}`,
        (configuration) => {
          configuration[field].push({ name, value: "" });
        },
      ]);
    }
  }
  for (const [name, mutate] of mutations) {
    const configuration = deploymentConfiguration();
    mutate(configuration);
    const result = runReadback(script, configuration);
    assert.equal(result.status, 1, `must reject ${name}: ${result.stderr}`);
  }
  const missingInitialization = runReadback(script, deploymentConfiguration(), undefined, {
    INITIALIZE_STORAGE: "true",
  });
  assert.equal(
    missingInitialization.status,
    1,
    "requested initialization must be read back exactly",
  );
});

test("Azure passes one explicit managed-identity Storage target through every deployment path", async () => {
  const [workflow, template, app] = await Promise.all([
    read(".github/workflows/deploy-azure.yml"),
    read("infra/main.bicep"),
    read("infra/app.bicep"),
  ]);
  const fields = [
    ["storageAccountName", "AZURE_STORAGE_ACCOUNT_NAME"],
    ["storageTableName", "AZURE_STORAGE_TABLE_NAME"],
    ["storageContainerName", "AZURE_STORAGE_CONTAINER_NAME"],
    ["storagePartitionKey", "AZURE_STORAGE_PARTITION_KEY"],
  ];
  const invocations = workflow.match(
    /az deployment group (?:validate|what-if|create)[\s\S]*?--output (?:none|json)/g,
  );
  assert.equal(invocations?.length, 4);
  for (const [parameter, variable] of fields) {
    assert.ok(workflow.includes(`${variable}: \${{ vars.${variable} }}`));
    for (const invocation of invocations) {
      if (parameter === "storagePartitionKey" && !invocation.includes("infra/app.bicep")) continue;
      assert.ok(invocation.includes(`${parameter}="$${variable}"`), `explicit ${parameter}`);
    }
    assert.ok(app.includes(`param ${parameter} string`));
    assert.ok(app.includes(`name: '${variable}'\n    value: ${parameter}`));
    if (parameter !== "storagePartitionKey") {
      assert.ok(template.includes(`param ${parameter} string`));
      assert.match(workflow, new RegExp(`\\.outputs\\.${parameter}\\.value == \\$`));
    }
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
  assert.match(workflow, /initializeStorage="\$INITIALIZE_STORAGE"/);
  assert.match(
    workflow,
    /initialize_storage:\n\s+description: [^\n]+\n\s+type: boolean\n\s+default: false/,
  );
  assert.match(
    workflow,
    /INITIALIZE_STORAGE: \$\{\{ github.event_name == 'workflow_dispatch' && inputs.initialize_storage == true \}\}/,
  );
  assert.match(
    workflow,
    /echo "- Storage: \$AZURE_STORAGE_ACCOUNT_NAME \/ \$AZURE_STORAGE_TABLE_NAME \/ \$AZURE_STORAGE_CONTAINER_NAME \/ \$AZURE_STORAGE_PARTITION_KEY"/,
  );
});

test("Azure applies foundation conditionally and application separately", async () => {
  const source = await read(".github/workflows/deploy-azure.yml");
  assert.match(
    source,
    /deploy_infrastructure:\n\s+description: [^\n]+\n\s+type: boolean\n\s+default: false/,
  );
  assert.match(source, /concurrency:\n\s+group: azure-production\n\s+cancel-in-progress: false/);
  assert.match(source, /github.event_name == 'workflow_dispatch' && inputs.deploy/);
  assert.match(source, /node scripts\/azure-deployment-plan.mjs/);
  for (const name of [
    "Refuse unknown Storage account adoption",
    "Validate foundation",
    "Inspect foundation changes",
    "Deploy foundation",
  ]) {
    const step = workflowStep(source, name);
    assert.match(step, /if: steps\.plan\.outputs\.deploy == 'true'/, name);
  }
  const target = workflowStep(source, "Verify existing deployment target");
  assert.doesNotMatch(target, /\n\s+if:/);
  assert.match(target, /az account show --query id --output tsv\).*== "\$AZURE_SUBSCRIPTION_ID"/);
  assert.match(target, /az group show --name "\$AZURE_RESOURCE_GROUP" --output none/);
  assert.match(
    target,
    /\$AZURE_SUBSCRIPTION_ID\/resourceGroups\/\$AZURE_RESOURCE_GROUP\/providers\/Microsoft.App\/managedEnvironments\/\$\{AZURE_NAME_PREFIX\}-env/,
  );
  assert.match(target, /\[\[ "\$\{environment_id,,\}" == "\$\{expected_environment,,\}" \]\]/);
  assert.match(target, /workloadProfileType == 'Consumption'/);
  assert.match(target, /\[\[ -n "\$profile" && "\$profile" != 'null' \]\]/);
  assert.ok(source.indexOf(target) < source.indexOf("      - name: Validate foundation\n"));
  assert.doesNotMatch(source, /az group (?:create|delete)|az (?:postgres|network)|--mode Complete/);
  const foundation = source.slice(
    source.indexOf("      - name: Deploy foundation\n"),
    source.indexOf("      - name: Deploy application\n"),
  );
  assert.match(foundation, /--name "mafia-foundation"/);
  assert.match(foundation, /foundationFingerprint="\$FOUNDATION_FINGERPRINT"/);
  assert.match(foundation, /--mode Incremental/);
  const app = source.slice(
    source.indexOf("      - name: Deploy application\n"),
    source.indexOf("      - name: Verify Azure deployment\n"),
  );
  assert.match(app, /--template-file infra\/app.bicep/);
  assert.match(app, /--mode Incremental/);
  assert.doesNotMatch(workflowStep(source, "Deploy application"), /\n\s+if:/);
  assert.doesNotMatch(app, /--template-file infra\/main.bicep|deployApp=/);
  assert.doesNotMatch(source, /deployApp=|--mode Complete/);
});

test("Azure rejects missing or unsafe Storage inputs before resource mutation without echoing secrets", async () => {
  const source = await read(".github/workflows/deploy-azure.yml");
  const script = workflowScript(source, "Validate deployment inputs");
  assert.ok(
    source.indexOf("      - name: Validate deployment inputs\n") <
      source.indexOf("      - name: Select infrastructure deployment\n"),
  );
  assert.doesNotMatch(script, /\baz\b/);
  const environment = {
    GHCR_USERNAME: "testuser",
    GHCR_TOKEN: "test-fixture-token",
    GOOGLE_CLIENT_SECRET: "test-fixture-google-secret",
    MUSIC_TOKEN_ENCRYPTION_KEY: "test-fixture-music-key",
  };
  const invalid = {
    AZURE_STORAGE_ACCOUNT_NAME: [
      undefined,
      "",
      " ",
      "Uppercase",
      "a-b",
      "aa",
      "a".repeat(25),
      "a/b",
      "a?b",
      "a\nb",
      "$(exit 0)",
    ],
    AZURE_STORAGE_TABLE_NAME: [
      undefined,
      "",
      " ",
      "1table",
      "a-b",
      "aa",
      "a".repeat(64),
      "a/b",
      "a?b",
      "a\nb",
      "$(exit 0)",
    ],
    AZURE_STORAGE_CONTAINER_NAME: [
      undefined,
      "",
      " ",
      "Uppercase",
      "a--b",
      "ab",
      "-abc",
      "abc-",
      "a".repeat(64),
      "a/b",
      "a?b",
      "a\nb",
      "$(exit 0)",
    ],
    AZURE_STORAGE_PARTITION_KEY: [
      undefined,
      "",
      "a/b",
      "a\\b",
      "a?b",
      "a#b",
      "a\nb",
      "a\u007fb",
      "a\u0085b",
      "a".repeat(257),
    ],
    AZURE_SUBSCRIPTION_ID: [undefined, "", "a\nb"],
    AZURE_RESOURCE_GROUP: [undefined, "", "a\nb"],
    AZURE_LOCATION: [undefined, "", "a\nb"],
    AZURE_NAME_PREFIX: [undefined, "", "Uppercase", "1app", "aa", "a".repeat(19), "a\nb"],
    DEPLOY_IMAGE: [
      undefined,
      "",
      "ghcr.io/example/mafia-dashboard:main",
      "sha256:fixture",
      `ghcr.io/example/mafia-dashboard@sha256:${"a".repeat(63)}`,
    ],
    INITIALIZE_STORAGE: [undefined, "", "TRUE", "1", "$(exit 0)"],
    GHCR_USERNAME: [undefined, ""],
    GHCR_TOKEN: [undefined, ""],
  };
  for (const [key, values] of Object.entries(invalid)) {
    for (const value of values) {
      // Bash distinguishes absent and empty inputs; test both without ambient Azure credentials.
      const unset = value === undefined ? `unset ${key}\n` : "";
      const result = runShell(unset + script, {
        ...environment,
        ...(value === undefined ? {} : { [key]: value }),
      });
      assert.equal(
        result.status,
        1,
        `must reject ${key}=${JSON.stringify(value)}: ${result.stderr}`,
      );
      assert.match(result.stderr, new RegExp(key === "GHCR_TOKEN" ? "GHCR_PULL_TOKEN" : key));
      assert.doesNotMatch(result.stdout + result.stderr, /test-fixture/);
    }
  }
  for (const inputs of [
    {},
    { INITIALIZE_STORAGE: "true" },
    {
      AZURE_STORAGE_ACCOUNT_NAME: "a".repeat(24),
      AZURE_STORAGE_TABLE_NAME: "a".repeat(63),
      AZURE_STORAGE_CONTAINER_NAME: "a".repeat(63),
      AZURE_STORAGE_PARTITION_KEY: "a".repeat(256),
    },
    {
      AZURE_STORAGE_ACCOUNT_NAME: "abc",
      AZURE_STORAGE_TABLE_NAME: "Abc",
      AZURE_STORAGE_CONTAINER_NAME: "a-b",
      AZURE_STORAGE_PARTITION_KEY: "x",
    },
  ]) {
    const result = runShell(script, { ...environment, ...inputs });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout + result.stderr, "");
  }
});

test("Azure refuses unrecorded Storage adoption and unavailable account names", async () => {
  const script = workflowScript(
    await read(".github/workflows/deploy-azure.yml"),
    "Refuse unknown Storage account adoption",
  );
  const fixture = `
    az() {
      case "$1 $2 $3" in
        'storage account list') printf '%s\\n' "$MOCK_EXISTING" ;;
        'deployment group show') if [[ "$MOCK_RECORD" == 'lookup-failure' ]]; then return 7; fi; printf '%s\\n' "$MOCK_RECORD" ;;
        'storage account check-name') printf '%s\\n' "$MOCK_AVAILABLE" ;;
        *) return 9 ;;
      esac
    }
    ${script}
  `;
  const record = { state: "Succeeded", account: "testappstorage", app: "testapp-app" };
  for (const [existing, recorded, available, expected] of [
    ["", record, "true", 0],
    ["null", record, "true", 0],
    ["", record, "false", 1],
    ["", record, "", 1],
    ["testappstorage", record, "false", 0],
    ["testappstorage", { ...record, state: "Failed" }, "true", 1],
    ["testappstorage", { ...record, account: "otherstorage" }, "true", 1],
    ["testappstorage", { ...record, app: "other-app" }, "true", 1],
    ["testappstorage", {}, "true", 1],
    ["testappstorage", null, "true", 1],
    ["testappstorage", "lookup-failure", "true", 7],
  ]) {
    const result = runShell(fixture, {
      MOCK_EXISTING: existing,
      MOCK_RECORD: recorded === "lookup-failure" ? recorded : JSON.stringify(recorded),
      MOCK_AVAILABLE: available,
    });
    assert.equal(result.status, expected, result.stderr);
  }
});

test("Azure what-if rejects deletes and changes to retained SQL, network or environment", async () => {
  const step = workflowStep(
    await read(".github/workflows/deploy-azure.yml"),
    "Inspect foundation changes",
  );
  assert.match(step, /az deployment group what-if[\s\S]*--mode Incremental/);
  const predicate = step.match(
    /jq --exit-status '\n([\s\S]*?)\n\s+' "\$RUNNER_TEMP\/foundation-what-if.json" >\/dev\/null/,
  );
  assert.ok(
    predicate,
    "the actual what-if rejection predicate must run before foundation mutation",
  );
  const storage =
    "/subscriptions/test/resourceGroups/test/providers/Microsoft.Storage/storageAccounts/testappstorage";
  const changes = (resourceId, changeType) => ({
    status: "Succeeded",
    changes: [{ resourceId, changeType }],
  });
  for (const [payload, expected] of [
    [{ status: "Succeeded", changes: [] }, 0],
    [changes(storage, "Create"), 0],
    [changes(`${storage}/blobServices/default/containers/mafia-live`, "Create"), 0],
    [
      changes(
        "/subscriptions/test/resourceGroups/test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/testapp-storage",
        "Create",
      ),
      0,
    ],
    [changes(`${storage}/providers/Microsoft.Authorization/roleAssignments/fixture`, "Create"), 0],
    [changes(storage, "Delete"), 1],
    [changes("/providers/Microsoft.DBforPostgreSQL/flexibleServers/retained", "Modify"), 1],
    [changes("/providers/Microsoft.Network/virtualNetworks/retained", "Modify"), 1],
    [changes("/providers/Microsoft.App/managedEnvironments/retained", "Modify"), 1],
    [changes("/providers/Microsoft.Network/virtualNetworks/retained", "Delete"), 1],
    [changes("/providers/Microsoft.DBforPostgreSQL/flexibleServers/retained", "NoChange"), 0],
    [{ status: "Failed", changes: [] }, 1],
    [{ status: "Succeeded" }, 1],
    [{ status: "Succeeded", changes: {} }, 1],
  ]) {
    const result = spawnSync("jq", ["--exit-status", predicate[1]], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, expected, result.stderr);
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
  assert.match(source, /^ARG APP_BUILD_INDEX="0"$/m);
  assert.match(source, /APP_BUILD_INDEX=\$\{APP_BUILD_INDEX\}/);
  assert.match(source, /COPY --from=build --chown=node:node \/app\/package\.json /);
  assert.doesNotMatch(source, /version\.json/);
});

test("Compose passes source identity into immutable application builds", async () => {
  const [compose, verifier] = await Promise.all([
    read("compose.yaml"),
    read("scripts/verify-production-compose.mjs"),
  ]);

  assert.match(compose, /APP_COMMIT: \$\{APP_COMMIT:-unknown\}/);
  assert.match(compose, /APP_BUILD_INDEX: \$\{APP_BUILD_INDEX:-0\}/);
  assert.doesNotMatch(compose, /^\s{6}APP_BUILD_INDEX: /m);
  assert.match(verifier, /status.*--porcelain.*--untracked-files=no/s);
  assert.match(verifier, /trackedStatus.*\? appCommitResult\.stdout\.trim\(\) : "unknown"/s);
  assert.match(verifier, /APP_COMMIT: appCommit/);
  assert.match(verifier, /APP_BUILD_INDEX: buildIndex/);
  assert.match(verifier, /composeAppVersion\(packageVersion, buildIndex\)/);
  assert.doesNotMatch(verifier, /version\.json/);
  assert.match(verifier, /\/health\/version/);
});

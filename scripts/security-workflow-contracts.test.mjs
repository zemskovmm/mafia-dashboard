/* global URL */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const assertBlockingScan = (source, type) =>
  assert.match(source, new RegExp(`scan-type: ${type}[\\s\\S]{0,400}?exit-code: 1`));

test("root scripts expose deterministic security gates", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const { scripts } = packageJson;

  assert.equal(packageJson.scripts["audit:security"], "npm audit --audit-level=high");
  assert.equal(scripts["ci:install"], "npm ci --ignore-scripts && npm rebuild esbuild");
  assert.equal(
    scripts["test:security-contracts"],
    "node --test scripts/security-workflow-contracts.test.mjs",
  );
  assert.equal(
    scripts["check:verified"],
    "npm run format:check && npm run lint && npm run typecheck && npm run test && npm run build",
  );
  assert.equal(scripts.check, "npm run audit:security && npm run check:verified");
  assert.match(scripts.test, /test:security-contracts/);
  assert.equal(packageJson.allowScripts, undefined);
});

test("CI and deployment audit once before scriptless install and deterministic checks", async () => {
  for (const workflow of ["ci.yml", "deploy-azure.yml"]) {
    const source = await read(`.github/workflows/${workflow}`);
    assert.match(
      source,
      /npm run audit:security[\s\S]*npm run ci:install[\s\S]*npm run check:verified/,
    );
    assert.doesNotMatch(source, /^\s*- run: npm run check$/m);
  }
});

test("every external workflow action is pinned to an immutable commit", async () => {
  const directory = new URL(".github/workflows/", root);
  const workflows = (await readdir(directory)).filter((name) => name.endsWith(".yml"));
  assert.ok(workflows.length >= 3, "expected CI, deployment, and security workflows");

  for (const workflow of workflows) {
    const source = await read(`.github/workflows/${workflow}`);
    assert.doesNotMatch(source, /^\s*-\s*run:\s*npm ci\s*$/gm);
    const installIndex = source.indexOf("npm run ci:install");
    if (installIndex !== -1) {
      const auditIndex = source.indexOf("npm run audit:security");
      assert.ok(
        auditIndex !== -1 && auditIndex < installIndex,
        `${workflow} must audit the lockfile before dependency lifecycle execution`,
      );
    }
    for (const match of source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
      const action = match[1];
      if (action.startsWith("./")) continue;
      assert.match(action, /@[0-9a-f]{40}$/i, `${workflow} must pin ${action} to a commit`);
    }
  }
});

test("security workflow blocks dependency, repository, and image findings", async () => {
  const source = await read(".github/workflows/security.yml");

  for (const trigger of ["pull_request:", "push:", "schedule:", "workflow_dispatch:"]) {
    assert.match(source, new RegExp(`^\\s{2}${trigger.replace(":", "\\:")}`, "m"));
  }
  assert.match(source, /^permissions:\n\s{2}contents: read$/m);
  assert.match(source, /npm run audit:security/);
  assert.match(source, /npm run ci:install/);
  assert.match(source, /npm run lint/);
  assertBlockingScan(source, "fs");
  assert.match(source, /scanners: vuln,secret,misconfig/);
  assertBlockingScan(source, "image");
  assert.match(source, /severity: HIGH,CRITICAL/);
  assert.equal(source.match(/version: v0\.74\.0/g)?.length, 2);
  assert.match(source, /docker\/build-push-action@[0-9a-f]{40}/i);
  assert.match(source, /build-args:[\s\S]*APP_COMMIT=\$\{\{ github\.sha \}\}/);
  assert.match(source, /aquasecurity\/trivy-action@[0-9a-f]{40}/i);
});

test("Azure publish scans the exact image before pushing with least privilege", async () => {
  const source = await read(".github/workflows/deploy-azure.yml");
  const publishStart = source.indexOf("\n  publish:\n");
  const deployStart = source.indexOf("\n  deploy:\n", publishStart);
  const publish = source.slice(publishStart, deployStart);
  const deploy = source.slice(deployStart);

  assert.match(source, /^permissions:\n\s{2}contents: read$/m);
  assert.match(source.slice(0, publishStart), /npm run audit:security/);
  assertBlockingScan(source.slice(0, publishStart), "fs");
  assert.match(publish, /permissions:\n\s{6}contents: read\n\s{6}packages: write/);
  assert.doesNotMatch(publish, /id-token: write/);
  assert.match(publish, /load: true/);
  assert.doesNotMatch(publish, /push: true/);
  assertBlockingScan(publish, "image");
  assert.match(publish, /outputs:\n\s{6}image: \$\{\{ steps\.publish\.outputs\.image \}\}/);
  assert.match(publish, /id: publish/);
  assert.match(publish, /build-args:[\s\S]*APP_COMMIT=\$\{\{ github\.sha \}\}/);
  assert.match(publish, /docker buildx imagetools inspect "\$IMAGE_REF"/);
  assert.match(publish, /image_ref="\$\{IMAGE_REF%:\*\}@\$digest"/);
  assert.match(publish, /docker push/);
  assert.ok(publish.indexOf("scan-type: image") < publish.indexOf("docker push"));
  assert.match(deploy, /permissions:\n\s{6}contents: read\n\s{6}id-token: write/);
  assert.doesNotMatch(deploy, /packages: write/);
  assert.match(deploy, /DEPLOY_IMAGE: \$\{\{ needs\.publish\.outputs\.image \}\}/);
  assert.match(deploy, /image="\$DEPLOY_IMAGE"/);
  assert.match(deploy, /\/health\/version/);
  assert.match(deploy, /--arg commit "\$GITHUB_SHA"/);
  assert.match(deploy, /health\/version" 2>\/dev\/null \|\| true/);
  assert.match(deploy, /az containerapp revision list/);
  assert.match(deploy, /az containerapp logs show/);
  assert.doesNotMatch(deploy, /image="ghcr\.io\/\$\{GITHUB_REPOSITORY\}:\$\{GITHUB_SHA\}"/);
});

test("ESLint loads repository-owned security rules", async () => {
  const source = await read("eslint.config.js");

  assert.match(source, /eslint-plugin-security/);
  assert.match(source, /eslint-plugin-no-unsanitized/);
});

test("runtime image refreshes OS fixes and omits package managers", async () => {
  const source = await read("Dockerfile");

  assert.equal(source.match(/^FROM node:22-alpine@sha256:[0-9a-f]{64} AS /gm)?.length, 2);
  assert.match(source, /^RUN npm run audit:security$/m);
  assert.ok(
    source.indexOf("RUN npm run audit:security") < source.indexOf("RUN npm run ci:install"),
    "the image build must audit the lockfile before dependency lifecycle execution",
  );
  assert.match(source, /RUN apk upgrade --no-cache/);
  assert.match(source, /\/usr\/local\/lib\/node_modules\/(?:npm|corepack)/);
  assert.match(source, /\/usr\/local\/bin\/(?:npm|npx|corepack)/);
  assert.match(source, /\/opt\/yarn-v\*/);
  assert.match(source, /\/usr\/local\/bin\/(?:yarn|yarnpkg)/);
  assert.match(source, /\/sbin\/apk/);
  assert.match(source, /RUN npm run ci:install/);
  assert.match(source, /npm prune --omit=dev --ignore-scripts/);
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

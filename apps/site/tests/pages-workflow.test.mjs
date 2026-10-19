import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

test("website publication is manual, main-only and uploads only the static site", () => {
  const file = new URL("../../../.github/workflows/deploy-site-pages.yml", import.meta.url);
  assert.ok(existsSync(file), "A separate manual website publication workflow is required");
  const workflow = readFileSync(file, "utf8");
  assert.match(workflow, /on:\s*\n {2}workflow_dispatch:/);
  assert.doesNotMatch(
    workflow,
    /^\s+(push|pull_request|pull_request_target|schedule|workflow_run):/m,
  );
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /path: apps\/site\/dist/);
  assert.match(workflow, /npm run build -w @mafia\/site/);
  assert.match(workflow, /enablement: false/);
  for (const [, reference] of workflow.matchAll(/uses: ([^\s]+)/g)) {
    assert.match(reference, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
  }
  assert.doesNotMatch(workflow, /azure\/login|docker\/build-push-action/);
});

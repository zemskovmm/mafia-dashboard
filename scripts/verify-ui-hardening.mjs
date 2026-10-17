import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const evidenceDir = resolve(
  process.env.UI_MATRIX_EVIDENCE_DIR ?? ".AI/qa/ui-followup/browser/hardening-matrix",
);
mkdirSync(evidenceDir, { recursive: true });

const cases = [
  { name: "laptop-1366x768", browser: "chromium", width: 1366, height: 768 },
  { name: "ipad-1366x1024", browser: "webkit", width: 1366, height: 1024 },
  { name: "compact-tablet-1000x600", browser: "chromium", width: 1000, height: 600 },
  { name: "webkit-compact-tablet-1000x600", browser: "webkit", width: 1000, height: 600 },
];

const inherited = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^UI_.*_ONLY$/.test(key)),
);

const failures = [];
for (const testCase of cases) {
  console.log(`UI hardening: ${testCase.name}`);
  const result = spawnSync(process.execPath, ["scripts/verify-ui.mjs"], {
    cwd: process.cwd(),
    env: {
      ...inherited,
      UI_BROWSER: testCase.browser,
      UI_VIEWPORT_WIDTH: String(testCase.width),
      UI_VIEWPORT_HEIGHT: String(testCase.height),
      UI_HEADER_ONLY: "1",
      UI_HARDENING_ONLY: "1",
      UI_VERIFY_VGPU: testCase.browser === "webkit" ? "1" : "0",
      UI_SCREENSHOT: resolve(evidenceDir, `${testCase.name}-setup.png`),
      UI_TABLE_SCREENSHOT: resolve(evidenceDir, `${testCase.name}-table.png`),
      UI_SIDE_PANEL_SCREENSHOT: resolve(evidenceDir, `${testCase.name}-rail.png`),
      UI_FAILURE_SCREENSHOT: resolve(evidenceDir, `${testCase.name}-failure.png`),
    },
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  // A deferred geometry failure in one viewport must not erase independent rows.
  if (result.status !== 0) failures.push({ name: testCase.name, status: result.status });
}

if (failures.length > 0) {
  console.error(`UI hardening matrix: FAIL ${JSON.stringify(failures)}`);
  process.exit(1);
}
console.log("UI hardening matrix: PASS");

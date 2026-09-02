import { spawnSync } from "node:child_process";

const cases = [
  { name: "laptop-1366x768", browser: "chromium", width: 1366, height: 768 },
  { name: "ipad-1366x1024", browser: "webkit", width: 1366, height: 1024 },
  { name: "compact-tablet-1000x600", browser: "chromium", width: 1000, height: 600 },
];

for (const testCase of cases) {
  console.log(`UI hardening: ${testCase.name}`);
  const result = spawnSync(process.execPath, ["scripts/verify-ui.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      UI_BROWSER: testCase.browser,
      UI_VIEWPORT_WIDTH: String(testCase.width),
      UI_VIEWPORT_HEIGHT: String(testCase.height),
      UI_HEADER_ONLY: "1",
      UI_HARDENING_ONLY: "1",
      UI_VERIFY_VGPU: testCase.browser === "webkit" ? "1" : "0",
      UI_SCREENSHOT: `/tmp/mafia-dashboard-${testCase.name}-setup.png`,
      UI_TABLE_SCREENSHOT: `/tmp/mafia-dashboard-${testCase.name}-table.png`,
    },
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("UI hardening matrix: PASS");

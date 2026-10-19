import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.browser.spec.ts",
  outputDir: "../../.AI/public-website-replica/browser-results",
  reporter: "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  workers: 2,
  use: {
    baseURL: "http://127.0.0.1:5194/",
    contextOptions: { reducedMotion: "reduce" },
    locale: "ru-RU",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "node tests/serve-static.mjs 5194 /",
      url: "http://127.0.0.1:5194/",
      reuseExistingServer: false,
    },
    {
      command: "node tests/serve-static.mjs 5195 /mafia-dashboard/",
      url: "http://127.0.0.1:5195/mafia-dashboard/",
      reuseExistingServer: false,
    },
  ],
  projects: [
    {
      name: "desktop",
      use: { browserName: "chromium", channel: "chrome", viewport: { width: 1440, height: 1000 } },
    },
    {
      name: "tablet",
      use: { browserName: "chromium", channel: "chrome", viewport: { width: 768, height: 1024 } },
    },
    {
      name: "mobile",
      use: { browserName: "chromium", channel: "chrome", viewport: { width: 390, height: 844 } },
    },
    { name: "webkit", use: { browserName: "webkit", viewport: { width: 1440, height: 1000 } } },
    {
      name: "project-prefix",
      use: {
        browserName: "chromium",
        channel: "chrome",
        viewport: { width: 1440, height: 1000 },
        baseURL: "http://127.0.0.1:5195/mafia-dashboard/",
      },
    },
  ],
});

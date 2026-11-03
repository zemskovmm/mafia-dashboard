import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const apiTarget = process.env.MAFIA_API_PROXY_TARGET ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        // Cache stable dependencies and large features independently of the shell.
        codeSplitting: {
          groups: [
            { name: "react", test: /\/node_modules\/(react|react-dom|scheduler)\// },
            { name: "statistics", test: /\/features\/statistics\// },
            { name: "game", test: /\/features\/(game|ledger|night|voting)\// },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    allowedHosts: ["mbp16.tail102fab.ts.net"],
    proxy: {
      "/api": apiTarget,
      "/health": apiTarget,
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    testTimeout: 15_000,
  },
});

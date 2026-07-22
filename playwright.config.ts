import { defineConfig, devices } from "@playwright/test";

import { resolvePlaywrightRuntime } from "./scripts/playwright-runtime.js";

const runtime = resolvePlaywrightRuntime(process.env, process.pid);
// Playwright reevaluates this config in worker processes. Pin the coordinator's
// choice in the inherited environment so every worker uses the same server.
process.env.SURVEY_PLAYWRIGHT_PORT = String(runtime.port);

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: runtime.baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    command: `${runtime.buildCommand}python3 -m http.server ${runtime.port} --bind 127.0.0.1`,
    url: `${runtime.baseURL}/examples/review-workbench/index.html`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "chromium-mobile",
      use: {
        ...devices["Pixel 7"],
      },
    },
  ],
});

import { defineConfig, devices } from "@playwright/test";

// Browser acceptance (PLAN.md -> Tests -> Mobile and browser). Narrow and wide
// viewports are separate projects. Browsers are not installed on every host;
// see docs/mvp/TASK.md for the recorded status.
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: "narrow", use: { ...devices["iPhone 13"] } },
    { name: "wide", use: { ...devices["Desktop Chrome"] } },
  ],
});

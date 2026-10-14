import { defineConfig, devices } from "@playwright/test";

// Browser acceptance (PLAN.md -> Tests -> Mobile and browser). The dev server
// is started by a fixture launcher that also serves a local Access JWKS; see
// tests/e2e/start-dev.mjs. Timeouts are generous because the suite runs on a
// single-CPU container. The narrow project uses Chromium mobile emulation
// (WebKit is not installed here); real software-keyboard, screen-lock, and
// network-change behavior still requires the owner's phone.
const baseURL = "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node tests/e2e/start-dev.mjs",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [
    {
      name: "narrow",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
    },
    { name: "wide", use: { ...devices["Desktop Chrome"] } },
  ],
});

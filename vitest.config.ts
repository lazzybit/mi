import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Two runners (PLAN.md -> Tests):
//  - `unit`: plain Node. Pure domain logic, storage over `node:sqlite`,
//    codecs, MCP, auth, sync. No deployment credentials, no network.
//  - `workers`: workerd via the Cloudflare pool. Tests the built deployment
//    artifact (`dist/server/server.js`), so `npm run build` must run first.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
          testTimeout: 20_000,
        },
      },
      {
        plugins: [
          cloudflareTest({
            main: "./dist/server/server.js",
            remoteBindings: false,
            wrangler: { configPath: "./wrangler.jsonc" },
          }),
        ],
        test: {
          name: "workers",
          include: ["tests/workers/**/*.test.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});

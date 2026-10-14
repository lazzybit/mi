import { defineConfig, type Plugin } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import solid from "@solidjs/vite-plugin";

// The Solid client-mode shell is prerendered into `dist/client/index.html` by
// reading the client build's manifest. The Cloudflare plugin installs a
// config-level `builder.buildApp` that builds the Worker environment first, so
// a clean build would bake an empty manifest into the server bundle and emit a
// shell with no script or stylesheet tags. Building the client from a
// normal-order hook runs before that orchestrator, so the manifest exists when
// the server environment is built. (The Solid plugin ships the same ordering
// for its `ssr` mode; client mode needs it explicitly.)
function clientBuildFirst(): Plugin {
  return {
    name: "mi:client-build-first",
    apply: "build",
    async buildApp(builder) {
      const client = builder.environments.client;
      if (!client || client.isBuilt) return;
      if (!client.config.build.manifest) return;
      await builder.build(client);
    },
  };
}

// Browser acceptance runs the real Worker under the Vite preview server. When
// `MI_E2E=1` the fixture launcher (tests/e2e/start-dev.mjs) starts a local
// Access JWKS endpoint and points the Worker at it. Remote bindings are
// disabled so no Cloudflare credentials are required and the AI binding stays
// simulated locally. Production builds are unaffected: without MI_E2E these
// overrides are absent.
const e2e = process.env.MI_E2E === "1";

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      remoteBindings: !e2e,
      ...(e2e
        ? {
            persistState: { path: new URL("./.e2e-state", import.meta.url).pathname },
            config: (config) => ({
              vars: {
                ...config.vars,
                ACCESS_ISSUER: process.env.MI_E2E_ACCESS_ISSUER ?? "http://127.0.0.1:8899",
                ACCESS_AUDIENCE: process.env.MI_E2E_ACCESS_AUDIENCE ?? "mi",
                MI_FIXTURE_MODEL_URL: process.env.MI_E2E_MODEL_URL ?? "http://127.0.0.1:8898",
              },
            }),
          }
        : {}),
    }),
    // Client mode start: the shell renders on the client; the server build is
    // still emitted because server functions need the `/_server` endpoint.
    solid({
      start: { middleware: "./src/middleware.ts" },
      serverFunctions: true,
    }),
    clientBuildFirst(),
  ],
  build: {
    target: "esnext",
    assetsInlineLimit: 0,
  },
});

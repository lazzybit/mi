import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import solid from "@solidjs/vite-plugin";

// Deployment shape (PLAN.md -> Architecture -> Deployment shape):
// one Vite build produces the Solid 2 client and the server handler, deployed
// as one Cloudflare Worker. The Cloudflare plugin owns the `ssr` environment
// and is listed before `solid()`.
export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    // Client mode start: the shell renders on the client; the server build is
    // still emitted because server functions need the `/_server` endpoint.
    solid({
      start: { middleware: "./src/middleware.ts" },
      serverFunctions: true,
    }),
  ],
  build: {
    target: "esnext",
    assetsInlineLimit: 0,
  },
});

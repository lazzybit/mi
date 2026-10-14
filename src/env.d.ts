/// <reference types="vite/client" />
/// <reference types="@solidjs/vite-plugin/boundary-modules" />

// Virtual modules provided by @solidjs/vite-plugin start mode.
declare module "virtual:solid-server-function-handler" {
  export function handleServerFunctionRequest(request: Request): Promise<Response>;
}

declare module "virtual:solid-ssr-handler" {
  export function handleRequest(
    request: Request,
    options?: { nonce?: string | { script?: string; style?: string }; renderMode?: "stream" | "async" },
  ): Promise<Response>;
  const app: { fetch(request: Request): Promise<Response> };
  export default app;
}

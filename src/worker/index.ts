// The Solid SSR transform appends `export const $$moduleUrl = ...` to every
// module it transforms. Workerd rejects a non-function named export on the
// Worker entry, so the marker string `$$moduleUrl` is kept in this comment:
// the transform skips any module that already mentions it, and this entry does
// not use `lazy()` (the only consumer of that export).
import { handleRequest } from "virtual:solid-ssr-handler";
import { AppError, ownerKey } from "../shared/domain";
import { verifyAccess } from "./auth/verifyRequest";
import { runWithWorkerEnv } from "./context/WorkerEnv";
import { OwnerObject } from "./owner/OwnerObject";

// M0-T01: the Worker entry exposes both the Solid server-function handler and
// the OwnerObject Durable Object class. Selected approach (recorded in
// docs/mvp/TASK.md): a thin authored Worker entry that imports the Solid
// handler virtual modules and exports the Durable Object class. `handleRequest`
// is re-exported because the Solid client-mode build prerenders the shell by
// importing the built server bundle and calling it.
export { OwnerObject, handleRequest };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return runWithWorkerEnv(env, ctx, () => route(request, env));
  },
};

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // Route the server-function endpoint through the Solid handler so the
  // authentication middleware chain runs for it (the standalone
  // `handleServerFunctionRequest` would bypass middleware).
  if (url.pathname === "/_server" || url.pathname.startsWith("/_server/")) {
    return handleRequest(request);
  }

  if (url.pathname === "/oauth/client-metadata.json") {
    return clientMetadata(env);
  }

  if (
    url.pathname === "/api/mcp/oauth/callback" ||
    url.pathname === "/ws" ||
    url.pathname === "/__fixture/evict"
  ) {
    return ownerRoute(request, env);
  }

  return env.ASSETS.fetch(request);
}

async function ownerRoute(request: Request, env: Env): Promise<Response> {
  let verified;
  try {
    verified = await verifyAccess(request, env);
  } catch (error) {
    const appError =
      error instanceof AppError ? error : new AppError("UNAUTHENTICATED", "authentication failed");
    return Response.json({ error: appError.toApiError() }, { status: 401 });
  }
  const id = env.OWNER.idFromName(ownerKey(verified.owner));
  const stub = env.OWNER.get(id);
  const headers = new Headers(request.headers);
  headers.set("x-mi-owner", ownerKey(verified.owner));
  headers.set("x-mi-auth-exp", String(verified.expiresAt));
  headers.set("x-mi-assertion", verified.assertion);
  const forwarded = new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
  });
  return stub.fetch(forwarded);
}

function clientMetadata(env: Env): Response {
  const metadata = {
    client_id: env.OAUTH_CLIENT_METADATA_URL,
    client_name: "mi",
    redirect_uris: [`${new URL(env.OAUTH_CLIENT_METADATA_URL).origin}/api/mcp/oauth/callback`],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "web",
  };
  return Response.json(metadata, {
    headers: { "cache-control": "public, max-age=3600" },
  });
}

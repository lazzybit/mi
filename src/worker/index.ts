// The Solid SSR transform appends `export const $$moduleUrl = ...` to every
// module it transforms. Workerd rejects a non-function named export on the
// Worker entry, so the marker string `$$moduleUrl` is kept in this comment:
// the transform skips any module that already mentions it, and this entry does
// not use `lazy()` (the only consumer of that export).
//
// The Worker entry is the only authenticated request boundary (ADR-0003).
//
// It verifies access, then either serves catalog operations through the Solid
// server-function handler or forwards a selected-session WebSocket to the
// session object. There is no owner Durable Object and no owner WebSocket.

import { handleRequest } from "virtual:solid-ssr-handler";
import { AppError, ownerKey, type OwnerIdentity } from "../shared/domain";
import { verifyAccess, type VerifiedAccessAssertion } from "./auth/verifyRequest";
import { runWithWorkerEnv } from "./context/WorkerEnv";
import { CatalogStore } from "./owner/CatalogStore";
import { SessionObject, sessionAddress } from "./session/SessionObject";

export { SessionObject, handleRequest };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return runWithWorkerEnv(env, ctx, () => route(request, env));
  },
};

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // Route the server-function endpoint through the Solid handler so the
  // authentication middleware chain runs for it.
  if (url.pathname === "/_server" || url.pathname.startsWith("/_server/")) {
    return handleRequest(request);
  }

  if (url.pathname === "/ws") {
    return sessionRoute(request, env);
  }

  // Browser-acceptance only: the fixture routes exist only when the fixture
  // model URL is configured. They are authenticated exactly like `/ws`.
  if (url.pathname.startsWith("/__fixture/")) {
    return fixtureRoute(request, env);
  }

  return env.ASSETS.fetch(request);
}

async function sessionRoute(request: Request, env: Env): Promise<Response> {
  let verified;
  try {
    verified = await verifyAccess(request, env);
  } catch (error) {
    return unauthorized(error);
  }
  return forwardToSession(request, env, verified);
}

async function fixtureRoute(request: Request, env: Env): Promise<Response> {
  if (readFixtureModelUrl(env) === undefined) {
    return new Response("not found", { status: 404 });
  }
  let verified;
  try {
    verified = await verifyAccess(request, env);
  } catch (error) {
    return unauthorized(error);
  }
  return forwardToSession(request, env, verified);
}

async function forwardToSession(
  request: Request,
  env: Env,
  verified: VerifiedAccessAssertion,
): Promise<Response> {
  const url = new URL(request.url);
  const conversationId = url.searchParams.get("conversationId");
  if (!conversationId) {
    return Response.json(
      { error: { code: "INVALID_INPUT", message: "conversationId is required", retryable: false } },
      { status: 400 },
    );
  }

  const key = ownerKey(verified.owner);
  const row = await new CatalogStore(env.DB).get(key, conversationId);
  if (!row) {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "conversation not found", retryable: false } },
      { status: 404 },
    );
  }
  if (row.lifecycle !== "active") {
    return Response.json(
      { error: { code: "CONFLICT", message: "conversation is not active", retryable: false } },
      { status: 409 },
    );
  }

  const stub = env.SESSION.get(env.SESSION.idFromName(sessionAddress(key, conversationId)));
  const headers = new Headers(request.headers);
  headers.set("x-mi-owner", key);
  headers.set("x-mi-auth-exp", String(verified.expiresAt));
  headers.set("x-mi-conversation", conversationId);
  const forwarded = new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
  });
  return stub.fetch(forwarded);
}

function unauthorized(error: unknown): Response {
  const appError =
    error instanceof AppError ? error : new AppError("UNAUTHENTICATED", "authentication failed");
  return Response.json({ error: appError.toApiError() }, { status: 401 });
}

function readFixtureModelUrl(env: Env): string | undefined {
  const value = (env as unknown as Record<string, unknown>).MI_FIXTURE_MODEL_URL;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export type { OwnerIdentity };
export { ownerKey };

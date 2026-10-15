// Request-local RPC context (ADR-0003, ADR-0004).
//
// `RpcContext` is private server code. There is no owner Durable Object stub:
// catalog operations read and write D1 directly, and session provisioning or
// erasure goes through the session RPC. Bindings and credentials never cross
// the Solid serialization boundary.

import { getRequestEvent } from "@solidjs/web";
import { AppError } from "../../shared/domain";
import { getWorkerEnv } from "../context/WorkerEnv";
import type { AuthLocals } from "../auth/locals";
import { CatalogStore } from "../catalog/CatalogStore";
import { eraseSession, provisionSession } from "../session/SessionClient";

export interface RpcContext {
  env: Env;
  catalog: CatalogStore;
  requestSignal: AbortSignal;
  provision(conversationId: string): Promise<void>;
  erase(conversationId: string): Promise<void>;
}

export function requireRpcContext(): RpcContext {
  const event = getRequestEvent();
  if (!event) {
    throw new AppError("UNAUTHENTICATED", "no request context for this server function");
  }
  const locals = event.locals as AuthLocals;
  const { env } = getWorkerEnv();
  // ADR-0004: production carries the verified expiry; development carries none.
  const authExpiresAt = locals.accessExpiresAt;
  const target = (conversationId: string) => ({ conversationId, authExpiresAt });
  return {
    env,
    catalog: new CatalogStore(env.DB),
    requestSignal: event.request.signal,
    provision: (conversationId) => provisionSession(env, target(conversationId)),
    erase: (conversationId) => eraseSession(env, target(conversationId)),
  };
}

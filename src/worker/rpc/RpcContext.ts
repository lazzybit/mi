// Request-local RPC context (ADR-0003).
//
// `RpcContext` is private server code. There is no owner Durable Object stub:
// catalog operations read and write D1 directly, and session provisioning or
// erasure goes through the session RPC. Bindings and credentials never cross
// the Solid serialization boundary.

import { getRequestEvent } from "@solidjs/web";
import { AppError, ownerKey, type OwnerIdentity } from "../../shared/domain";
import { getWorkerEnv } from "../context/WorkerEnv";
import type { OwnerLocals } from "../auth/locals";
import { CatalogStore } from "../owner/CatalogStore";
import { eraseSession, provisionSession } from "../session/SessionClient";

export interface RpcContext {
  owner: OwnerIdentity;
  key: string;
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
  const locals = event.locals as OwnerLocals;
  const owner = locals.owner;
  if (!owner) {
    throw new AppError("UNAUTHENTICATED", "no verified owner for this request");
  }
  const { env } = getWorkerEnv();
  const key = ownerKey(owner);
  const authExpiresAt = locals.accessExpiresAt;
  const target = (conversationId: string) => ({ ownerKey: key, conversationId, authExpiresAt });
  return {
    owner,
    key,
    env,
    catalog: new CatalogStore(env.DB),
    requestSignal: event.request.signal,
    provision: (conversationId) => provisionSession(env, target(conversationId)),
    erase: (conversationId) => eraseSession(env, target(conversationId)),
  };
}

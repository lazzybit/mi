// Request-local RPC context (PLAN.md -> Server-function layer).
// `RpcContext` is private server code. Bindings, credentials, and Durable Object
// stubs never cross the Solid serialization boundary.

import { getRequestEvent } from "@solidjs/web";
import { AppError, ownerKey, type OwnerIdentity } from "../../shared/domain";
import { getWorkerEnv } from "../context/WorkerEnv";
import type { OwnerLocals } from "../auth/locals";
import type { OwnerRpc } from "./OwnerRpc";
import { OwnerRpcClient } from "./OwnerRpcClient";

export interface RpcContext {
  owner: OwnerIdentity;
  ownerStub: OwnerRpc;
  requestSignal: AbortSignal;
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
  const id = env.OWNER.idFromName(ownerKey(owner));
  const stub = env.OWNER.get(id);
  const headers: Record<string, string> = { "x-mi-owner": ownerKey(owner) };
  if (locals.accessAssertion) headers["x-mi-assertion"] = locals.accessAssertion;
  if (locals.accessExpiresAt) headers["x-mi-auth-exp"] = String(locals.accessExpiresAt);
  return {
    owner,
    ownerStub: new OwnerRpcClient(stub, headers),
    requestSignal: event.request.signal,
  };
}

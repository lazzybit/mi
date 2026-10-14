// Request-scoped access to Worker bindings.
//
// We deliberately avoid importing `cloudflare:workers` at runtime: the Solid
// client-mode build imports the built server bundle in Node to prerender the
// shell, and a top-level `cloudflare:workers` import makes that import fail with
// `ERR_UNSUPPORTED_ESM_URL_SCHEME`. The Worker entry stores the bindings in an
// AsyncLocalStorage scope instead, and everything downstream (middleware,
// server functions, the Durable Object) reads them through `getWorkerEnv()`.

import { AsyncLocalStorage } from "node:async_hooks";

export interface WorkerEnvScope {
  env: Env;
  ctx: ExecutionContext;
}

const storage = new AsyncLocalStorage<WorkerEnvScope>();

export function runWithWorkerEnv<T>(env: Env, ctx: ExecutionContext, fn: () => T): T {
  return storage.run({ env, ctx }, fn);
}

export function getWorkerEnv(): WorkerEnvScope {
  const scope = storage.getStore();
  if (!scope) {
    throw new Error("worker environment is not available in this scope");
  }
  return scope;
}

export function tryGetWorkerEnv(): WorkerEnvScope | undefined {
  return storage.getStore();
}

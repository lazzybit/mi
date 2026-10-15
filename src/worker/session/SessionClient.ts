// Internal session RPC used by the Worker (ADR-0003, ADR-0004).
//
// Catalog operations cross into a session object to provision or erase its
// storage. The Worker has already verified access; in production it forwards
// the verified assertion expiry so the session object can re-check it.
// ADR-0004 addresses each session object directly by its conversation id.

import { AppError, type ApiError } from "../../shared/domain";

interface SessionTarget {
  conversationId: string;
  authExpiresAt?: number;
}

function stubFor(env: Env, target: SessionTarget): DurableObjectStub {
  const id = env.SESSION.idFromName(target.conversationId);
  return env.SESSION.get(id);
}

function headersFor(target: SessionTarget): Headers {
  const headers = new Headers();
  if (target.authExpiresAt !== undefined) {
    headers.set("x-mi-auth-exp", String(target.authExpiresAt));
  }
  return headers;
}

async function call(env: Env, target: SessionTarget, path: string): Promise<void> {
  const response = await stubFor(env, target).fetch(`https://session.internal${path}`, {
    method: "POST",
    headers: headersFor(target),
  });
  if (response.ok) return;
  let error: ApiError | undefined;
  try {
    error = ((await response.json()) as { error?: ApiError }).error;
  } catch {
    error = undefined;
  }
  throw error
    ? new AppError(error.code, error.message, error.retryable)
    : new AppError("INVALID_INPUT", `session ${path} returned ${response.status}`);
}

/** Initialize one session's storage; only the create command calls this. */
export function provisionSession(env: Env, target: SessionTarget): Promise<void> {
  return call(env, target, "/provision");
}

/** Quiesce and erase one session's storage before its catalog row is removed. */
export function eraseSession(env: Env, target: SessionTarget): Promise<void> {
  return call(env, target, "/delete");
}

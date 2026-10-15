import type { RequestEvent } from "@solidjs/web";
import { AppError } from "./shared/domain";
import { getWorkerEnv } from "./worker/context/WorkerEnv";
import { verifyAccess } from "./worker/auth/verifyRequest";
import type { AuthLocals } from "./worker/auth/locals";

// Verifies the Access assertion for server-function traffic and attaches the
// verified expiry to request locals (ADR-0004). Development admits the request
// without a credential and stores no deadline. Page renders are served as a
// static shell (protected at the edge by Access) and do not require a token,
// which keeps the build-time shell prerender working.
export default async function middleware(
  event: RequestEvent,
  next: () => Promise<Response>,
): Promise<Response> {
  const url = new URL(event.request.url);
  const isServerFunction = url.pathname === "/_server" || url.pathname.startsWith("/_server/");
  if (isServerFunction) {
    try {
      const { env } = getWorkerEnv();
      const expiresAt = await verifyAccess(event.request, env);
      const locals = event.locals as AuthLocals;
      locals.accessExpiresAt = expiresAt;
    } catch (error) {
      if (error instanceof AppError) {
        return Response.json({ error: error.toApiError() }, { status: 401 });
      }
      throw error;
    }
  }
  return next();
}

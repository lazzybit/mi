import type { RequestEvent } from "@solidjs/web";
import { AppError } from "./shared/domain";
import { getWorkerEnv } from "./worker/context/WorkerEnv";
import { verifyAccess } from "./worker/auth/verifyRequest";
import type { OwnerLocals } from "./worker/auth/locals";

// Verifies the Access assertion for server-function traffic and attaches the
// verified owner to request locals. Page renders are served as a static shell
// (protected at the edge by Access) and do not require a token, which keeps the
// build-time shell prerender working.
export default async function middleware(
  event: RequestEvent,
  next: () => Promise<Response>,
): Promise<Response> {
  const url = new URL(event.request.url);
  const isServerFunction = url.pathname === "/_server" || url.pathname.startsWith("/_server/");
  if (isServerFunction) {
    try {
      const { env } = getWorkerEnv();
      const verified = await verifyAccess(event.request, env);
      const locals = event.locals as OwnerLocals;
      locals.owner = verified.owner;
      locals.accessExpiresAt = verified.expiresAt;
      locals.accessAssertion = verified.assertion;
    } catch (error) {
      if (error instanceof AppError) {
        return Response.json({ error: error.toApiError() }, { status: 401 });
      }
      throw error;
    }
  }
  return next();
}

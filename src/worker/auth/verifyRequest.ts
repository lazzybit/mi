// Access verification for the Worker entry (WebSocket upgrade and fixture
// routes). The Solid middleware performs the same verification for pages and
// server functions.

import { AppError } from "../../shared/domain";
import { AccessVerifier, RemoteJwksProvider } from "./AccessVerifier";
import { isDevelopment } from "../context/Environment";

const jwks = new RemoteJwksProvider();

/** ADR-0004: `Cf-Access-Jwt-Assertion` is the only assertion source. */
export function accessTokenFromRequest(request: Request): string | undefined {
  return request.headers.get("cf-access-jwt-assertion") ?? undefined;
}

/**
 * ADR-0004: development admits the request without a credential and returns no
 * expiry; production verifies the assertion and returns its expiry in
 * milliseconds.
 */
export async function verifyAccess(request: Request, env: Env): Promise<number | undefined> {
  // Apply the development branch before reading a token or resolving JWKS.
  if (isDevelopment(env)) return undefined;
  const token = accessTokenFromRequest(request);
  if (!token) throw new AppError("UNAUTHENTICATED", "missing Access assertion");
  const verifier = new AccessVerifier(
    { issuer: env.ACCESS_ISSUER, audience: env.ACCESS_AUDIENCE },
    jwks,
  );
  return verifier.verify(token);
}

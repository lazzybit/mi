// Access verification for the Worker entry (WebSocket upgrade and OAuth
// callback). The Solid middleware performs the same verification for pages and
// server functions.

import { AppError } from "../../shared/domain";
import { AccessVerifier, RemoteJwksProvider, type VerifiedAccessAssertion } from "./AccessVerifier";

const jwks = new RemoteJwksProvider();

export function accessTokenFromRequest(request: Request): string | undefined {
  const header = request.headers.get("cf-access-jwt-assertion");
  if (header) return header;
  const cookie = request.headers.get("cookie");
  if (cookie) {
    const match = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

export async function verifyAccess(request: Request, env: Env): Promise<VerifiedAccessAssertion> {
  const token = accessTokenFromRequest(request);
  if (!token) throw new AppError("UNAUTHENTICATED", "missing Access assertion");
  const verifier = new AccessVerifier(
    { issuer: env.ACCESS_ISSUER, audience: env.ACCESS_AUDIENCE },
    jwks,
  );
  return verifier.verify(token);
}

export type { VerifiedAccessAssertion };

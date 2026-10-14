// Access assertion verification (PLAN.md -> Behavior -> Authentication).
// Verifies issuer, audience, signature, subject, and expiry before any owner is
// associated with a request.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { AppError, type OwnerIdentity } from "../../shared/domain";

export interface AccessConfig {
  issuer: string;
  audience: string | string[];
}

export interface VerifiedAccessAssertion {
  owner: OwnerIdentity;
  expiresAt: number;
  /** Raw JWT, forwarded as `Cf-Access-Token` for Access delegation. */
  assertion: string;
  email?: string;
  claims: Record<string, unknown>;
}

export type JwtKeyResolver = JWTVerifyGetKey;

export interface JwksProvider {
  resolve(issuer: string): Promise<JwtKeyResolver>;
}

/** Production provider: fetches and caches the Access JWKS from the issuer. */
export class RemoteJwksProvider implements JwksProvider {
  private readonly cache = new Map<string, JwtKeyResolver>();

  async resolve(issuer: string): Promise<JwtKeyResolver> {
    const cached = this.cache.get(issuer);
    if (cached) return cached;
    const base = issuer.replace(/\/+$/, "");
    const resolver = createRemoteJWKSet(new URL(`${base}/cdn-cgi/access/certs`));
    this.cache.set(issuer, resolver);
    return resolver;
  }
}

export class AccessVerifier {
  constructor(
    private readonly config: AccessConfig,
    private readonly jwks: JwksProvider,
  ) {}

  async verify(token: string): Promise<VerifiedAccessAssertion> {
    if (!token) {
      throw new AppError("UNAUTHENTICATED", "missing Access assertion");
    }
    let keyResolver: JwtKeyResolver;
    try {
      keyResolver = await this.jwks.resolve(this.config.issuer);
    } catch {
      throw new AppError("UNAUTHENTICATED", "unable to load Access signing keys");
    }

    let payload: Record<string, unknown>;
    try {
      const verified = await jwtVerify(token, keyResolver, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        clockTolerance: 5,
      });
      payload = verified.payload as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid assertion";
      throw new AppError("UNAUTHENTICATED", `Access assertion rejected: ${message}`);
    }

    const subject = typeof payload.sub === "string" ? payload.sub : undefined;
    const issuer = typeof payload.iss === "string" ? payload.iss : undefined;
    const exp = typeof payload.exp === "number" ? payload.exp : undefined;
    if (!subject || !issuer || exp === undefined) {
      throw new AppError("UNAUTHENTICATED", "Access assertion is missing required claims");
    }

    const owner: OwnerIdentity = { issuer, subject };
    const result: VerifiedAccessAssertion = {
      owner,
      expiresAt: exp * 1000,
      assertion: token,
      claims: payload,
    };
    if (typeof payload.email === "string") result.email = payload.email;
    return result;
  }
}

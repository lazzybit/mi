// Access assertion verification (ADR-0004).
//
// Production verifies issuer, audience, signature, and expiry before a request
// is admitted. The verified expiry is the only value the application consumes;
// the authenticated identity no longer partitions application state.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { AppError } from "../../shared/domain";

export interface AccessConfig {
  issuer: string;
  audience: string | string[];
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

  /** Verify a production assertion and return its expiry in milliseconds. */
  async verify(token: string): Promise<number> {
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

    // ADR-0004: the application enforces socket deadlines, so the expiry is a
    // required claim rather than an optional one.
    const exp = typeof payload.exp === "number" ? payload.exp : undefined;
    if (exp === undefined) {
      throw new AppError("UNAUTHENTICATED", "Access assertion is missing its expiry");
    }
    return exp * 1000;
  }
}

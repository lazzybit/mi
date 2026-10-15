import { describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from "jose";
import { AccessVerifier, type JwksProvider } from "../../src/worker/auth/AccessVerifier";
import { AppError } from "../../src/shared/domain";

const ISSUER = "https://access.test";
const AUDIENCE = "mi";

async function fixture() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const provider: JwksProvider = { resolve: async () => jwks };
  const verifier = new AccessVerifier({ issuer: ISSUER, audience: AUDIENCE }, provider);
  const sign = (claims: Record<string, unknown>, options: { issuer?: string; audience?: string; expiresIn?: string } = {}) =>
    new SignJWT({ email: "owner@example.com", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(options.issuer ?? ISSUER)
      .setAudience(options.audience ?? AUDIENCE)
      .setSubject((claims.sub as string) ?? "user-1")
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? "5m")
      .sign(privateKey);
  return { verifier, sign, privateKey };
}

describe("AccessVerifier", () => {
  // ADR-0004: verification returns the expiry the application enforces; it no
  // longer derives an identity from the assertion.
  it("accepts a valid assertion and returns its expiry", async () => {
    const { verifier, sign } = await fixture();
    const token = await sign({ sub: "user-1" });
    const expiresAt = await verifier.verify(token);
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it("accepts an assertion without a subject", async () => {
    const { verifier, privateKey } = await fixture();
    const token = await new SignJWT({ email: "owner@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(verifier.verify(token)).resolves.toBeGreaterThan(Date.now());
  });

  it("rejects a missing expiry", async () => {
    const { verifier, privateKey } = await fixture();
    const token = await new SignJWT({ sub: "user-1" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .sign(privateKey);
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(AppError);
  });

  it("rejects a wrong issuer", async () => {
    const { verifier, sign } = await fixture();
    const token = await sign({ sub: "user-1" }, { issuer: "https://evil.test" });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(AppError);
  });

  it("rejects a wrong audience", async () => {
    const { verifier, sign } = await fixture();
    const token = await sign({ sub: "user-1" }, { audience: "other-app" });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(AppError);
  });

  it("rejects an expired assertion", async () => {
    const { verifier, sign } = await fixture();
    const token = await sign({ sub: "user-1" }, { expiresIn: "-10m" });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(AppError);
  });

  it("rejects a tampered signature", async () => {
    const { verifier, sign } = await fixture();
    const token = await sign({ sub: "user-1" });
    const tampered = `${token.slice(0, -4)}AAAA`;
    await expect(verifier.verify(tampered)).rejects.toBeInstanceOf(AppError);
  });

  it("rejects an empty token", async () => {
    const { verifier } = await fixture();
    await expect(verifier.verify("")).rejects.toBeInstanceOf(AppError);
  });
});

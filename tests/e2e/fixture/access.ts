// Signs fixture Access assertions with the ephemeral key created by
// tests/e2e/start-dev.mjs. The Worker verifies them through the real Access
// path (issuer, audience, signature, subject, expiry) against the local JWKS.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT, importPKCS8 } from "jose";
import type { BrowserContext } from "@playwright/test";

const stateFile = join(dirname(fileURLToPath(import.meta.url)), "..", ".state", "access-key.json");

export const FIXTURE_ISSUER = process.env.MI_E2E_ACCESS_ISSUER ?? "http://127.0.0.1:8899";
export const FIXTURE_AUDIENCE = process.env.MI_E2E_ACCESS_AUDIENCE ?? "mi";

interface FixtureKey {
  privatePem: string;
  jwk: Record<string, unknown>;
}

function readFixtureKey(): FixtureKey {
  return JSON.parse(readFileSync(stateFile, "utf8")) as FixtureKey;
}

export async function signAccessToken(subject: string, ttlSeconds = 3600): Promise<string> {
  const { privatePem } = readFixtureKey();
  const key = await importPKCS8(privatePem, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: `${subject}@example.test` })
    .setProtectedHeader({ alg: "RS256", kid: "mi-e2e" })
    .setIssuer(FIXTURE_ISSUER)
    .setAudience(FIXTURE_AUDIENCE)
    .setSubject(subject)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(key);
}

/** Authenticates a browser context as the given fixture owner. */
export async function login(
  context: BrowserContext,
  subject: string,
  options: { origin?: string; ttlSeconds?: number } = {},
): Promise<void> {
  const token = await signAccessToken(subject, options.ttlSeconds ?? 3600);
  await context.addCookies([
    { name: "CF_Authorization", value: token, url: options.origin ?? "http://127.0.0.1:3000" },
  ]);
}

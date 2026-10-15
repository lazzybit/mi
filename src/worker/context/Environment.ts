// ADR-0004: one environment setting selects development or production
// behavior. Development admits requests without an Access credential and skips
// the credential-dependent expiry checks; production verifies the assertion and
// enforces the forwarded expiry.

export type AppEnvironment = "development" | "production";

/**
 * Read the configured environment. An absent or unknown value is treated as
 * production, so a missing binding can never silently disable verification.
 */
export function appEnvironment(env: Env): AppEnvironment {
  const value: string = env.ENVIRONMENT;
  return value === "development" ? "development" : "production";
}

export function isDevelopment(env: Env): boolean {
  return appEnvironment(env) === "development";
}

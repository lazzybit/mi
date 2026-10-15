// Request-local values attached by the authentication middleware (ADR-0004).
// We keep a local interface and cast rather than augmenting `@solidjs/web`,
// because an ambient `declare module` in a script `.d.ts` would shadow the
// package's own types.

export interface AuthLocals {
  /** Verified Access expiry in milliseconds; absent in development. */
  accessExpiresAt?: number;
}

// Destination policy (PLAN.md -> MCP subsystem -> DestinationPolicy).
// Credentials are forwarded only to configured destinations, never across a
// redirect to another origin.

import { AppError } from "../../shared/domain";

export class DestinationPolicy {
  validateEndpoint(url: URL): void {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new AppError("INVALID_INPUT", "endpoint must use http(s)");
    }
    if (url.username || url.password) {
      throw new AppError("INVALID_INPUT", "endpoint must not embed credentials");
    }
  }

  validateTrustedOrigin(origin: string, endpoint: URL): void {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new AppError("INVALID_INPUT", "trusted origin must be an absolute URL");
    }
    if (parsed.origin !== endpoint.origin) {
      throw new AppError(
        "INVALID_INPUT",
        "the trusted origin for Access delegation must match the connector endpoint origin",
      );
    }
  }

  /** A credential may be attached only when the destination origin matches. */
  validateCredentialDestination(allowedOrigin: string, destination: URL): void {
    if (destination.origin !== allowedOrigin) {
      throw new AppError(
        "INVALID_INPUT",
        "refusing to forward a credential to a different origin",
      );
    }
  }

  /** Redirects carrying credentials must not cross origins. */
  mayFollowRedirect(allowedOrigin: string, location: string, base: URL): boolean {
    let next: URL;
    try {
      next = new URL(location, base);
    } catch {
      return false;
    }
    return next.origin === allowedOrigin;
  }
}

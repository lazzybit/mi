# ADR-0004: Keep mi single-user and simplify authentication

- Created Date: 2026-10-16
- Status: Accepted
- Baseline: 8e78ba7344259cc4a977211354c881be20c4198e

## Status Quo

mi is a personal application that will remain single-user. Its implementation
nevertheless partitions application state by the identity in an Access
assertion.

`OwnerIdentity` and `ownerKey()` supply an `issuer|subject` key to request
locals, RPC context, and `CatalogStore`. The D1 catalog scopes conversations,
settings, and creation receipts by `owner_key`. Session objects use
`ownerKey::conversationId` addresses, persist an owner key in their host marker,
and compare it with the forwarded `x-mi-owner` header.

ADR-0003 carried this ownership model into the D1 catalog and the independent
session objects when adopting pi-durable.

`verifyRequest.ts` accepts an assertion from either
`Cf-Access-Jwt-Assertion` or a `CF_Authorization` cookie. The browser tests use
the cookie path with locally signed assertions and a local JWKS endpoint.

The Worker forwards the verified assertion's expiry as `x-mi-auth-exp`.
`SessionObject` records it on the socket and closes expired sockets before
processing control frames or sending protected data. `SessionFeed` treats
close code `4401` specially: it enters `authentication_required` and stops
reconnecting. A browser test asserts that behavior.

## Needs

- Use one application catalog and one shared settings record, independent of
  the authenticated identity.
- Retain JWT verification for production requests and expiry enforcement for
  established sockets.
- Run development and browser tests without supplying Access credentials.
- Leave credential acquisition and renewal to Cloudflare Access.

## Decision

1. mi is permanently single-user. Remove `OwnerIdentity`, `ownerKey`, owner
   fields in request context, and owner scoping in the D1 catalog.
   Conversations use their conversation identifiers, settings use a singleton
   record, and creation receipts use their command identifiers.

2. Address each session object by its managed conversation identifier.
   Remove the owner component from addresses and host markers, along with
   `x-mi-owner` propagation and comparison. Name the catalog module for its
   application responsibility.

3. Production accepts `Cf-Access-Jwt-Assertion` as its assertion source and
   retains JWT signature, issuer, audience, and expiry verification. Remove
   the application's `CF_Authorization` cookie fallback. Missing, invalid,
   and expired credentials are rejected through the authentication failure
   path.

4. Use one development/production environment setting. Development bypasses
   JWT verification and the credential-dependent expiry checks. Production
   performs both. Development requests require no token, principal, or
   artificial expiry, so browser tests can operate without the Access signing
   and JWKS fixtures.

5. Retain `x-mi-auth-exp` in production. The Worker derives it from the verified
   assertion; the session object enforces it before processing inbound control
   frames and sending protected outbound data. An expired socket is closed.

6. Remove the client's `authentication_required` state, its special handling
   of close code `4401`, and the browser test requiring that state. Socket
   closure follows the existing connection handling. mi does not acquire,
   refresh, or renew credentials.

This changes the owner-scoping assumptions carried by ADR-0003. Its adoption
of pi-durable and one independent Session/storage per managed conversation
remain in force; ADR-0003 is not retired by this decision.

Existing session addresses and host markers contain owner keys. Planning must
account for their persisted data when changing addressing. Browser tests also
use different owners for isolation; that isolation must be revised for the
single-user model.

## Reason

The authenticated identity determines whether a request is admitted. It does
not identify a separate catalog or settings namespace in this application.
Removing owner scoping makes storage and session addressing match the permanent
single-user requirement.

Production assertion verification and development access serve different
environments. One explicit environment setting supports both without requiring
browser tests to supply credentials through an additional production token
source.

Socket expiry enforcement remains necessary to stop using an authorization
after its recorded deadline. It requires rejection or closure, not an
application credential-renewal flow. Removing the special client state preserves
that enforcement while leaving credential management with Access.

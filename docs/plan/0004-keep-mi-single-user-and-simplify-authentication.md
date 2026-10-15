# Plan-0004: Keep mi single-user and simplify authentication

- Created Date: 2026-10-16
- Status: In Progress

## Target

- All admitted requests use the same conversation catalog and model settings,
  independent of the Access identity.
- Application code has no `OwnerIdentity`, `ownerKey`, owner-scoped SQL,
  owner-qualified session addressing, or `x-mi-owner` propagation.
- Production verifies the assertion supplied through
  `Cf-Access-Jwt-Assertion`. The application does not extract credentials
  from cookies.
- One `ENVIRONMENT` setting selects `development` or `production`.
  Development requires no credentials and bypasses credential expiry checks.
  Production retains JWT verification and `x-mi-auth-exp` enforcement.
- Socket closure uses ordinary connection handling. The client has no
  `authentication_required` state or credential-renewal protocol.
- Browser tests exercise the application in development mode without Access
  signing fixtures, a JWKS server, or owner-based test isolation.
- Existing persisted state receives an explicitly determined transition.
  Changing object addresses must not silently strand conversation history.

## Start

The starting implementation is the baseline recorded in ADR-0004. Subsequent
changes on this branch have modified documentation only. ADR-0004 is Accepted.

`CatalogStore` creates its D1 schema through `ensureSchema()`. Conversations
have globally unique identifiers but every operation also takes an owner key.
Settings use the owner key as their primary key; creation receipts use
`(owner_key, command_id)`.

`SessionObject` parses `ownerKey::conversationId` from its named object ID.
Its `mi.host` marker contains both identifiers. It reads owner-scoped settings
and catalog rows, and checks forwarded ownership and expiry headers.

Authentication runs in Solid middleware for server functions and in the
Worker entry for session and fixture requests. `AccessVerifier` returns an
owner, expiry, raw assertion, claims, and optional email.
`verifyRequest.ts` accepts the assertion header or a cookie.

Session admission, inbound controls, and outbound frames enforce expiry.
The client stops reconnecting after close code `4401`.

Worker tests use owner keys to isolate rows and reuse command identifiers.
Browser tests use distinct assertion subjects for isolation. Playwright
already runs serially with one worker. Its launcher resets storage once per
suite, not between tests.

The worktree does not contain generated binding declarations or dependencies.
`worker-configuration.d.ts` and `solid-env.d.ts` are ignored generated files.

## Architecture

### Application catalog

Move `CatalogStore` to `src/worker/catalog/CatalogStore.ts`. Its schema is:

- `conversations`: existing conversation fields without `owner_key`;
  primary key `id`, ordered by `updated_at` and `id`.
- `settings`: one record addressed by a fixed application key.
- `commands`: existing creation-receipt fields without `owner_key`;
  primary key `command_id`.

Catalog methods receive only their operation inputs and lifecycle callbacks.

### Authentication boundary

Use `ENVIRONMENT` as the sole authentication-mode setting.

`verifyAccess` returns the verified expiry in milliseconds in production.
In development it returns without requiring a credential. It does not
manufacture an identity or expiry.

The middleware carries the expiry to server-function context. The Worker
entry carries it to session requests. Production supplies `x-mi-auth-exp`
from verification, replacing any incoming value.

The development setting also applies inside `SessionObject`, so its admission,
receive, and send paths do not require a credential deadline in that mode.

### Session storage and transport

Resolve session objects directly from the managed conversation identifier.
Keep the host marker needed to distinguish provisioned storage, without its
owner field.

Keep the existing provisioning, deletion, harness, observation, and recovery
behavior. Production expiry closes the socket before processing further
controls or sending protected data.

### Browser tests

Use the shared application in development mode. Test isolation comes from
cleaning application state between serial tests, rather than from creating
different identities.

Use existing conversation deletion and settings controls for browser cleanup.
Do not add a production reset endpoint.

## Changes

**1. `wrangler.jsonc`, `vite.config.ts`, and local configuration**

- Set `ENVIRONMENT` to `production` in deployment configuration.
- Document `ENVIRONMENT=development` for local development in
  `.dev.vars.example`.
- Set the same Worker binding to `development` in the existing browser-test
  configuration override.
- Remove the browser-test issuer and audience overrides.
- Keep fixture model configuration separate from authentication mode.
- Regenerate Worker binding declarations and ensure their types support both
  configured environment values.

**2. `src/worker/auth/AccessVerifier.ts` and `verifyRequest.ts`**

- Keep `jose` JWT verification and require the production assertion's expiry.
- Read only `Cf-Access-Jwt-Assertion`.
- Apply the development branch before reading a token or resolving JWKS.
- Return only the expiry consumed by the application.
- Remove owner derivation and unused assertion, email, and claims outputs.
- Remove the subject requirement whose purpose was constructing an owner.
- Remove the cookie extraction function if it no longer has a separate use.

**3. `src/worker/auth/locals.ts`, `src/middleware.ts`, and
`src/worker/rpc/RpcContext.ts`**

- Replace owner locals with the expiry information needed by session calls.
- Remove owner identity, owner key, and raw assertion storage.
- Keep authentication in middleware and retain request-local Worker bindings.
- Update provisioning and erasure callbacks to use conversation identifiers
  and the verified expiry.
- Do not introduce a development principal or replacement owner.

**4. `src/shared/domain.ts`, `src/rpc/conversations.ts`, and
`src/rpc/settings.ts`**

- Delete `OwnerIdentity` and `ownerKey`.
- Remove owner arguments from all catalog calls.
- Update catalog descriptions and governed code comments.
- Preserve existing conversation DTOs, creation receipts, and management error
  behavior.

**5. `src/worker/catalog/CatalogStore.ts`**

- Move the existing module and update its imports.
- Change schema creation, indexes, statements, bindings, and method signatures
  to the application-wide model.
- Store and retrieve settings using the singleton key.
- Deduplicate creation by command identifier.
- Preserve creation replay, activation, rename, deletion, and provisioning
  sequencing while removing their owner predicates.

**6. `src/worker/index.ts` and `src/worker/session/SessionClient.ts`**

- Look up conversations without an owner key.
- Resolve session objects from conversation identifiers.
- Remove owner imports, exports, target fields, and header forwarding.
- Forward the verified expiry in production.
- Remove `x-mi-conversation` forwarding and its duplicate internal comparison;
  the selected object identifier supplies the conversation identity.

**7. `src/worker/session/SessionObject.ts`**

- Remove the compound-address builder, parser, separator, and owner field.
- Use the named object identifier as the conversation identifier.
- Remove ownership comparison and owner-qualified catalog and settings reads.
- Remove the owner component from the host marker.
- Retain explicit provisioning and the initialized-storage marker.
- Retain production admission checks for `x-mi-auth-exp` and expiry checks
  before inbound controls and outbound frames.
- Allow development requests and sockets without expiry metadata.
- Remove error state that exists solely for compound owner-address parsing.

**8. `src/client/session/SessionFeed.ts`**

- Remove `authentication_required` from the connection status type.
- Remove the `4401` special case and unused close-code plumbing.
- Use existing offline and reconnect behavior for socket closure.

**9. Tests and browser fixtures**

- Update catalog and session tests to the new signatures and addressing.
- Remove owner-isolation and compound-address tests.
- Give Worker tests explicit storage isolation instead of relying on owner
  keys. Inspect the installed pool's isolation behavior before selecting the
  minimum setup needed.
- Replace `openOwner` with a credential-free `openApp`.
- Remove owner subjects from browser helpers and test cases.
- Add shared serial browser setup that removes existing conversations through
  normal deletion and restores model settings through existing controls.
- Keep two-device tests; both devices use the same application state.
- Delete `tests/e2e/fixture/access.ts`.
- Remove Access key generation, JWKS service, and related configuration from
  `tests/e2e/start-dev.mjs`.
- Remove the browser test asserting `authentication_required`.
- Replace the unauthenticated browser-shell scenario with a development-access
  scenario. Production authentication rejection remains covered in Worker
  tests.
- Update launcher and Playwright comments to describe the resulting setup.

**10. Documentation**

- Update `docs/TODO.md` so future skills and connectors use application-wide
  resources rather than owner-scoped resources.
- Add ADR-0004 references near the changed responsibilities.
- Preserve ADR-0003 references for harness and session-lifecycle behavior.
- Preserve historical ADR and implementation records.

**11. One-time destructive D1 migration (authorized)**

- Before the new Worker serves production, drop the deployed `mi` catalog
  tables once: `DROP TABLE IF EXISTS conversations`, `commands`, and
  `settings`, executed with the current storage mechanism (`wrangler d1
  execute --remote`).
- The new Worker recreates them with the application-wide schema on first use.
  No rows are preserved; the single `settings` row and two orphaned creation
  receipts are discarded.
- No Durable Object storage transition is performed. No conversation row
  addresses a live session, and orphaned storage under old owner-qualified
  addresses is left unreachable.

## Behavior

Production rejects missing, invalid, or expired assertions through the existing
authentication failure path. A cookie alone is not an assertion source.

Development admits requests without a token and performs no JWKS lookup.
Its session operations require neither expiry headers nor fabricated deadlines.

Production session admission requires a valid forwarded deadline. Once that
deadline expires, further inbound controls are rejected and protected outbound
frames are not sent. The socket closes using the existing authentication close
code.

The client handles that closure through its normal connection logic. This does
not promise that a subsequent handshake succeeds, obtains a new assertion, or
navigates to an Access login page.

Conversation creation, replay, rename, deletion, reconnectable history, model
settings, and multiple-device access retain their existing product behavior.

## Tests

- Update authentication unit tests for expiry-only results. Preserve coverage
  of valid assertions, signature rejection, issuer, audience, and expiry.
  Cover missing expiry and development access without a token.
- Verify production HTTP and WebSocket ingress reject missing assertions and
  cookie-only requests.
- Verify development ingress and session operations work without credentials.
- Test production socket expiry on inbound controls and outbound data.
- Preserve catalog creation replay, concurrent creation, deletion, and settings
  tests using application-wide state.
- Preserve session lifecycle, settings application, and history-paging tests.
- Verify close code `4401` follows ordinary client reconnection handling.
- Run browser coverage for conversation management, settings, streaming,
  recovery, reconnect, and multiple devices with no Access fixture.

## Verification

Use the supported execution environment described by the repository's test
runner scripts.

1. Install locked dependencies and generate Worker binding types.
2. Run `npm run test:workers`, which builds the Worker before exercising it.
3. Run `npm run typecheck` and `npm run test:unit`.
4. Run the browser suite with its development configuration and a fresh build.
5. Run `git diff --check`.
6. Inspect remaining references to owner keys, ownership headers, cookie token
   extraction, and `authentication_required` in application code and tests.
7. Review the diff for the accepted scope.

Record actual results during implementation. This planning stage does not claim
that runtime checks have passed. Deployment is outside this plan's execution
authorization.

## Out of scope

- Multi-user support or tenant abstractions.
- Credential acquisition, refresh, or renewal flows.
- Changes to pi-durable scheduling, recovery, or storage semantics.
- Reintroducing skills, MCP connectors, or OAuth integrations.
- Retiring ADR-0003.
- Production deployment, except for the authorized one-time destructive D1
  migration in Changes item 11, which is executed once when deployment is
  authorized.

## Risks

Changing a Durable Object name selects different storage. The existing
owner-qualified names cannot be replaced by conversation-only names while
assuming history follows automatically.

D1 schema creation with `CREATE TABLE IF NOT EXISTS` does not alter existing
tables. The persisted-data transition must cover the catalog schema and session
addressing together.

Removing owners also removes test isolation. Serial browser cleanup must finish
before the next test begins, including stopping sessions through normal
deletion.

Development browser tests do not exercise production authentication. Production
ingress and socket-expiry coverage remains in the unit and Worker suites.

## Open Questions

None. The persisted-data transition is resolved: the destructive one-time D1
migration in Changes item 11 is authorized. A read-only inventory of the
deployed `mi` D1 catalog found `conversations` 0 rows, `settings` 1 row, and
`commands` 2 orphaned `conversation.create` receipts under one owner, so the
migration destroys no conversation history.

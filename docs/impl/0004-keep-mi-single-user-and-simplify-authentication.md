# Impl-0004: Keep mi single-user and simplify authentication

- Created Date: 2026-10-16

## Commits

Implementation commit on `adr-0004`:

- `85f0d1b` keep mi single-user and simplify authentication

The branch was rebased onto the claim commit before merging, so the planning
commits and the earlier implementation commits are squashed into `85f0d1b`; the
implementation tree is unchanged. The hash identifies the verified
implementation commit on the branch, not a target-branch commit. The report is
committed separately and removes `docs/adr/0004.lock`, so merging the PR
releases the claim.

## Result

mi is now permanently single-user. The owner model is removed end to end and
production authentication is reduced to assertion verification plus socket
expiry enforcement.

Implemented:

- `CatalogStore` moved to `src/worker/catalog/CatalogStore.ts` with an
  application-wide schema: `conversations` (primary key `id`, ordered by
  `updated_at` and `id`), a singleton `settings` row addressed by the fixed key
  `app`, and creation receipts keyed by `command_id`. Every method takes only its
  operation inputs and lifecycle callbacks; creation replay, conditional
  activation, rename, deletion, provisioning sequencing, and settings
  validation are preserved without owner predicates.
- `OwnerIdentity`, `ownerKey`, owner request locals, owner RPC context fields,
  owner-qualified session addressing, the compound-address parser, the host
  marker's owner field, and `x-mi-owner`/`x-mi-conversation` propagation and
  comparison are gone.
- `SessionObject` derives its conversation id from `ctx.id.name`, reads
  application-wide catalog and settings rows, and keeps its explicit
  provisioning, initialized-storage marker, deletion gate, and ADR-0003
  lifecycle behavior.
- `AccessVerifier.verify(token)` returns the verified expiry in milliseconds and
  no longer derives an identity or requires a subject. Production still verifies
  signature, issuer, audience, and expiry and requires the expiry claim.
- `verifyAccess(request, env)` reads only `Cf-Access-Jwt-Assertion`. Development
  returns before reading a token or resolving JWKS; production verifies and
  returns the expiry. `CF_Authorization` cookie extraction is removed.
- One `ENVIRONMENT` setting selects the mode. `wrangler.jsonc` sets
  `production`; `.dev.vars.example` documents `development`; the browser-test
  configuration override sets `development` and drops the Access issuer and
  audience overrides. Development admits requests and sockets without a
  deadline; production rejects missing, malformed, non-finite, or expired
  deadlines and overwrites any incoming `x-mi-auth-exp` with the verified value.
- `SessionFeed` no longer has an `authentication_required` state or a `4401`
  special case; closure follows ordinary offline/reconnect handling.
- Browser fixtures no longer sign Access assertions. A shared Playwright
  fixture resets conversations through the normal deletion controls and restores
  model settings through the existing form before each serial test. The launcher
  no longer starts a JWKS endpoint or generates a signing key, and
  `tests/e2e/fixture/access.ts` is deleted.
- `docs/TODO.md` now describes future skills and connectors as application-wide
  resources.

Verification (all executed on `85f0d1b`):

- `npm run cf-typegen` — regenerated `worker-configuration.d.ts` with
  `ENVIRONMENT`; no errors.
- `npm run typecheck` (`tsc --noEmit`) — passed.
- `npm run test:unit` — 14 passed. Covers valid assertions, expiry-only results,
  an assertion without a subject, missing expiry, wrong issuer, wrong audience,
  expired assertion, tampered signature, and an empty token.
- `npm run test:workers` — 31 passed. Runs the built `dist/server/server.js`
  under workerd. Covers application-wide catalog creation/replay/rename/delete,
  concurrent create, `creating` recovery, singleton settings, session
  provisioning, duplicate deletion, closure-failure retry, a delayed open racing
  deletion, settings applied to an outgoing provider request, seeded multi-page
  history, production rejection of missing and expired deadlines, production
  socket expiry on an inbound control frame, and cookie-only rejection for
  server functions and WebSocket upgrades.
- `npm run test:e2e` — 38 passed in 2.0m (narrow and wide) in the browser
  container with the development configuration. Covers development access
  without credentials, conversation management, settings persistence, streaming,
  recovery, reconnect, ordinary reconnection after close code `4401`, and
  multiple devices sharing one application state.
- `git diff --check` — clean.
- Reference search — application code and tests contain no `OwnerIdentity`,
  `ownerKey`, owner-scoped SQL, owner-qualified session addressing, `x-mi-owner`,
  `x-mi-conversation`, `authentication_required`, or cookie token extraction.
  `ACCESS_ISSUER`/`ACCESS_AUDIENCE` remain only as production verification
  configuration, and `OwnerObject` remains only in the historical `wrangler.jsonc`
  Durable Object migration list.

## Deviations

- **Header reader kept.** The plan said to remove the cookie extraction function
  "if it no longer has a separate use." The function is kept as a header-only
  `accessTokenFromRequest`; the cookie branch is removed.
- **Explicit catalog reset in Worker tests.** The installed
  `@cloudflare/vitest-pool-workers` 0.23.0 (Vitest 4) isolates storage per test
  file, not per test. Tests that share the catalog therefore clear it between
  cases through `tests/workers/support/reset.ts`, which creates the schema and
  deletes rows so a missing conversation still resolves to `CONFLICT` rather than
  a missing-table error.
- **Browser isolation fixture.** Test isolation is implemented as an
  automatically applied Playwright fixture that resets state before each test.
  `openApp` stays navigation-only, so opening a second device does not erase the
  first device's state.
- **Environment type widening.** `appEnvironment()` reads the generated
  `ENVIRONMENT` binding through a `string` local, so both `development` and
  `production` are accepted without hand-editing the ignored generated
  declarations. A missing or unknown value is treated as production.
- **Destructive D1 migration not executed.** Changes item 11 is a deployment
  prerequisite. This report does not run `wrangler d1 execute --remote`; the
  catalog tables must be dropped once when production deployment is authorized.

## Follow-ups

- Before the new Worker serves production, run the authorized one-time
  destructive D1 migration: `DROP TABLE IF EXISTS conversations`, `commands`,
  and `settings` against the deployed `mi` database. The new Worker recreates
  them with the application-wide schema on first use. No rows are preserved
  (`conversations` 0 rows, `settings` 1 row, `commands` 2 orphaned receipts).
- No Durable Object storage transition is performed. Storage under old
  owner-qualified object names is left unreachable and is not reclaimed.
- Production deployment and PR merge require explicit authorization and are not
  part of this report.

Resolved on 2026-10-16 when deployment was authorized:

- Read-only inventory re-confirmed `conversations` 0 rows, `settings` 1 row,
  and `commands` 2 orphaned receipts. The three tables were then dropped with
  `wrangler d1 execute mi --remote`. A follow-up query returned an empty
  `sqlite_master` result, so the new Worker will create the application-wide
  schema on its first authenticated catalog request.
- `npm run deploy` succeeded. The deployed version is
  `7b202bbd-b54b-4b85-9166-8d454f212095` with `ENVIRONMENT ("production")`,
  `ACCESS_ISSUER`, and `ACCESS_AUDIENCE` bound. `mi.nomonator.com` is served by
  Cloudflare Access, so unauthenticated external requests receive the Access
  `302` redirect before reaching the Worker; in-Worker production rejection
  remains covered by the Worker suite.

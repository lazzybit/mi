# Plan-0003: Adopt pi-durable as the agent harness

- Created Date: 2026-10-15
- Status: Done

## Target

This version is deliberately small and directly debuggable. Each managed mi
conversation runs in its own SQLite-backed Durable Object, with pi-durable
owning its transcript, submissions, tasks, retries, compaction, and live
state. The owner side is a stateless Worker with a D1 database holding the
conversation catalog and model settings. There is no owner Durable Object.

Retained in this version:

- Authenticated access.
- Conversation creation, inline rename, and permanent deletion.
- Model chat through the existing gateway route mapping.
- Reconnectable history, streaming output, and queue/steer input.
- The mobile interface, local drafts, and settings for the configured model.

Deferred to [TODO](../TODO.md): skills, application tools, MCP connectors and
credentials, OAuth, and repository instructions.

Completion requires:

- The custom execution engine, its storage, projections, and command
  framework are removed.
- The gateway route mapping from ADR-0002 is preserved unchanged.
- Session lifecycle races across D1 and the session object are covered.
- The two browser channels behave as described, including the catalog
  refresh boundary.
- Recovery on the next request or reconnect is the selected behavior; no
  alarm is scheduled.

## Start

The starting implementation is the baseline recorded in
[ADR-0003](../adr/0003-adopt-pi-durable-as-the-agent-harness.md).

One `OwnerObject` currently owns every conversation, execution record, shared
resource, and client subscription for an owner. `OwnerRuntime` connects the
custom driver, recovery, context preparation, command receipts, storage, and
revision-based synchronization. The source inventory contains 13,678 lines;
tests contain 4,478 lines.

`@earendil-works/pi-durable@1.2.0` provides the harness, the Cloudflare SQLite
storage adapter, submissions, tasks, compaction, and `root.watch()`. It is not
yet a dependency. The published 1.2.0 package matches the version in the
upstream manifest cited by the ADR; the upstream changelog also contains an
`Unreleased` section, so only the published release is implementation
evidence.

The existing model mapping is `dynamic/runner -> deepseek/deepseek-flash`,
dispatched through gateway `mi` with keyless AI-binding authentication and
catalog-derived metadata. That mapping is retained.

## Architecture

### Request and owner boundary

Keep the Worker entry as the only authenticated request boundary. It verifies
access, then either serves catalog operations or forwards a selected-session
WebSocket to the session object. The owner identity scopes every catalog row
and every session address.

There is no owner Durable Object and no owner WebSocket. Catalog operations are
plain Worker code backed by D1.

### Owner store

Use one D1 database for the owner-scoped catalog and settings:

- `conversations(id, owner_key, title, lifecycle, created_at, updated_at)`.
- `settings(owner_key, model_json, updated_at)`.
- `commands(command_id, owner_key, kind, result_json, outcome, created_at)`
  for creation receipts and deduplication.

Lifecycle is `creating -> active -> deleting -> absent`. Writes reach the D1
primary, and a `batch()` is one SQL transaction that rolls back on failure.
Authorization checks use primary reads and conditional statements; check
affected-row counts rather than assuming success.

### Session execution

Add `SessionObject` and a `SESSION` binding. Derive its address from the
verified owner and the managed conversation identifier. Keep that external
identifier separate from pi-durable's numeric identifiers.

Provision one storage with `openDurableObjectSqliteStorage(ctx.storage)`, open
the harness, and create its root conversation. Persist a host marker so an
initialized session is distinguishable from empty storage.

Only an explicit provisioning request may initialize empty storage. Ordinary
reads, reconnects, and delayed requests cannot create a missing session. The
session object serializes provisioning, admission, and deletion, and never
provisions for a catalog entry that is not `active`.

On reopen, install the models and an empty application extension registry,
then call `resume()`. Browser disconnects dispose observation without closing
the harness.

### Models

Construct a pi-ai `Models` collection and register the gateway route model so
generation resolves it through `getModel("gateway", "dynamic/runner")`.

A small provider adapter supplies the AI-binding fetch. Preserve gateway `mi`,
the `dynamic/runner` dispatch identity, the `deepseek/deepseek-flash` catalog
lookup, `openai-completions`, suppressed provider credentials, catalog-derived
metadata, and fixture routing. `ConversationStreamOptions` does not expose a
fetch override, so the fetch is supplied at the provider API boundary.

### Browser channels

- Catalog: HTTP calls to Worker code backed by D1. The client fetches on
  startup, on focus/reconnect, and after a completed mutation. Immediate
  cross-device catalog broadcasts are intentionally not provided.
- Selected session: one WebSocket directly to the session object carrying the
  `root.watch()` view. The initial frame is the current view; later frames are
  raw Chord operations applied with `applyImmutable`. Reconnect acquires a
  fresh watch. Switching conversations discards callbacks from the previous
  socket.

Submission, withdrawal, cancellation, and history paging travel over the
session WebSocket as small control frames. History uses
`conversation.entries()` and its opaque cursors.

### Deferred capabilities

Skills, application tools, MCP, credentials, OAuth, and repository
instructions are not implemented in this version. The session uses an empty
application extension registry; generation and compaction remain upstream.

## Changes

**1. `package.json`, `package-lock.json`**

- Add `@earendil-works/pi-durable@1.2.0` and the directly imported
  `@earendil-works/chord@1.2.0`.
- Keep `@earendil-works/pi-ai@1.2.0`.

**2. `wrangler.jsonc`**

- Remove the `OWNER` binding and the `OAUTH_CLIENT_METADATA_URL` var.
- Add a `SESSION` binding for `SessionObject`.
- Add a `DB` D1 binding.
- Preserve migration `v1`; append `v2` with
  `new_sqlite_classes: ["SessionObject"]` and
  `deleted_classes: ["OwnerObject"]`. The legacy `migrations` array stays; do
  not introduce declarative Durable Object `exports`.
- Deploying `v2` permanently discards the old `OwnerObject` namespace,
  including its conversations, settings, credentials, and skills. This is
  authorized; no conversion code is written.

**3. `src/worker/index.ts`**

- Remove the `OwnerObject` export.
- Keep the Solid handler route and asset fallback.
- Route the session WebSocket to the `SESSION` namespace after verifying
  access and checking the catalog lifecycle.
- Remove the MCP OAuth callback route.

**4. `src/worker/owner/`**

- Remove `OwnerObject.ts`, `OwnerRuntime.ts`, and `DurableObjectBase.ts`.
- Add a small owner catalog module that reads and writes D1: create, list,
  rename, mark deleting, delete, and creation receipts.

**5. `src/worker/session/SessionObject.ts` (new)**

- Own one pi-durable session: provisioning, `resume()`, the watch socket,
  submission/withdrawal/abort control frames, and history paging.
- Quiesce, close, and `ctx.storage.deleteAll()` on deletion.
- Serialize lifecycle transitions with `blockConcurrencyWhile` and an
  in-memory flag.

**6. `src/worker/runtime/`, `src/worker/context/`, `src/worker/sync/`**

- Remove entirely (`RunDriver`, `RunMachine`, `AttemptExecutor`,
  `RecoveryService`, `RetryBookkeeping`, `OutputCommitter`, `WakeScheduler`,
  `TransitionCoordinator`, `ToolPolicy`, `ContextAssembler`, `ContextBudget`,
  `SyncHub`), moving any still-used small utility first.

**7. `src/worker/storage/`**

- Remove execution tables, repositories, records, projections, and
  artifact-reference traversal.
- Keep only what the owner store needs, now backed by D1.

**8. `src/worker/conversations/`, `src/worker/rpc/`**

- Remove `services.ts` and `CommandProcessor.ts`.
- Replace `OwnerRpc`/`OwnerRpcClient` with direct D1-backed server functions
  and a session RPC used by the Worker.
- Keep `RpcContext` for the verified owner, without a Durable Object stub.

**9. `src/worker/models/`**

- Replace `GatewayModelGateway.ts` with a small factory returning pi-ai
  `Models`; delete the custom request/event envelopes and legacy conversion.
- Keep `ModelRoutes.ts`, `StoredSettings.ts`, and the gateway mapping
  unchanged.

**10. `src/worker/mcp/`, `src/worker/skills/`**

- Remove entirely. Their responsibilities are recorded in `docs/TODO.md`.

**11. Client**

- `src/App.tsx`, components, and `src/rpc/`: read the catalog from D1-backed
  server functions and observe the selected session over its socket.
- Remove `RecoveryPanel`, attempt resolution, `ConversationReducer`,
  `OwnerSnapshot`, `ViewChange`, run/attempt view types, and the generic
  command dispatcher.
- Keep a narrow pending-submission store keyed by `conversationId` and the
  upstream `requestId`; management actions report their result directly and
  are not automatically replayed.
- Keep drafts, inline rename, deletion confirmation, settings, and the mobile
  layout.

**12. Tests and fixtures**

- Replace `tests/helpers/runtime.ts` and alarm fixtures with a small
  real-harness fixture using an upstream storage backend and fake provider
  I/O.
- Remove suites for the retired engine and peripherals.
- Keep and adapt authentication, catalog, session, and browser coverage.

**13. `docs/TODO.md`**

- Add deferred entries for skills and repository instructions, application
  tools, MCP connectors and credentials, and unattended session recovery.
- Preserve the existing TODO history.

## Behavior

- **Create**: allocate the id, insert a `creating` row and a creation receipt
  in one batch, activate it conditionally, then provision the session. A retried
  command with the same id returns the same conversation. A retried create whose
  conversation is absent does not provision a new session.

  Implementation clarification (recorded during implementation): activation
  precedes explicit provisioning. The session refuses to provision a row that is
  not `active`, so the creating row must become active before the session is
  initialized. An `active` row whose session has not been initialized yet
  rejects ordinary session access with a retryable `NOT_READY`, and only a
  retried create may provision it. This resolves the ordering ambiguity between
  "initialize the session, then set active" and the active-only provisioning
  guard without introducing another lifecycle state.
- **Rename**: an owner-scoped conditional update; empty titles are rejected.
- **Delete**: set `deleting` conditionally, ask the session to quiesce and
  erase storage, then delete the row. A retry resumes the sequence. A missing
  row means the deletion already completed. A crash after erasure cannot
  re-initialize the session.
- **Submit**: uses upstream `requestId` deduplication. Busy input uses
  upstream follow-up or steering. Withdrawal uses upstream submission abort;
  cancellation uses upstream conversation abort.
- **Auth**: both channels derive ownership from the verified assertion.
  Expired authentication ends access to both. Catalog responses contain no
  credentials.
- **Catalog refresh**: a second device converges on reconnect or focus, not
  through an immediate broadcast.
- **Recovery**: closing the browser ends observation only. Cloudflare
  restarting the object stops the in-memory scheduler while committed work
  survives. A run interrupted this way continues when the next request,
  reconnect, or message activates the session, and `resume()` then runs. No
  alarm is scheduled, so completion while no client ever reconnects is not
  guaranteed.

## Tests

| Coverage | Reason |
|---|---|
| Gateway model lookup and one model request through the built Worker | Generation now consumes `Models` directly; a missing registration or binding fetch would prevent chat. |
| Create/rename/delete retries, `creating`/`deleting` races, and stale initialization | Lifecycle crosses D1 and the session object; a delayed request must not resurrect or duplicate a conversation. |
| Submission acknowledgement loss, disconnect, reconnect, and history paging | Mobile clients must recover accepted input and committed history without owning execution. |
| Authenticated session routing and expired access | Sessions become separately addressable resources. |
| Catalog fetch on startup, focus/reconnect, and after mutation | The catalog has no live broadcast, so the refresh boundary is the product behavior. |
| Existing rename, deletion confirmation, settings, and mobile layout scenarios | These retained controls must keep working with the replacement data flow. |

Update the existing adapter, owner, client, and browser suites where
applicable. Do not duplicate upstream scheduler, compaction, or provider
conformance matrices.

## Verification

1. Install the pinned dependencies with `npm ci`.
2. Run `npm run typecheck`.
3. Run `npm run test:unit`.
4. Run `npm run test:workers`, including its production build.
5. Run `npm run test:e2e`.
6. Run a Wrangler deployment dry run and inspect the emitted bundle; confirm
   that codemode, image processing, Node environments, and browser provider
   runtime modules are absent.
7. Inspect imports and storage access for remaining consumers of the retired
   engine and peripherals. Compare source and test inventories with the ADR
   baseline.
8. Validate the `v2` migration on a non-production namespace and confirm the
   old namespace is removed and a fresh session provisions.
9. With pending work, restart the object and confirm the run resumes on the
   next request or reconnect.

## Out of scope

- Skills, skill resources, application tools, and repository instructions.
- MCP connectors, tool discovery, credential storage, OAuth, and the MCP tool
  bridge.
- A second execution engine, feature flag, or dual-read runtime.
- Historical data conversion, legacy attempt reconstruction, and manual
  outcome resolution.
- Owner-wide run serialization, cross-conversation busy state, and immediate
  catalog broadcasts.
- A replacement context estimator, compaction planner, or retry algorithm.
- Subagent, fork, task-graph, reset, and manual-compaction interfaces.
- Codemode, tool search, local execution environments, and container
  provisioning.
- Image processing and new multimodal capabilities.
- Additional model routes, provider protocols, and credential-discovery
  modes.
- Usage dashboards, reasoning inspectors, and unbounded tool-output storage.
- Global artifact cleanup or inference of historical artifact ownership.
- A generic distributed transaction, job orchestration, or command framework.
- A new client state framework or visual redesign.
- Alarm-based unattended recovery and any other host wake mechanism.

## Risks

- **Published-package differences**: use the inspected release and lockfile
  integrity as evidence; do not rely on unreleased upstream changes.
- **D1 and session coordination**: there is no transaction spanning D1 and a
  session object. Use conditional SQL, affected-row checks, and an idempotent
  deletion sequence; keep the session's own lifecycle gate.
- **Catalog freshness**: without a live catalog channel, another device sees
  changes only on refresh; this is a deliberate reduction from the previous
  behavior.
- **Host lifecycle**: a deployment or runtime shutdown can stop a run.
  Recovery depends on the next request or reconnect, which is the selected
  behavior; unattended completion across a restart is not guaranteed.
- **Bundle and observation cost**: measure the actual Worker and browser
  bundles; upstream active views grow with conversation history, so do not
  add a second materialized transcript.

## Open Questions

None.

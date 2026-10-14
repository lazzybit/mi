# Tasks: Build a mobile-first durable web harness

- Created Date: 2026-10-14
- Status: In progress
- Plan: [PLAN.md](./PLAN.md)

This document tracks implementation. [PLAN.md](./PLAN.md) remains the
authoritative reference for architecture, contracts, behavior, tests, and
out-of-scope boundaries. Tasks here reference plan sections instead of copying
interfaces or schema tables. Nothing in this file overrides the plan; where the
two disagree, the plan wins and this file is corrected.

Milestones follow the implementation order in the plan's **Verification**
section. Every implementation task is unchecked. Each milestone carries its own
verification; see **Verification layers** for how automated, phone, and live
checks differ.

## Milestones

| Milestone | Depends on | Scope and completion gate |
| --- | --- | --- |
| M0 — Deployment foundation | — | Solid handler and `OwnerObject` export coexist in one Worker; pinned dependencies, bindings, migrations, build, type generation, and test scaffolding exist. Gate: `npm run build` and `npm run typecheck` pass with no deployment credentials. |
| M1 — Authenticated durable state | M0 | Shared contracts, Access verification, owner routing, schema, repositories, artifacts, RPC validation, and command receipts work against fixture identities. Gate: deployment/RPC and persistence/scheduling test groups pass. |
| M2 — Durable execution and reconnect | M1 | Fake model and MCP services drive submission, alarms, single-driver execution, queue/steer/cancel, recovery, committed output, snapshots, hibernatable sockets, and a minimal client with a durable outbox. Gate: execution/recovery and sync test groups pass without network access. |
| M3 — AI Gateway and model protocols | M2 | AI binding adapter and all three specified codecs preserve tool IDs, continuation data, stream error boundaries, and bounded interruption recovery. Gate: codec and model-interruption tests pass against recorded fixtures. |
| M4 — Existing helper integrations | M2, M3 | Streamable HTTP, tool catalog, explicit Access delegation, credential expiry, dispatch validation, cancellation, and unsafe-outcome reconciliation work against fixtures. Gate: MCP/authentication test group passes and no credential crosses an untrusted destination. |
| M5 — Connectors, skills, and context | M4 | OAuth and the other authentication modes, connector settings, versioned skills, repository instructions, context budgets, compaction, and bounded result retrieval are complete. Gate: skills/context/sync test group passes. |
| M6 — Mobile and integrated acceptance | M5 | Responsive UI and settings surfaces complete; stale bundles, reconnect, device switching, scrolling, keyboard behavior, and the full workflow are verified. Gate: browser e2e passes; owner-phone checks recorded; live smoke tests optional. |

## M0 — Deployment foundation

Goal: establish a build that can host both the Solid handler and the Durable
Object before any feature work. Resolve the plan's Worker-entry constraint
first (PLAN.md → Deployment shape; Risks; Changes 1; Verification step 1).

- [x] **M0-T01 Resolve Worker entry (Solid handler + `OwnerObject` export).**
  Try the plan's approaches in order and record the selected one in the
  implementation. Deliverable: a minimal Worker entry that serves the Solid
  handler and exports the `OwnerObject` class. Completion: a fixture test
  confirms the class is exported and the Solid handler is reachable.
- [x] **M0-T02 Scaffold the Vite + Solid 2 + TypeScript build.** Configure
  `solid({ start: true, serverFunctions: true })` and
  `cloudflare({ viteEnvironment: { name: "ssr" } })` in the documented order.
  Completion: dev and production builds emit client assets and a server handler.
- [x] **M0-T03 Write `wrangler.jsonc` bindings.** Static `ASSETS` binding, the
  SQLite Durable Object binding and migration, and the `AI` binding.
  Completion: local dev serves assets and the Durable Object binding resolves.
- [x] **M0-T04 Pin dependency versions and generate binding types.**
  Completion: `npm run cf-typegen` produces `env` types matching
  `wrangler.jsonc`; the lockfile is committed.
- [x] **M0-T05 Stand up the test scaffolding.** Unit, Workers-runtime, and
  browser runners with the injectable interfaces the plan requires (model
  transport, MCP transport, credential provider, time source). Completion: one
  trivial test passes in each runner.
- [x] **M0-T06 Define the project scripts.** `npm ci`, `npm run cf-typegen`,
  `npm run typecheck`, `npm run test:unit`, `npm run test:workers`,
  `npm run build`, `npm run test:e2e`. Completion: every script runs, even if
  some suites are empty.
- [x] **M0-T07 Workers-runtime spike for model and MCP SDKs.** Verify the
  planned model adapter and an MCP client initialize under Workers (no Node
  assumptions) before the full UI exists. Completion: a Workers-runtime smoke
  test records the outcome and any required adapter work.

**Verification (M0).** Automated, no deployment credentials: `npm run build`,
`npm run typecheck`, `npm run cf-typegen`, and the three test runners. No phone
or live-service check at this milestone.

## M1 — Authenticated durable state

Goal: durable, owner-scoped state reachable through typed server functions with
fixture authentication. Covers Changes 2–6 and the plan's
deployment/RPC and persistence/scheduling tests.

- [x] **M1-T01 Define `src/shared/` contracts.** Domain, command, and wire types
  from Shared contracts. Completion: shared types compile and are consumed by
  both client and worker placeholders.
- [x] **M1-T02 Implement Access assertion verification.** Verify issuer,
  audience, signature, subject, and expiry; produce `OwnerIdentity` and a
  private delegated-credential update. Completion: fixture JWKS tests cover
  accept/reject for each claim.
- [x] **M1-T03 Owner resolution and ingress routing.** Derive the Durable Object
  name from `issuer|subject`; route `/_server`, assets, `/ws` (placeholder), and
  the OAuth callback. Completion: cross-owner requests cannot reach another
  owner's object.
- [x] **M1-T04 Storage schema, migrations, repositories, transactions.**
  Implement every table in Persistence and scheduling plus revision allocation.
  Completion: migration runs from empty storage and repository round-trips pass.
- [x] **M1-T05 Chunked artifact storage.** Immutable artifacts with digest,
  completion flag, and chunk reads. Completion: a multi-chunk artifact
  round-trips and partial artifacts are distinguishable.
- [x] **M1-T06 RPC context and validation.** `RpcContext`, command schemas,
  runtime argument validation, request-local context capture, and delegation to
  `OwnerObject`. Completion: invalid arguments and missing auth are rejected
  before any domain call.
- [x] **M1-T07 Command receipts and idempotency.** Repeated `commandId` with the
  same normalized payload returns the original receipt; reuse with a different
  payload returns `409 CONFLICT`. Completion: tests cover both cases and
  acknowledgement loss.
- [x] **M1-T08 Implement the server-function modules.** `conversations`, `runs`,
  `settings`, `connectors`, `skills`, `artifacts` with the representative
  contracts. Completion: each returns only serializable public DTOs; private
  modules and credentials are absent from client chunks.

**Verification (M1).** Automated, no deployment credentials: deployment/RPC and
persistence/scheduling test groups — export coexistence, fixture
authentication, client-chunk secret absence, argument validation, cross-owner
rejection, receipt replay/conflict, stale-bundle command resend, duplicate
submission IDs, queue/steer order, and reconstruction from storage.

## M2 — Durable execution and reconnect

Goal: the durable submit → execute → reconnect path works end to end with fake
model and MCP services. Covers Changes 7, 8, and 12 and the execution/recovery
and sync tests.

- [x] **M2-T01 `OwnerObject` lifecycle.** Startup reconstruction, HTTP,
  WebSocket, and alarm dispatch, and transient service wiring. Completion:
  reconstruction rebuilds repositories and pending work from storage.
- [x] **M2-T02 `TransitionCoordinator` and `WakeScheduler`.** Implement the
  plan's acceptance sequence and alarm reconciliation. Completion: an alarm
  injected between scheduling and submission commit never loses acknowledged
  work, and one live generation has exactly one driver.
- [x] **M2-T03 `RunMachine` pure transitions.** Implement every `RunMachine`
  event/state pair with an explicit transition or rejection. Completion: the
  full matrix is covered by table-driven tests.
- [x] **M2-T04 `RunDriver` slice execution.** `driveSlice()`, generation guards,
  slice budget, cancellation signalling, and stale-completion rejection.
  Completion: old completions cannot overwrite cancellation; a slice exit
  leaves work scheduled.
- [x] **M2-T05 `AttemptExecutor`, `ToolRouter`, `ToolPolicyRegistry`.**
  Sequential tool rounds against fake MCP with replay-policy resolution and
  dispatch-intent persistence before any external effect. Completion: tool
  dispatch intent is persisted before an external effect.
- [x] **M2-T06 `OutputCommitter` and committed partial output.** Coalesced
  batched appends, final flush, and settlement without duplicate text.
  Completion: snapshots contain committed partial output only.
- [x] **M2-T07 `RecoveryService` and the recovery matrix.** Handle `prepared`,
  dispatched-safe, dispatched-unsafe, completed, and cancellation-requested
  states. Completion: each row of the plan's recovery matrix has a test.
- [x] **M2-T08 Conversation, submission, and run-control services.** Implement
  `queue`/`steer` semantics, withdrawal, durable cancellation, and
  `resolveAttempt`. Completion: steering joins only at a tool-round boundary and
  never reinterprets as `queue`.
- [x] **M2-T09 `SnapshotReader`, `ViewProjector`, `SyncHub`.** Hibernatable
  socket attach with a synchronous bounded snapshot, revisioned frames, and
  resnapshot on sequence gaps. Completion: a commit during attachment is
  observed once; a surviving socket gets a fresh stream after reconstruction.
- [x] **M2-T10 Minimal client feed and outbox.** `ConversationFeed`,
  `ConversationReducer`, `CommandDispatcher`, `CommandOutbox`, and
  `DraftStore` enough to submit, reconnect, and resend after acknowledgement
  loss. Completion: a duplicate resend produces one accepted command.

**Verification (M2).** Automated, no deployment credentials: execution/recovery
and sync test groups — driver uniqueness, stale completions, snapshot
consistency, hibernatable reconstruction, observer cleanup not cancelling
execution, and authentication expiry not causing endless reconnect.

## M3 — AI Gateway and model protocols

Goal: real model transport through the AI binding with faithful protocol
handling and bounded interruption recovery. Covers Changes 9 and the
model-interruption behavior and codec tests.

- [x] **M3-T01 Model profile selection.** Resolve exactly one configured profile;
  unsupported protocol selection is a configuration error before a run starts;
  no automatic provider or model fallback. Completion: tests cover the
  configuration error path.
- [x] **M3-T02 `AiBindingTransport`.** Isolate the AI binding's
  universal-request API behind `GatewayTransport`. Completion: tests substitute
  `FakeGatewayTransport` and never reach the binding.
- [x] **M3-T03 `OpenAIResponsesCodec`.** Responses input items, function-call IDs
  and results, reasoning and encrypted continuation items. Completion: vendor
  stream fixtures round-trip tool IDs and continuation fields.
- [x] **M3-T04 `OpenAIChatCodec`.** Assistant/tool message pairing, tool-call
  IDs, and Chat Completions stream framing. Completion: fixture tests preserve
  pairing and IDs.
- [x] **M3-T05 `AnthropicMessagesCodec`.** Content blocks, `tool_use`/
  `tool_result` IDs, thinking signatures, and stop reasons. Completion: fixture
  tests preserve signatures and stop reasons.
- [x] **M3-T06 `ModelGateway` streaming.** Decode into `ModelEvent` streams;
  propagate partial streaming errors to the driver with no invisible retry
  inside the codec. Completion: a mid-stream error surfaces once and is not
  retried transparently.
- [x] **M3-T07 Persist assistant output and native continuation.** Store
  canonical display content plus the native continuation representation; create
  tool attempts only from a complete valid response. Completion: tools are never
  dispatched from partial arguments.
- [x] **M3-T08 Model-interruption recovery.** Retain committed partial output as
  interrupted, create a replacement attempt from the same valid context
  boundary, and bound retries. Completion: a regenerated answer is not appended
  as one stream, and repeated failure ends in an explicit recoverable failure.

**Verification (M3).** Automated, no deployment credentials: codec fixtures for
all three protocols plus model-interruption tests. No live gateway required;
live gateway calls belong to the optional smoke tests.

## M4 — Existing helper integrations

Goal: connect the deployed helpers over Streamable HTTP with correct
authentication, dispatch, cancellation, and unsafe-outcome handling. Covers
Changes 8 and 10 and the MCP/authentication tests, plus helper integration in
Verification step 5.

- [x] **M4-T01 `McpTransportFactory` and `McpSessionManager`.** Streamable HTTP
  open/acquire/release/invalidate, `detach()` versus `terminateSession()`, and
  automatic retries of `tools/call` disabled. Completion: session loss is not
  treated as proof that remote work stopped.
- [x] **M4-T02 `ToolCatalog` discovery and aliases.** Enumerate all tool pages,
  derive bounded aliases, reserve an application-tool prefix, and surface
  collisions. Completion: refresh never silently repoints an alias at another
  connector.
- [x] **M4-T03 `CredentialBroker` and `DestinationPolicy`.** Explicit Access
  delegation forwarding, credential leases, and destination validation.
  Completion: no assertion during untrusted probing, no credential across a
  cross-origin redirect, exact-destination forwarding only.
- [x] **M4-T04 `ConnectorService`.** `add`, `update`, `connect`, `disconnect`,
  `refreshTools`, and role assignment. Completion: disconnecting preserves
  history that referenced the connector's tools.
- [x] **M4-T05 Tool dispatch boundary.** Resolve configuration, validate
  arguments with an interpreted JSON Schema validator, obtain a credential
  before marking `dispatched`, and pin connector/catalog versions. Completion:
  no usable credential yields `waiting_for_auth` with no dispatched effect.
- [x] **M4-T06 Cancellation propagation.** Distinguish cancellation requested,
  local execution stopped, remote execution confirmed stopped, and remote
  outcome still unknown. Completion: stopping a browser wait never sends MCP
  session deletion.
- [x] **M4-T07 Unsafe-outcome reconciliation.** Persist unresolved calls with
  arguments, session information, and known output; mark `needs_attention`;
  block further mutating runs against the shared workspace; expose explicit
  resume/retry that creates a new linked attempt. Completion: an interrupted
  `bash` is never labelled definitely failed or stopped and is never replayed.

**Verification (M4).** Automated, no deployment credentials: MCP and
authentication test groups — discovery, registration priority, OAuth
success/failure/expiry/rotation/consumed-code, cross-owner callback rejection,
Access delegation destination rules, credential expiry pausing before dispatch,
tool-list changes, namespace collisions, and unknown-outcome non-replay.

## M5 — Connectors, skills, and context

Goal: full configuration surface plus skills, repository instructions, context
budgets, and compaction. Covers Changes 11 and 13 and the skills/context/sync
tests.

- [x] **M5-T01 `AuthDiscovery`.** Protected-resource metadata from challenge
  then endpoint-path then root; authorization-server metadata fallback order.
  Completion: fixtures cover both protected-resource mechanisms and each issuer
  metadata fallback.
- [x] **M5-T02 `OAuthCoordinator`.** `begin`/`complete`/`refresh` with PKCE S256,
  resource indicators, fixed callback URI, stored state consumption, and
  registration priority. Completion: a consumed code or rotated refresh token
  never loops and requires fresh authorization.
- [x] **M5-T03 OAuth routes and remaining auth modes.** Public
  `/oauth/client-metadata.json`, authenticated
  `/api/mcp/oauth/callback`, and `none`/`header`/`auto`/`cf-access` modes.
  Completion: client metadata is publicly reachable and credential-free; the
  callback is owner-authenticated.
- [x] **M5-T04 `SkillRegistry` and `SkillTools`.** Versioned skills, immutable
  versions, per-conversation selection, reserved `read_skill` and
  `read_skill_resource` tools with normalized, traversal-safe paths. Completion:
  deleting a skill hides it from future selection while preserving versions
  referenced by past turns.
- [x] **M5-T05 `ContextAssembler` and `ContextBudget`.** Immutable context
  snapshots from history, summaries, skills, and bounded artifacts;
  `prepare()` never makes an untracked model call. Completion: a dispatched
  request keeps its pinned skill and tool versions.
- [x] **M5-T06 `CompactionPlanner`.** Persisted compaction attempts with an
  explicit source range and digest; never compact unresolved tool rounds or
  split a call from its result. Completion: compaction preserves source history
  and unresolved outcomes and never converts uncertainty into success.
- [ ] **M5-T07 Repository and bounded-result tools.**
  `RepositoryContextService`, `read_repository_instructions`, and
  `read_tool_result`. Completion: context assembly reads committed instruction
  records and hides no remote I/O inside prompt rendering.
- [x] **M5-T08 Settings, connectors, and skills surfaces (server side).** The
  server functions and views backing model settings, connector management, and
  skill management. Completion: configuration changes are versioned and
  observable through snapshots.

**Verification (M5).** Automated, no deployment credentials: skills, context,
and sync test groups — skill CRUD/versioning/historical references,
selected-resource boundaries, context assembly, compaction invariants, snapshot
consistency, and observer cleanup.

## M6 — Mobile and integrated acceptance

Goal: the requested mobile workflow, settings surfaces, and cross-device
behavior, verified automatically where possible and on the owner's phone where
required. Covers Change 13 and the mobile/browser tests.

- [ ] **M6-T01 `AppShell` and `Composer` mobile behavior.** Dynamic viewport
  height, safe-area padding, keyboard-visible composer, touch-sized controls.
  Completion: automated narrow/wide viewport tests pass.
- [ ] **M6-T02 `Transcript` and `ToolCallCard`.** Bounded rendering, history
  pagination, reading-position preservation, auto-follow only near the end,
  folded summaries with on-demand full results, independently scrolling code
  and diff blocks. Completion: browser tests cover scrolling and detail
  retrieval.
- [ ] **M6-T03 Run status and recovery surfaces.** `RunStatusBar`, `QueuePanel`,
  and `RecoveryPanel` (only for a real unresolved outcome, never a generic
  approval screen). Completion: queue/steer controls appear only during a run.
- [ ] **M6-T04 Settings and skill editors.** `SettingsScreen`,
  `ModelSettingsForm`, `McpConnectionList`, `McpConnectionEditor`, `SkillList`,
  `SkillEditor`, `ConversationSkillPicker`; single-column narrow layouts with no
  hover-only actions. Completion: browser tests cover each surface at narrow
  width.
- [ ] **M6-T05 Connection states and stale bundles.** `connecting`, `live`,
  `reconnecting`, `authentication_required`, `offline`, and the outbox behavior
  when generated function references change. Completion: pending commands
  survive a stale bundle and resend through the current reference.
- [ ] **M6-T06 Reconnect and device switching e2e.** Submission acknowledgement
  loss, duplicate resend, reconnect without waiting for a model response, and a
  second device seeing the same server state. Completion: automated e2e passes.
- [ ] **M6-T07 Browser automation.** Narrow and wide viewports, touch
  interaction, safe areas, and orientation changes. Completion: the browser
  suite passes.

**Verification (M6).** Automated: the browser e2e suite above. Owner-phone,
pending and recorded manually: software-keyboard behavior, screen lock, and
network changes (emulation alone does not establish these; no particular phone
model required). Optional live smoke tests, only with owner-supplied
configuration and a disposable workspace: authenticate; verify an
Access-delegated call against each helper; complete a model and tool round
through AI Gateway; perform research, file inspection, editing, and test
execution; disconnect and reconnect on one device; open from a second device;
exercise an expired-credential pause and resume; exercise an uncertain remote
mutation without duplicate execution; demonstrate the repository workflow with
instructions, skills, and a configured connector.

## Verification layers

These categories are deliberately separate; do not present one as another.

1. **Automated, no deployment credentials (required).** The unit, Workers, and
   browser suites, run through the project commands below. The environment
   supplies controlled identities and endpoints and never adds a production
   authentication bypass.
2. **Owner-phone manual checks (required, pending).** Keyboard, screen lock, and
   network changes; recorded when performed.
3. **Optional live-service smoke tests.** Only with owner-supplied configuration
   and a disposable workspace; not part of the ordinary suite.

Project commands (future verification requirements; they do not exist yet and
nothing here claims they pass):

```sh
npm ci
npm run cf-typegen
npm run typecheck
npm run test:unit
npm run test:workers
npm run build
npm run test:e2e
```

## Coverage map

| Plan change | Milestone |
| --- | --- |
| 1. Project and deployment configuration | M0 |
| 2. `src/shared/` | M1 |
| 3. `src/rpc/` and `src/worker/rpc/` | M1 |
| 4. `src/worker/index.ts` and `src/worker/auth/` | M1 |
| 5. `src/worker/owner/OwnerObject.ts` | M2 |
| 6. `src/worker/storage/` | M1 |
| 7. `src/worker/conversations/` | M2 |
| 8. `src/worker/runtime/` | M2, M4 |
| 9. `src/worker/models/` | M3 |
| 10. `src/worker/mcp/` | M4, M5 |
| 11. `src/worker/skills/` and `src/worker/context/` | M5 |
| 12. `src/worker/sync/` | M2 |
| 13. `src/client/` | M2 (minimal), M6 |
| 14. `tests/` | all milestones |

| Plan test group | Milestone |
| --- | --- |
| Deployment and RPC | M1 |
| Persistence and scheduling | M1, M2 |
| Execution and recovery | M2, M3 |
| MCP and authentication | M4, M5 |
| Skills, context, and sync | M2, M5 |
| Mobile and browser | M6 |

## Notes

- M0-T01 is the only true blocker: no feature work starts until the Worker entry
  is resolved and recorded.
- Dependencies are directional; a task may begin when its milestone's
  dependencies are met even if the task list is not strictly serial.
- New tasks should reference a `PLAN.md` section and state an observable
  completion criterion. Do not expand scope beyond the plan's **Out of scope**
  list without updating the plan first.

## Implementation log

### 2026-10-14 — M0 foundation and M1/M2 durable path

**M0-T01 — Worker entry (resolved, recorded).** Selected the plan's approach 2:
a thin authored Worker entry (`src/worker/index.ts`) that imports the Solid
handler virtual module (`virtual:solid-ssr-handler`) and exports both
`OwnerObject` and `handleRequest`. `wrangler.jsonc` points `main` at that entry.
The client-mode shell prerender imports the built server bundle in Node, so the
Durable Object base class deliberately avoids a runtime `cloudflare:workers`
import (`src/worker/owner/DurableObjectBase.ts`); bindings are read through a
request-scoped `AsyncLocalStorage` (`src/worker/context/WorkerEnv.ts`) instead.
Verified by `tests/workers/entry.test.ts` in workerd.

**Build and validation.** `npm run cf-typegen`, `npm run typecheck`,
`npm run build`, `npm run test:unit` (58 passing) and `npm run test:workers`
(12 passing, includes fixture-authenticated routing, DO idempotency, cross-owner
isolation, and a client-chunk secret scan) all pass locally. No deployment
credentials are required.

**Termux note.** `workerd` ships glibc builds and rejects Android; the
repository includes `scripts/workerd-android.sh` (adapted from the local
Termux convention) to run workerd through `glibc-runner`. Re-run it after every
`npm install`. This is a local-development workaround only; the deploy target is
unmodified Cloudflare Workers.

**M0-T05 — browser runner pending.** The unit and Workers runners are live.
The Playwright project (`npm run test:e2e`) is configured but browser binaries
are not installed on this host yet; browser tests are recorded as pending, not
passing.

**M0-T07 — spike outcome.** The planned model adapter and MCP client will be
implemented directly against `fetch`/WebCrypto (no Node-assuming SDK), so the
Workers-runtime smoke test is folded into the M3 AI-binding and M4 MCP tests.

**M2-T10 — pending.** The durable execution path is complete and tested with
fake model and tool services; the Solid client feed, outbox, and UI are the next
implementation block (M2-T10 and M6).

**Deviations recorded.** (1) Server functions route through the Solid
`handleRequest` (not the standalone `handleServerFunctionRequest`) so the
authentication middleware chain runs; the endpoint returns `401` without a
verified Access assertion. (2) The app is named `mi`; "harness" is not used as
a product name. (3) After a tool round the driver returns to `prepare_context`
so steering input and tool results are re-snapshotted before the next model
turn.

### 2026-10-14 — M3 model protocols, M4 MCP, M5 auth/skills/context, client

**M3 — AI Gateway and model protocols.** `AiBindingTransport` resolves the
provider-scoped AI Gateway URL through the binding and lazily reads `env.AI`
(eager access requires remote bindings). `GatewayModelGateway` selects exactly
one codec from the configured protocol with no automatic fallback. The three
codecs (`OpenAIResponsesCodec`, `OpenAIChatCodec`, `AnthropicMessagesCodec`)
preserve tool-call IDs, reasoning/thinking signatures, native continuation
items, usage, and stop reasons, and surface mid-stream errors once. Verified by
`tests/unit/codecs.test.ts` against recorded SSE fixtures.

**M4 — MCP.** A Streamable HTTP JSON-RPC client (`StreamableHttpConnection`),
`StreamableHttpTransportFactory`, `McpSessionManager` (with `detach()` versus
`terminateSession()`), `ToolCatalog` (bounded aliases, collision detection,
reserved application prefix), `CredentialBroker`, `DestinationPolicy`,
`JsonSchemaValidator` (interpreted, no dynamic code generation), and
`ToolRouter` (credential before dispatch intent, role-based replay policy).
Verified by `tests/unit/mcp.test.ts`.

**M5 — auth, skills, context.** `AuthDiscovery` (challenge → endpoint path →
root; authorization-server fallback order), `OAuthCoordinator` (PKCE S256,
resource indicator, state consumed before exchange, refresh failure requires
re-authorization), `SkillRegistry` and `SkillTools`, `ContextAssembler` /
`ContextBudget` / `CompactionPlanner`, and the settings/connector/skill server
functions. Verified by `tests/unit/oauth.test.ts`, `context.test.ts`, and the
storage/skill tests.

**Client.** `ConversationFeed` (snapshot-first, sequence-gap resnapshot,
preserved view across reconnect, separate connection status), `ConversationReducer`,
`CommandOutbox` (IndexedDB with a memory fallback), `CommandDispatcher` and the
static command registry, `DraftStore`, and the component set under
`src/client/components/`. Verified by `tests/unit/client.test.ts`.

**Current verification status (no deployment credentials).**

- `npm run cf-typegen`, `npm run typecheck`: pass.
- `npm run test:unit`: 89 passing across 13 files.
- `npm run build`: pass (client assets + server handler).
- `npm run test:workers`: 12 passing in workerd (fixture-authenticated routing,
  DO RPC idempotency, cross-owner isolation, client-chunk secret scan).
- `npm run test:e2e`: configured but **pending** — Playwright browser binaries
  are not installed on this host.

**Open items.** M5-T07 (`RepositoryContextService`,
`read_repository_instructions`) is a stub that reports `NOT_CONFIGURED` until a
workspace is configured. M6 browser automation and the owner-phone checks remain
pending. Live smoke tests require owner-supplied configuration.

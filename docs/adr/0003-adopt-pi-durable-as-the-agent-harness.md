# ADR-0003: Adopt pi-durable as the agent harness

- Created Date: 2026-10-15
- Status: Accepted
- Baseline: 7b415aa10c6800cc90bac7efa0e88d7ff7c8329f

## Status Quo

mi places every application conversation of one verified owner in a single
owner-scoped Durable Object and owns the whole execution boundary in this
repository.

`src/worker/runtime/` implements the durable engine: `RunDriver` (alarm-backed
slice loop, dispatch, retry bookkeeping, recovery wake), `RunMachine` (pure
transitions), `AttemptExecutor`, `OutputCommitter`, `RetryBookkeeping`,
`RecoveryService` (new-generation recovery), and `WakeScheduler`. Execution
state is persisted by `src/worker/storage/` (`schema.ts`, `SqlStore.ts`,
`repositories.ts`) alongside conversation data. `ContextAssembler`,
`ContextBudget`, and `CompactionPlanner` derive model context and compaction.
`src/worker/sync/` maintains an owner-wide revision and a hand-built
`OwnerSnapshot` projection. `src/worker/mcp/` connects to remote MCP servers,
and `src/worker/skills/` holds owner-configured skills.

ADR-0002 adopted `@earendil-works/pi-ai` for provider wire encoding, streaming
events, message model, usage and cost, thinking control, stop reasons, and
error classification. It explicitly kept the durable execution engine here:
"pi-ai is not a replacement for the durable runtime. Attempts, generation
checks, cancellation, recovery, compaction, and tool execution remain this
repository's responsibility."

The defects fixed in `133924c` were configuration and projection defects, not
execution-engine semantics: the deployment gateway id defaulted to `default`
instead of `mi`, legacy model profiles were parsed inconsistently, run state
transitions did not publish the conversation summary, and model/tool failures
were not surfaced or logged. They are evidence of the cost of maintaining
bespoke cross-layer bookkeeping and projection, not a claim that the execution
state machine itself was wrong.

`@earendil-works/pi-durable` (1.2.0) is a durable agent harness built on pi-ai
and `@earendil-works/chord`. At the pinned upstream revision
`6a1f799b675c8cb98320b71ff7ee44f160fe8d66` it owns conversations, entries,
tasks, submissions, and documents over one storage, with SQLite, JSONL, memory,
and Cloudflare Durable Object SQLite backends; a task scheduler with durable
checkpoints, replay policies, recovery, and abort/ownership; built-in
generation, tool, and compaction tasks; per-conversation live documents; and
`viewState()`, `watch()`, and `watchEvents()` observation.

Its vocabulary differs from this repository's. A **Session** owns one mutation
line, conversations, entries, tasks, submissions, and documents. A
**conversation** is a transcript scope that may fork another conversation.
`Storage` exposes no delete and `Session` exposes no conversation deletion;
`reset()` retains transcript history. Whole-storage disposal is a host
lifecycle operation.

## Needs

- Concentrate this repository on managing user-visible conversations and
  coordinating peripheral capabilities: authenticated access, MCP connectors
  and credentials, skills and repository instructions, model route
  configuration, and client transport.
- Delegate agent execution and its authoritative state to a maintained harness
  instead of reimplementing attempts, retries, recovery, compaction, and their
  persistence.
- Preserve the product guarantees that matter: reconnectable history,
  execution that continues independently of any browser, conversation
  management including whole-dialogue deletion, and authenticated access to
  owner resources.
- Keep the pi-ai adoption from ADR-0002.
- Do not carry forward contracts that only existed to support the custom
  engine.
- Prefer deleting code to preserving it. Responsibilities we do not care to own
  are delegated and their implementations removed, not wrapped or kept behind
  an abstraction.

## Decision

Adopt `@earendil-works/pi-durable` as the sole agent harness.

1. Model each managed mi conversation as an independently owned durable
   Session/storage. A session contains a root conversation and any internal
   forks or task-owned conversations. This mapping is a chosen host design:
   pi-durable's conversation can represent an ordinary top-level transcript; it
   is not inherently only a subagent. The mapping is chosen because
   whole-dialogue deletion is a storage-lifecycle operation, and a conversation
   is the unit the owner manages.
2. A Durable Object per managed session is the proposed Cloudflare storage
   boundary, using `openDurableObjectSqliteStorage(ctx.storage)` and
   `Harness.open`. The owner-level catalog and shared resources remain outside
   that boundary.
3. Use upstream submissions, tasks, replay policies, compaction, live
   documents, and observation APIs directly.
4. Delete the custom execution state machine and its storage rather than
   adapting it or maintaining parallel authoritative records: `RunDriver`,
   `RunMachine`, `AttemptExecutor`, `RecoveryService`, `RetryBookkeeping`,
   `OutputCommitter`, `WakeScheduler`, the execution tables and repositories,
   `ContextAssembler`, `ContextBudget`, compaction planning, and the owner-wide
   revision and sync projection. No compatibility layer, dual-read path, or
   feature flag is kept for the retired engine.
5. Do not carry forward `needs_attention`, owner-wide run serialization, or an
   alarm-driven execution loop as mandatory contracts. Follow upstream
   unsafe-tool interruption behavior instead of rebuilding a global pause
   state. An MCP request id alone does not establish idempotency; where a remote
   effect must not repeat, the tool's own replay policy and idempotency are the
   mechanism.
6. Default to the upstream scheduler without a custom alarm loop. Timers and
   in-flight I/O preventing normal hibernation do not prove automatic
   resumption after a crash or deployment reset. Host-lifecycle behavior,
   including how a run resumes after the Durable Object is evicted, must be
   validated without preselecting alarms.
7. Whole-session deletion quiesces execution and prevents stale requests from
   recreating the deleted session before the storage is removed. Neither
   `close()` nor removing a catalog row deletes storage by itself.
8. An `env` callback selects an environment; it does not provision isolated
   containers. Resource sharing and any coordination it requires belong at the
   resource boundary, not inside the harness.
9. ADR-0002's adoption of pi-ai is preserved. This ADR replaces only ADR-0002's
   choice to retain this repository's execution engine. ADR-0001 and ADR-0002
   remain active until this decision is implemented and merged.

The application is expected to shrink. The target shape is a thin layer that
manages conversations and coordinates peripherals; every module that exists
only to implement or project the retired engine is deleted with it. Tests,
projections, wire types, command plumbing, and abstractions that no longer have
a consumer are removed rather than preserved. Retaining an abstraction in case
it is needed later is not a goal of this decision. Where a product behavior
depended on a retired contract, the behavior is re-expressed on the upstream
harness or dropped.

## Reason

Delegating the whole execution boundary removes the recurring cross-layer
bookkeeping that `133924c` had to repair: attempt persistence, retry
eligibility, recovery of a new object generation, compaction planning, context
budgeting, and the projection of committed state to clients. pi-durable already
commits transcript, task, and document changes atomically and derives live
state and observation from those commits.

Session-sized ownership makes whole-dialogue deletion a host storage-lifecycle
operation, which matches the product meaning of deleting a conversation. The
upstream vocabulary shows why the previous framing was wrong: pi-durable's
conversation is a transcript scope, and its Session is the unit that owns
storage. Treating one Session as all managed dialogues would retain the
cross-dialogue deletion problem; mapping each managed dialogue to a Session
does not.

Wrapping pi-durable beneath the existing `RunDriver` would preserve two
authoritative execution records and the duplication this decision removes, so
the custom engine is deleted rather than adapted.

Simplification is part of the decision, not a side effect. The execution
engine, its storage schema and repositories, context assembly and budgeting,
and the owner-wide sync projection are the largest cohesive block of this
repository's application code. Adapting that block instead of deleting it would
leave the application larger, not smaller, because the custom records, command
protocol, and projection would still have to be maintained alongside upstream
state. Deleting it is what makes mi a thin conversation-management and
coordination layer.

Alternatives considered:

- Keep the custom execution engine. Rejected: it is the maintenance burden this
  decision exists to remove, and the recent defects were in its cross-layer
  bookkeeping and projection.
- Wrap pi-durable beneath `RunDriver` and migrate incrementally. Rejected: two
  authoritative execution records, with no point at which the custom engine can
  be deleted.
- One Session for all managed conversations. Rejected: whole-dialogue deletion
  is not a supported Session operation, so deletion would still require
  surgery inside a shared storage.

Evidence for pi-durable at the pinned upstream revision:

- `packages/durable/package.json` declares `@earendil-works/chord` 1.2.0 and
  `@earendil-works/pi-ai` 1.2.0, matching this repository's pi-ai version.
- `packages/durable/src/storage/sqlite/cloudflare.ts` adapts a SQLite-backed
  Durable Object's `ctx.storage` through `openDurableObjectSqliteStorage`.
- The specification defines one Session commit as atomic across record and
  document writes, with no volatile publication path.
- The scheduler is in-memory and `resume()`-driven; retry backoff waits through
  `setTimeout`. Upstream documentation notes that where timers cannot be
  unreferenced, as in Cloudflare Workers, only commits perform document
  eviction.

Known risks and boundaries:

- pi-durable is marked experimental: "The API changes without notice between
  releases."
- Deployment behavior on Cloudflare, including eviction and resumption of a
  running session, was not verified at this baseline.
- pi-durable conversation ids are numeric and session-global; this repository
  uses string ids.
- The package root loads TypeBox; bundle cost must be measured for the Worker.
- Existing conversation data needs a migration or a new-conversations-only
  rollout.
- MCP connectors, credentials, skills, repository instructions, authentication,
  and client transport are not provided by pi-durable and remain this
  repository's responsibility.

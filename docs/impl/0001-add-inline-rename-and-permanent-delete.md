# Impl-0001: Add inline rename and permanent delete to conversations

- Created Date: 2026-10-15

## Commits

- 7201dad add conversation deletion contracts and durable outcomes
- 2f76dba add conversation management controls and sync cleanup
- 602c104 cover deletion, persistence, and management behavior

These are the implementation commits on `adr-0001`. They were pushed to
`origin/adr-0001` before verification. The branch head verified below is
602c104.

## Result

Implemented the approved Plan-0001 scope.

Contracts and command path: added `DeleteConversationInput`,
`conversation.delete`, the `deleteConversation` OwnerRpc method, owner runtime
dispatch, and the client registry handler. `ConversationService.delete`
authoritatively refuses deletion while any run is queued, running,
waiting_for_auth, or needs_attention, using a non-retryable `CONFLICT`.
Unknown ids return `NOT_FOUND`. Rename and delete server functions return an
explicit serializable `CommandFunctionOutcome`; the registry reconstructs a
browser-local `AppError` through the shared `appErrorFromApi` helper.

Conversation summaries: `src/worker/storage/ConversationProjection.ts` builds
one summary from the conversation, active run, latest entry, and queued count.
Snapshots, create, rename, and run/queue transitions use it, so a rename during
execution preserves the activity state and preview.

Durable outcomes: `command_receipts` gained an `outcome` discriminator with an
idempotent, transactional schema-version-2 migration that treats prior rows as
accepted. The processor checks both command kind and payload hash, and persists
definitive deletion rejections after the failed mutation rolls back. Accepted
create and submit receipts are retained, so delayed retries cannot recreate
deleted work. Deletion receipts store `null`; no conversation text or payload
body is retained.

Execution safety: removed the unused compaction-plan artifact write and its
artifact id from the context, transition, and effect contracts. Request
artifacts are created in the same transaction that inserts their attempt;
result artifacts are created in the same transaction that links them to their
attempt. The driver stops when a reload finds no run, checks the conversation,
run, attempt, and generation at persistence boundaries, and discards late
writes and buffered output. A paused run with a persisted cancellation request
is selectable and reaches `cancelled` without object reconstruction.

Bounded removal: `src/worker/storage/ArtifactReferences.ts` collects candidates
from attempt request/result links and established entry attachments, and
protects artifacts used by surviving attempts, entries, resolution evidence,
skill resources, repository instructions, and supported
`app__read_tool_result` representations (persisted arguments, run checkpoints,
and entry metadata). Evidence-only references are not ownership proof.
Unattributable artifacts are left untouched. Deletion removes live output,
resolutions, entries, submissions, context snapshots, conversation skill
selections, attempts, runs, eligible artifacts, and the conversation row in one
transaction with the receipt and owner revision, then publishes
`conversation.remove`.

Client: inline rename with Enter save (skipping IME composition), Escape cancel,
explicit save/cancel controls, preserved rejected input, and pending/error
state. Confirmed permanent deletion names the conversation, explains the
restriction, and displays authoritative rejections. The reducer clears the
selected snapshot on removal; selection generations discard late history and
artifact responses; drafts are enumerated and cleared for deleted
conversations; scoped outbox mutations are dropped only when their target
deletion is established. A fresh snapshot establishes the reconnect boundary
before reconciliation and serialized outbox replay, and commands wait for that
boundary.

Verification outcomes:

- Termux: `npm run typecheck` passed; `npm run test:unit` passed (16 files,
  118 tests); `npm run test:workers` passed (2 files, 14 tests).
  `npm run test:e2e` could not run: Playwright reports `Unsupported platform:
  android` and no browsers are installed.
- Container (x86_64 Debian, same revision 602c104): `npm run typecheck`
  passed; `npm run test:unit` passed (118 tests); `npm run test:workers`
  passed (14 tests); `npm run test:e2e` passed (46 tests, including the new
  inline rename, rename cancel, confirmed deletion, and second-device removal
  cases).

The PLAN Target is achieved for the authorized interim scope. Pre-existing
artifacts without a verifiable ownership relationship may remain, as expressly
accepted in ADR-0001; complete historical content erasure is not claimed.

## Deviations

- `CommandProcessor.process` gained a `receiptValue` option so the public
  deletion receipt stays `CommandReceipt<void>` while the internal cleanup
  result still carries the affected run and attempt ids to the owner runtime.
- `appErrorFromApi` was added to `src/shared/domain.ts` and reused by both the
  command processor and the client registry, instead of duplicating AppError
  reconstruction.
- The client outbox schema version was raised to 2. The upgrade keeps the
  existing object store and records, so prior outbox entries survive.
- `DraftStore` now deletes empty entries in its memory fallback and skips empty
  stored values, so enumeration reports only real drafts.
- A Worker-suite test for refusing deletion during active work was removed: in
  the Worker test environment the alarm-driven driver runs against the real AI
  binding, which errors (`Binding AI needs to be run remotely`) and starves the
  Durable Object. The refusal path is covered by unit tests for every
  non-terminal run state.

## Follow-ups

- Historical artifacts without a verifiable ownership relationship may remain
  after deletion. This is the accepted temporary limitation recorded in
  ADR-0001 and `docs/TODO.md`, not a completion claim.
- The root separation of execution payloads, skill resources, and repository
  instructions by ownership and lifecycle remains deferred in `docs/TODO.md`.
- The Worker test environment cannot exercise the alarm-driven active-work
  deletion path with the real AI binding; keep this covered at the unit level
  until a deterministic model fixture is available.
- Real-device acceptance (software keyboard, screen lock, network changes) and
  WebKit still require the owner's phone; the browser suite uses Chromium
  mobile emulation.

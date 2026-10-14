# Plan-0001: Add inline rename and permanent delete to conversations

- Created Date: 2026-10-15
- Status: Done

## Target

Implement conversation management according to ADR-0001 and its adopted
interim artifact-cleanup approach.

Completion requires:

- Inline rename with explicit save/cancel, keyboard and touch support,
  preserved failed input, and complete conversation summaries.
- Confirmed deletion refused while any conversation run is non-terminal.
- Atomic removal of conversation-owned records and identifiable exclusive
  request/result payloads.
- Preservation of shared resources and supported surviving local references.
- Removal of the unused compaction-plan artifact write and atomic linking of
  newly created execution payloads.
- No execution writes or publication that restore deleted conversation data.
- Stable deletion outcomes across lost acknowledgements and retries.
- Consistent removal and browser-state cleanup across connected and
  reconnecting clients.
- Passing the verification specified below.

Pre-existing artifacts without verifiable ownership may remain, as expressly
accepted in ADR-0001. Complete historical content erasure is not a completion
claim. The root redesign and historical cleanup are recorded in
[TODO](../TODO.md).

The user approved this implementation scope. The authorized scope is
implemented and verified; see
[Impl-0001](../impl/0001-add-inline-rename-and-permanent-delete.md).

The earlier documentation-stage restrictions described below are historical.
They applied only while this PLAN was being prepared and no longer restrict
the authorized implementation.

## Start

The starting behavior is the baseline recorded in ADR-0001.

Rename already has a command, server function, OwnerRpc method, runtime
dispatch case, service, and repository operation. Its upsert omits activity
and preview fields present in a full snapshot. The client exposes no editor.

Deletion has no command or storage path. The wire protocol and SyncHub
already support `conversation.remove`; its reducer branch removes the list
item but leaves the selected conversation intact.

Conversation data spans conversations, submissions, runs, attempts, entries,
live output, context snapshots, skill selections, and attempt resolutions.
The schema has no foreign-key cascades.

Artifacts combine several content classes:

| Content | Established relationship |
| --- | --- |
| Model and compaction requests | Attempt request artifact ID |
| Tool arguments and results | Attempt request/result artifact IDs |
| Transcript attachment | Entry artifact ID; no demonstrated driver writer |
| Resolution evidence | Artifact IDs in resolution evidence arrays |
| Skill resources | Skill-resource artifact ID |
| Repository instructions | Repository-instruction artifact ID |
| Compaction plan | Created by context preparation; its returned effect ID is not persisted or consumed by the driver |

Execution artifact creation and attempt linking currently use separate
transactions. Interrupted execution can leave unlinked artifacts.
The unused compaction-plan write creates another such source.

Application-defined `app__read_tool_result` calls can reference a local
artifact through their arguments. External content containing similarly
named fields does not establish a local reference contract.

The command processor stores successful receipts and checks payload hashes
without checking command kind. The dispatcher treats every `CONFLICT` as
retryable, and app dispatch discards its outcome.

OwnerRpcClient reconstructs AppError on the server-side owner RPC hop.
Preservation through the separate Solid server-function boundary has not
been established.

The driver can retain a stale run when reloading finds no row. Output
flushing does not validate attempt existence. Paused work can prevent
persisted cancellation requests from being processed. The external budget
helper aborts a signal and awaits the underlying operation; it does not
immediately detach execution.

The browser flushes its outbox before receiving a fresh snapshot. Loaded
history is not reset on selection changes, and draft storage has no
enumeration for reconnect cleanup.

## Architecture

Keep the existing authenticated command and synchronization paths.

ConversationService owns authoritative deletion eligibility and transactional
removal. Repositories own SQL. A shared summary builder serves snapshots and
mutation changes.

Artifact cleanup follows existing ownership links and supported local
references. It adds no provenance table, ownership column, or historical
backfill. Unattributable historical artifacts remain subject to the explicit
ADR exception.

Execution payload creation is moved into the transaction that links the
payload to its attempt. The unused compaction-plan artifact is removed.

Runtime persistence boundaries validate current stored identities and
execution state. Invalidated work stops without writing or publishing.

Management commands expose serializable outcomes. Definitive deletion
rejections are durable so that losing a rejection response cannot cause the
same command to succeed later.

Fresh snapshots establish the reconnect boundary before browser cleanup and
outbox replay. Selection-scoped state rejects stale asynchronous responses.

## Changes

**1. Contracts and management command path**

Files:

- `src/shared/commands.ts`
- `src/shared/domain.ts`
- `src/rpc/conversations.ts`
- `src/worker/rpc/OwnerRpc.ts`
- `src/worker/owner/OwnerRuntime.ts`
- `src/client/commands/registry.ts`

Add DeleteConversationInput, `conversation.delete`, and deleteConversation
through the existing command processor. Keep the public successful deletion
receipt as CommandReceipt<void>.

Return explicit serializable receipt/error replies for rename and delete
across the Solid server-function boundary. Registry adapters reconstruct
browser-local AppError instances. Unexpected transport failures retain an
uncertain outcome.

**2. Complete conversation summaries**

Files:

- New `src/worker/storage/ConversationProjection.ts`
- `src/worker/storage/SqlStore.ts`
- `src/worker/conversations/services.ts`
- Relevant run and queue publication paths

Build summaries from the conversation, active run, latest entry, and queued
count. Use the same builder for snapshots, create, and rename.

Refresh summaries when run or queue transitions change list eligibility.
Keep existing title trimming and empty-title rejection.

**3. Stop creating unlinked execution artifacts**

Files:

- `src/worker/context/ContextAssembler.ts`
- `src/worker/runtime/RunMachine.ts`
- `src/worker/runtime/RunDriver.ts`
- Related context and transition tests

Remove the unused compaction-plan artifact creation. Remove the now-unused
artifact ID from the context-preparation result, transition event, and effect
contracts. Keep compaction detection and actual compaction execution.

Create request artifacts and insert their attempts in one transaction.
Create result artifacts and update their attempts in one transaction.
Metadata, chunks, and the owning link must roll back together.

The actual compaction model request remains recorded through its attempt.
Do not change skill-resource or repository-instruction storage.

**4. Bounded artifact cleanup**

Files:

- New `src/worker/storage/ArtifactReferences.ts`
- `src/worker/storage/repositories.ts`
- `src/worker/conversations/services.ts`

Before deleting records, collect candidates from the conversation's attempt
request/result IDs and attachments whose ownership is established.

An evidence or tool-input reference alone does not make an artifact a
deletion candidate.

Protect candidates used by surviving:

- Attempt request/result links.
- Entry attachment links.
- Resolution-evidence arrays.
- Skill-resource and repository-instruction links.
- Application-defined `app__read_tool_result` calls in supported persisted
  argument, checkpoint, entry-metadata, and request-history representations.

Follow supported local references where needed to protect surviving users.
Do not interpret arbitrary external IDs or opaque provider fields as local
references. A reference cycle within otherwise deleted data is not itself a
surviving user.

Use explicit readers for these known representations. Keep cleanup limited
to identifiable candidates; do not scan every unreferenced artifact for
possible deletion.

Delete eligible candidate chunks and metadata in the conversation transaction.
Preserve shared content. Leave historical artifacts whose ownership cannot
be established untouched.

Add no artifact-provenance schema and perform no ownership backfill.

**5. Atomic conversation removal**

Files:

- `src/worker/conversations/services.ts`
- `src/worker/storage/repositories.ts`
- `src/worker/storage/SqlStore.ts`

Require the conversation to exist. Reject deletion with non-retryable
CONFLICT while any run is queued, running, waiting_for_auth, or
needs_attention.

Collect affected run and attempt IDs before deleting dependent records.
Remove live output, resolutions, entries, submissions, context snapshots,
conversation skill selections, attempts, runs, and the conversation.

Reuse `selectForConversation(id, [])` where appropriate rather than assuming
a separate clear method exists.

Remove eligible artifact candidates after evaluating surviving references.
Commit deletion, the successful receipt, and the owner revision atomically.
Publish `conversation.remove` only after commit.

Carry affected runtime IDs through an internal cleanup result without
including their inventory in the public receipt.

Historical attempt states alone do not impose another deletion prohibition
after runs are terminal and execution writes are fenced.

**6. Stable deletion outcomes**

Files:

- `src/worker/rpc/CommandProcessor.ts`
- `src/worker/storage/schema.ts`
- `src/worker/storage/records.ts`
- Command-receipt repository and migration logic
- `src/client/commands/CommandDispatcher.ts`

Check both command kind and payload hash for duplicate IDs.

Persist definitive deletion outcomes, including active-work CONFLICT and
NOT_FOUND, as well as successful receipts. Roll back any rejected mutation
before storing its rejection under the command coordinator.

Replaying a rejected command returns the original rejection even after the
run finishes. A new deletion attempt requires a new command ID.

Add an outcome discriminator to command-receipt storage, treating existing
rows as accepted. Use a transactional, idempotent schema-version-2 migration
for this receipt change. There is no artifact-provenance migration.

Retain minimal accepted create and submit receipts so their delayed retries
cannot recreate deleted work. Store no conversation text or request/result
bodies in deletion outcomes.

Drop definitive rejected deletes from the browser outbox. Preserve the same
command ID for transport uncertainty. Keep unrelated command retry policies
outside this change.

**7. Execution boundary and cancellation completion**

Files:

- `src/worker/runtime/RunDriver.ts`
- `src/worker/runtime/OutputCommitter.ts`
- `src/worker/runtime/RecoveryService.ts`
- `src/worker/owner/OwnerRuntime.ts`
- Necessary run-control and wake-selection paths

Stop the driver when reloading finds no run.

At persistence boundaries after asynchronous work, check the persisted
conversation, run, applicable attempt/state, and execution generation in the
same transaction as the write. Invalidated work must stop without another
effect, persistence operation, or change publication.

Preserve legitimate recovery by claiming work for the current generation
before applying generation fences.

Output flushing must validate its writable attempt and owning run.
Post-commit deletion cleanup discards buffered content and flush metadata
without writing it back to storage.

Ensure cancellation requests on paused work can reach a terminal state
without object reconstruction. Process cancellation before paused work blocks
driver selection, and schedule the required wake.

Keep this work limited to making cancellation and deletion usable and
preventing late writes. Do not redesign recovery or remote-effect semantics.

**8. Client management controls**

Files:

- `src/client/components/types.ts`
- `src/App.tsx`
- `src/client/components/ConversationList.tsx`
- Existing dispatch callback consumers
- `src/styles.css`

Return DispatchResult from app dispatch and update affected callback types.

Provide inline edit, save, and cancel controls. Enter saves except during IME
composition; Escape cancels; blur alone does not submit. Preserve rejected
input and show pending/error state.

Provide a confirmation naming the conversation and explaining permanent
history removal. Explain execution restrictions and display authoritative
rejections. Client eligibility indicators never replace the server check.

Handle outcomes completed by later replay, not only the initial click.
Prevent duplicate clicks from issuing new commands while an outcome is
unknown.

Keep management controls beside the selection button, with accessible
labels, focus behavior, touch targets, and narrow-layout support.

**9. Removal, reconnect, and browser cleanup**

Files:

- `src/client/sync/ConversationReducer.ts`
- `src/client/sync/ConversationFeed.ts`
- `src/client/storage/DraftStore.ts`
- `src/client/commands/CommandOutbox.ts`
- `src/client/commands/CommandDispatcher.ts`
- `src/App.tsx`
- `src/client/components/ConversationScreen.tsx`
- `src/client/components/Transcript.tsx`
- `src/client/components/ToolCallCard.tsx`

Clear matching selected snapshot, app selection, feed selection, and draft.
Removing another conversation preserves the current selection.

Reset conversation-scoped history and previews. Use selection generations
to discard late responses, including after selecting the same conversation
again. Ignore messages from replaced sockets.

Distinguish fresh snapshots from reduced changes and maintain snapshot
revision correctly.

Add draft enumeration and optional outbox target metadata for conversation,
run, submission, and attempt mutations. Preserve existing outbox records
during its schema upgrade.

On startup and reconnect, receive a fresh authoritative snapshot, reconcile
local state, then replay pending commands in order. Serialize replay and
prevent new commands from bypassing this boundary.

Preserve pending creates and unacknowledged deletes. Discard obsolete scoped
mutations only when their target deletion is established. For legacy entries
without sufficient target metadata, let server lookups settle them; absence
from a bounded selected snapshot is not proof of deletion.

**10. Decision references and deferred work**

Add concise English ADR-0001 comments near changed responsibilities.
Keep the root storage redesign and historical-retention limitation in
`docs/TODO.md`.

Do not introduce a new ADR for that redesign until the work is actually
undertaken.

## Behavior

Rename remains available during every run state and preserves activity,
queue count, and preview.

Delete is blocked by any non-terminal run. A cancellation request alone does
not satisfy eligibility. Terminal historical attempts may be removed once
execution is fenced.

If a submission commits before deletion, deletion sees active work and
fails. If deletion commits first, submission finds no conversation.

Successful delete replay returns the accepted receipt. Rejected delete
replay returns its original rejection, including when that rejection's
response was lost. No old refusal becomes a later automatic deletion.

Failure during deletion rolls back dependent-row removal, artifact removal,
and successful receipt insertion. No removal change is published.

Identifiable exclusive payloads are removed. Shared resources survive.
Previously unattributable payloads may remain under the accepted exception;
the operation is not described as complete historical content erasure.

A stale execution continuation cannot recreate deleted conversation data.
Deleting the selected conversation shows the existing empty screen.
Other devices converge through removal changes or fresh snapshots.

Offline cleanup runs after authoritative state is available. Unacknowledged
deletes remain until their own outcome is settled.

## Tests

Use the existing unit, Worker, and browser suites.

Storage and domain coverage:

- Fresh and populated version-1 receipt migration, including repeat migration.
- Atomic request/attempt and result/attempt persistence with rollback.
- Compaction still works without creating the unused plan artifact.
- Removal of every conversation-owned table.
- Mid-deletion failure rolls back all removals.
- Each blocking run state and cancellation still pending.
- Terminal historical attempts without live writers.
- Exclusive payload removal and preservation of each supported surviving
  reference source.
- Evidence-only references do not establish ownership.
- Unattributable historical artifacts remain untouched.
- Accepted create, submit, and delete replay after deletion.
- Rejected-delete replay after execution finishes and after a lost response.
- Duplicate IDs with changed command kind or payload.
- Complete rename summaries during execution.

Runtime coverage:

- Actual in-flight deletion refusal.
- Paused cancellation completion.
- Missing-run, stale-generation, and late-output writes being discarded.
- No late artifacts, entries, attempts, or publication after deletion.
- Legitimate recovery continuing to work.

Client and synchronization coverage:

- Selected and unselected removal.
- Definitive rejection leaving the outbox.
- Uncertain deletion retaining its command ID.
- Fresh-snapshot reconciliation before replay.
- Pending-create and unacknowledged-delete preservation.
- Legacy commands without target metadata.
- Draft cleanup and stale history/artifact response rejection.
- Replaced-socket messages and removal across subscriptions.

Worker and browser coverage:

- Owner RPC deletion, isolation, rejection, and receipt replay.
- Structured application errors crossing the Solid server-function boundary.
- Inline save/cancel, empty titles, IME behavior, and failed-input retention.
- Rename during execution without losing activity indicators.
- Confirmed deletion and cancellation of confirmation.
- Reload persistence and a second device observing removal.
- Offline reconnection, pending work, keyboard operation, and narrow layouts.

Extend existing files under `tests/unit`, `tests/workers`, and `tests/e2e`.
Add a focused conversation-domain test file where it improves clarity.

## Verification

For this documentation stage (historical; completed while the PLAN was being
prepared):

1. Confirm the ADR is Accepted and this PLAN is Draft.
2. Inspect the complete documentation diff.
3. Confirm only the ADR, PLAN, and TODO changed.

After implementation is authorized:

1. `npm run typecheck`
2. `npm run test:unit`
3. `npm run test:workers`
4. `npm run test:e2e`

The Worker script already runs the build. Record actual outcomes in the
implementation report.

Verify persisted rows and observed synchronization frames, not only removal
of a list item. No production artifact inventory is required to approve this
interim approach.

## Out of scope

- Redesigning the generic artifact abstraction.
- Artifact-provenance tables and historical ownership backfill.
- Global artifact garbage collection or historical unlinked-artifact purges.
- Trash, restore, archive, pinning, bulk deletion, and export.
- Undoing remote tool effects.
- Removing shared skills, repository instructions, connectors, credentials,
  or settings through conversation deletion.
- General execution or command-system redesign beyond the required deletion
  guarantees.
- Implementation or deployment during this documentation stage.

## Risks

**Historical payload retention.** Unattributable artifacts may contain
conversation data. This is the accepted temporary limitation, recorded in
ADR-0001 and TODO. Do not conceal it or claim complete content erasure.

**Incomplete references.** A missed supported reference can break a surviving
user. Maintain one explicit reference inventory and tests for its known
representations. Avoid arbitrary string matching.

**Execution regressions.** Write fences must reject stale continuations
without preventing valid recovery. Test both paths and paused cancellation.

**Delayed deletion.** Persist terminal outcomes so a lost rejection response
cannot turn into a later successful destructive command.

**Migration compatibility.** Preserve existing successful receipts during the
outcome migration and test a populated prior schema.

**Cleanup cost.** Index direct lookups and avoid repeatedly loading unrelated
payloads. Test representative histories. Do not substitute partial removal
for atomic deletion without revising the plan.

**Browser races.** Use a fresh-snapshot boundary, serialized replay, and
selection generations to prevent obsolete state from returning.

## Open Questions

None for adopting the interim artifact approach.

The user has accepted retention of pre-existing artifacts without verifiable
ownership. Historical inventory and the root lifecycle redesign are deferred
in TODO rather than blocking this feature.

The user approved this implementation scope. It is implemented and verified.

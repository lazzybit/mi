# Plan-0001: Add inline rename and permanent delete to conversations

- Created Date: 2026-10-15
- Status: Draft

## Target

The owner can rename a conversation inline and permanently delete it from the
conversation list, following ADR-0001.

Completion requires:

- Inline rename works during execution, supports keyboard and touch controls,
  preserves failed input, and publishes the complete conversation summary.
- Confirmed deletion checks authoritative execution state. A non-terminal run
  prevents deletion; a cancellation request alone does not permit it.
- Successful deletion atomically removes conversation-owned records and
  exclusively owned artifacts, while preserving resources still used by
  surviving records.
- Execution cannot recreate deleted output, artifacts, entries, or attempts,
  or publish changes for deleted work.
- A definitive deletion refusal cannot become a successful deletion through
  automatic retry after the run finishes.
- Connected and reconnecting clients remove the conversation and its local
  state without losing legitimate pending creates or unacknowledged deletes.
- The legacy-artifact question below is resolved before claiming complete
  permanent deletion for pre-existing conversations.
- The specified unit, Worker, and browser verification passes.

ADR acceptance authorizes this planning stage. This PLAN remains Draft until
its execution prerequisites are resolved and the user approves it.

## Start

The starting behavior is the baseline recorded in ADR-0001.

Rename already passes through the shared command contract, server function,
OwnerRpc, runtime dispatch, domain service, and repository. Its published
summary omits active-run state and the last-entry preview. The client has no
rename control.

There is no conversation deletion operation. The existing
`conversation.remove` wire change reaches every subscription, but no service
emits it. The reducer removes the list item without clearing the selected
conversation.

Conversation data spans the conversation, submission, run, attempt, entry,
live-output, context-snapshot, skill-selection, and resolution tables. The
schema has no foreign-key cascades. Artifact metadata and chunks are stored
separately without creation provenance.

Artifact creation and references established by the inspected code are:

| Source or reference | Baseline behavior |
| --- | --- |
| Model and compaction requests | `RunDriver` creates request artifacts and links them from attempts. |
| Tool requests and results | `RunDriver` creates artifacts and links them from attempts. Creation and linking occur in separate transactions. |
| Model responses | Text and metadata are persisted in entries; there is no demonstrated separate result artifact for every model response. |
| Transcript attachment | `entries.artifact_id` is supported by storage, although the inspected driver does not populate it. |
| Resolution evidence | `attempt_resolutions.evidence_json` contains local artifact IDs. |
| Skill resources | `skill_resources.artifact_id` references owner resources. |
| Repository instructions | `repository_instructions.artifact_id` references owner resources. |
| Compaction plan | `ContextAssembler.prepare` creates an artifact. The state machine returns its ID in an effect, but the driver does not persist that effect or the ID in the checkpoint. |
| Application tool input | `app__read_tool_result` accepts a local `artifactId`; its arguments can also appear in persisted tool calls and request payloads. |

The compaction-plan path therefore creates artifacts whose conversation cannot
be identified from a persisted relationship. Separate artifact creation and
attempt linking also permit unlinked artifacts if execution stops between
transactions. Existing data has not been inventoried, so the number of such
artifacts is unknown.

`CommandProcessor` stores successful receipts. Its duplicate check compares
the payload hash but not the command kind. `CommandDispatcher` retains every
`CONFLICT` for retry. `AppActions.dispatch` discards the dispatch result.

`OwnerRpcClient` reconstructs `AppError` on the server-side owner RPC hop.
This does not establish that a custom error prototype or its properties
survive the subsequent Solid server-function boundary to the browser.

Execution and cancellation have additional relevant behavior:

- The command coordinator does not encompass driver execution.
- `withExternalBudget` aborts a signal and awaits the underlying operation.
  It is not a timeout race that immediately detaches that operation.
- `runLoop` retains a stale in-memory run when reloading finds no row.
- Output flushing does not check whether its attempt still exists.
- Cancelling a paused run records a request, while driver selection can stop
  at paused work before processing that cancellation.
- Recovery can leave historical attempts alongside terminal runs. An attempt
  state alone does not prove that a live worker can still write.

The browser starts flushing its outbox before receiving a fresh snapshot.
History loaded by `ConversationScreen` is not reset when selection changes.
Drafts have a clear operation, but no enumeration for reconnect cleanup.

## Architecture

### Conversation operations

Keep mutations on the existing authenticated command path. Add deletion to
the shared contract, server function, OwnerRpc, runtime, service, and registry.

A shared conversation-summary builder supplies the same complete projection
to snapshots and mutation changes. Execution changes that affect eligibility
also refresh the summary, so list controls do not retain stale activity
indicators.

`ConversationService` checks deletion eligibility and coordinates the
transactional removal. Repositories own SQL and typed reference access.

### Artifact provenance and references

Add an internal `artifact_provenance` table:

- `artifact_id` is its primary key.
- `scope` identifies `conversation` or `owner`.
- `conversation_id` identifies the originating conversation for
  conversation-scoped artifacts.
- Absence of a provenance row identifies unresolved legacy provenance.

A conversation origin records where content was created. It is not itself a
claim that no other record uses that artifact. An artifact retained for a
surviving reference can keep its historical origin until it is eventually
removed.

Every new artifact producer records provenance in the same transaction as
artifact creation:

- Driver and compaction-plan artifacts use conversation scope.
- Skill-resource and repository-instruction artifacts use owner scope.

A dedicated artifact-reference module enumerates local references from known
application schemas. It includes direct columns, resolution evidence, and
the documented `app__read_tool_result` argument shape. It must not interpret
every arbitrary `artifactId` property in external content as a local
reference.

Deletion collects candidate artifacts before removing their referring
records. It preserves candidates reachable from surviving application
records and owner resources. Reference traversal must account for supported
references inside retained request artifacts, so deleting one conversation
does not break a surviving conversation's tool-result references.

### Execution boundary

Deletion refuses while any run in the conversation is non-terminal. The
runtime additionally fences writes using persisted identity, generation, and
expected state at asynchronous persistence boundaries.

A stale execution operation stops without publishing changes. Buffered
output for deleted attempts is discarded after deletion commits.

Do not add a permanent deletion ban merely because a terminal run retains an
`unknown`, `prepared`, or `dispatched` historical attempt. Establish whether
execution can still write, then fence it. Historical recovery records are
part of the data that permanent deletion removes.

### Command outcomes

Management server functions return an explicit serializable success/error
result. Browser registry adapters convert an application error into a local
`AppError` for the dispatcher. Transport uncertainty remains distinct.

Persist definitive deletion rejections as minimal command outcomes, as well
as successful receipts. This prevents a lost rejection response from allowing
the same command to delete later after execution finishes.

The app receives `DispatchResult` and displays pending, accepted, and rejected
states.

### Client reconciliation

Fresh authoritative snapshots establish the order for reconnect cleanup and
outbox replay. Explicit removal changes and accepted deletion receipts also
establish that deletion occurred.

The app owns selection and draft cleanup. Conversation-scoped rendering owns
history and preview cleanup. The outbox tracks enough target identity to
discard obsolete mutations without guessing from a bounded selected view.

## Changes

**1. Shared contracts and RPC plumbing**

Files:

- `src/shared/commands.ts`
- `src/shared/domain.ts`
- `src/rpc/conversations.ts`
- `src/worker/rpc/OwnerRpc.ts`
- `src/worker/owner/OwnerRuntime.ts`
- `src/client/commands/registry.ts`

Add `DeleteConversationInput` and `conversation.delete`, preserving the public
deletion receipt as `CommandReceipt<void>`.

Add `deleteConversation` to both the OwnerRpc interface and its base
implementation. Route it through the existing command processor.

Introduce a serializable management-command reply containing either a receipt
or `ApiError`. Use it for rename and delete at the Solid server-function
boundary. Catch known application errors there; unexpected transport or
serialization failures retain their uncertain outcome.

Registry adapters unwrap the reply and construct browser-local `AppError`
instances. Do not rely on error-prototype preservation across the network.

**2. Complete conversation summaries**

Files:

- New `src/worker/storage/ConversationProjection.ts`
- `src/worker/storage/SqlStore.ts`
- `src/worker/conversations/services.ts`
- Relevant driver and recovery publication paths

Extract a summary builder using the conversation record, active run, latest
entry, and queued-submission count. Keep record-only projections in
`projections.ts`.

Use the builder for snapshot, create, and rename summaries. Publish refreshed
summaries in transactions whose run or queue changes affect list eligibility.

Preserve title validation already performed by the rename service.

**3. Schema migration and artifact provenance**

Files:

- `src/worker/storage/schema.ts`
- `src/worker/storage/records.ts`
- `src/worker/storage/repositories.ts`
- `src/worker/storage/SqlStore.ts`

Increment the schema version to 2 and add `artifact_provenance` with indexes
supporting conversation-scoped lookup.

Extend command-receipt storage with an outcome discriminator defaulting to
accepted for existing rows. Accepted results keep their current meaning;
rejected deletion outcomes store only their structured application error.

Implement an explicit, transactional version-1-to-version-2 migration. New
table creation is additive. Guard the receipt-column alteration for fresh
and existing stores, and advance the schema version only after migration
succeeds. Repeated migration must be harmless.

Backfill artifact provenance only where existing relationships establish it:

- Shared skill-resource and repository-instruction records establish owner
  scope.
- Unambiguous request/result ownership from attempts can establish a
  conversation origin.
- A consumer reference alone, conflicting conversation references, timestamps,
  and artifact content resemblance do not establish creation ownership.

Record aggregate migration findings without logging artifact contents.
Unresolved legacy provenance remains identifiable and is subject to the
execution prerequisite under Open Questions.

**4. Artifact creation and reference inventory**

Files:

- `src/worker/context/ContextAssembler.ts`
- `src/worker/runtime/RunDriver.ts`
- `src/worker/context/RepositoryContextService.ts`
- `src/worker/skills/SkillRegistry.ts`
- New `src/worker/storage/ArtifactReferences.ts`

Require production artifact-creation paths to supply provenance. Record it
atomically with metadata and chunks, including compaction plans and artifacts
created before their attempt link.

Define reference readers for:

- Attempt request/result artifact columns.
- Entry artifact columns.
- Resolution-evidence arrays.
- Skill-resource and repository-instruction artifact columns.
- Persisted application tool calls with the exact supported
  `app__read_tool_result` argument schema.
- Those application calls when carried in known model-request history,
  checkpoints, or entry metadata.

Treat external tool results and opaque native provider data as opaque unless
the application defines a local-reference contract for them.

Build surviving-reference reachability from remaining records, artifacts
owned by other existing conversations, and owner-scoped resources. Traverse
supported artifact-to-artifact references without treating a candidate's own
reference cycle as a surviving external user.

If an artifact survives deletion because another conversation references it,
the reference inventory must allow its eventual removal when its final
conversation user is deleted.

**5. Transactional conversation removal**

Files:

- `src/worker/conversations/services.ts`
- `src/worker/storage/repositories.ts`
- `src/worker/storage/SqlStore.ts`

Add repository operations for enumerating affected runs, attempts, artifacts,
and resolution records, and for deleting conversation-owned rows. Reuse
`selectForConversation(id, [])` for skill-selection removal; do not assume
that a separate clear method already exists.

Within the command transaction:

1. Require the conversation to exist.
2. Reject any non-terminal run with a non-retryable `CONFLICT`.
3. Establish the execution fence and collect affected runtime IDs.
4. Collect artifact candidates and supported references.
5. Remove live output and resolutions while their attempt IDs are available.
6. Remove entries, submissions, context snapshots, skill selections, attempts,
   runs, and the conversation.
7. Remove eligible candidate artifacts, their chunks, and provenance after
   evaluating surviving references.
8. Record the successful command receipt and removal change.

All data changes, receipt insertion, and revision allocation must roll back
together on failure.

Keep owner settings, skills and versions, connectors, credentials, repository
instructions, and shared artifacts intact.

Carry typed internal deletion metadata to post-commit runtime cleanup without
putting run or attempt inventories into the public receipt. Publish
`conversation.remove` only after commit.

**6. Durable command outcomes**

Files:

- `src/worker/rpc/CommandProcessor.ts`
- Command-receipt records and repository
- `src/client/commands/CommandDispatcher.ts`

Compare both command kind and payload hash when an ID already exists.

For deletion, persist defined terminal application rejections, including
active-work `CONFLICT` and `NOT_FOUND`. Roll back the rejected handler's
transaction before recording a rejection under the command coordinator.
Never commit partial deletion work to preserve an error result.

Replaying a rejected deletion returns the original rejection even if the
conversation later becomes idle. A new deletion requires a new command ID.

Keep outcome records free of conversation text and request/result bodies.
Retain accepted create and submit receipts so their delayed retries cannot
recreate deleted work.

The dispatcher removes a definitive rejected deletion from the outbox.
Transport failures retain the original ID. Avoid changing unrelated command
retry policies as part of this feature.

**7. Execution fencing and cancellation completion**

Files:

- `src/worker/runtime/RunDriver.ts`
- `src/worker/runtime/OutputCommitter.ts`
- `src/worker/runtime/RecoveryService.ts`
- `src/worker/owner/OwnerRuntime.ts`
- Run-control service and wake-selection paths as necessary

Stop the driver when reloading finds no run.

Before conversation-specific writes after asynchronous work, validate the
persisted conversation, run, current owner generation, and applicable
attempt/state inside the same transaction as the write. This covers context
preparation, artifact creation, attempt insertion or settlement, entries,
state transitions, and output flushing.

Claim execution for the current generation before driving recovered work.
Do not add generation checks that accidentally prevent legitimate recovery
of older persisted runs.

An invalidated execution returns an explicit stopped outcome. It must not
continue with stale objects, dispatch another effect, or publish an update
for a write that did not occur.

Output flushing validates a writable attempt and its owning run. Add
memory-only buffer disposal for post-commit deletion cleanup, including
`lastFlush` state. Cleanup must not flush discarded content or create another
storage transaction to restore output.

Preserve cooperative cancellation semantics. Ensure persisted cancellation
requests on paused runs can reach a terminal state without requiring object
reconstruction. Process such requests before paused work blocks driver
selection, and schedule the necessary wake. Keep unresolved remote-outcome
evidence until normal resolution or permanent deletion.

Retaining a historical uncertain attempt must not create an additional,
undocumented permanent deletion restriction once the run is terminal and
writes are fenced.

**8. Client operation results and controls**

Files:

- `src/client/components/types.ts`
- `src/App.tsx`
- `src/client/components/ConversationList.tsx`
- Components accepting the existing dispatch callback
- `src/styles.css`

Return `Promise<DispatchResult>` from app dispatch and update callback
consumers to remain type-correct.

Add explicit inline edit, save, and cancel controls. Enter saves except during
IME composition; Escape cancels; blur alone does not submit. Trim input,
reject an empty title, prevent duplicate submission while pending, and retain
the entered value on rejection.

Add a delete confirmation naming the conversation and explaining permanent
history removal. Show current execution restrictions and definitive server
rejections. A stale client eligibility view never replaces the server check.

Keep uncertain operations visibly pending. Handle command outcomes settled
by later outbox replay, not only the first click's promise.

Place controls beside the selection button rather than nesting interactive
controls inside it. Preserve keyboard focus, accessible labels, touch targets,
and narrow layouts.

**9. Authoritative removal and browser cleanup**

Files:

- `src/client/sync/ConversationReducer.ts`
- `src/client/sync/ConversationFeed.ts`
- `src/App.tsx`
- `src/client/storage/DraftStore.ts`
- `src/client/components/ConversationScreen.tsx`
- `src/client/components/Transcript.tsx`
- `src/client/components/ToolCallCard.tsx`

Clear the selected snapshot only when it belongs to the removed conversation.
Clear matching app and feed selections, and clear the displayed draft.
Preserve selection when another conversation is removed.

Add draft enumeration or reconciliation so fresh snapshots can remove drafts
for conversations deleted while this device was offline.

Reset conversation-scoped history and preview state when selection changes.
Capture a selection generation for asynchronous history and artifact requests;
discard responses after that generation is invalidated, including when the
same conversation is selected again later.

Ignore messages from replaced WebSocket instances. Preserve stream-sequence
checks and update snapshot revision when applying a committed change frame.

Expose a distinction between a fresh server snapshot and a locally reduced
change so reconnect processing has an explicit synchronization boundary.

**10. Outbox reconciliation and replay order**

Files:

- `src/client/commands/CommandOutbox.ts`
- `src/client/commands/CommandDispatcher.ts`
- `src/client/commands/registry.ts`
- `src/App.tsx`

Persist optional command-target metadata sufficient to associate new
conversation, run, submission, and attempt mutations with their conversation.
Upgrade existing outbox storage without discarding its entries.

On startup and reconnect:

1. Open the outbox and establish the connection.
2. Receive a fresh authoritative snapshot.
3. Reconcile deleted-conversation browser state and scoped pending mutations.
4. Replay the remaining commands in order.

Serialize reconciliation and replay so competing snapshots cannot flush the
same queue concurrently.

Preserve pending creates and unacknowledged deletes. An accepted create receipt
for a conversation subsequently deleted must not recreate a list item or
select the deleted ID.

Discard obsolete mutations whose deleted target is established by authoritative
state. For legacy entries lacking sufficient target metadata, do not infer
that a run is missing merely because it is absent from the bounded selected
snapshot. Let the existing server lookup settle those commands definitively.

Prevent fresh mutations queued during reconnect from bypassing the same
reconciliation boundary.

**11. ADR references**

Add concise English `ADR-0001` comments near the changed responsibilities:
management commands, deletion ownership, execution fences, and client
reconciliation. Avoid repeating the reference on every line.

## Behavior

### Rename

Renaming remains available in every run state. A successful change preserves
activity, queue count, and preview in the list and synchronizes to other
devices.

A failed edit remains editable. A transport-uncertain edit retains its command
identity; repeated automatic sends must not create new logical commands.

### Delete eligibility

The server rejects deletion if any run is `queued`, `running`,
`waiting_for_auth`, or `needs_attention`.

Requesting cancellation does not immediately change eligibility. Once the
run is terminal and writes are fenced, historical attempt records are removed
with the conversation.

A submission racing deletion is serialized by authoritative transactions:
if submission wins, deletion sees active work and fails; if deletion wins,
the submission finds no conversation.

### Outcomes and retries

A successful delete returns its durable receipt. A repeated accepted command
returns that receipt after the conversation is gone.

A rejected delete remains rejected for the same command ID. This includes a
rejection whose response was lost before reaching the browser. Finishing the
run does not activate the old deletion request.

An unrelated new command targeting a missing conversation receives
`NOT_FOUND`.

### Data and execution

Removal is atomic. An injected storage failure leaves both the conversation
and its dependent records intact and produces no removal frame.

Exclusive artifacts and their chunks disappear. Shared local references
remain valid. Deletion does not reverse effects performed by remote tools.

Late or stale execution cannot create conversation-owned data after deletion.
Owner-global maintenance remains governed by its own resource lifecycle.

### Devices and local state

Deleting the selected conversation returns that device to the existing empty
conversation screen. Other devices converge through removal changes or fresh
snapshots.

Local cleanup occurs after authoritative deletion is known. A device that is
offline performs cleanup when it reconnects.

Pending deletes remain until their own outcome is settled, even when a removal
frame arrives first. Pending creates are not discarded because their eventual
conversation is absent from the current snapshot.

## Tests

Use existing test backends and suites. Add focused tests where destructive
behavior, migration, asynchronous execution, or durable retries need proof.

### Storage and domain tests

Extend `tests/unit/storage.test.ts`, `idempotency.test.ts`, and add
`tests/unit/conversations.test.ts` as appropriate.

Cover:

- Fresh version-2 storage and repeated migration from a populated version-1
  fixture.
- Provenance for every artifact producer, including unlinked compaction plans.
- Provable backfill, shared ownership, and unresolved legacy classification.
- Removal of every conversation-owned table.
- Transaction rollback after an injected mid-deletion failure.
- Every blocking run state and a pending cancellation.
- Terminal historical uncertain attempts without live writers.
- Exclusive artifacts, shared artifacts, resolution-only references, and
  typed application-tool references.
- Reference cycles and eventual removal after the final conversation user is
  deleted.
- Preservation of owner resources.
- Accepted create, submit, and delete receipt replay after deletion.
- Rejected-delete replay after the run finishes, including lost rejection
  acknowledgement.
- Command ID reuse with a different kind or payload.
- Complete rename summaries during active and queued work.

### Runtime tests

Extend `tests/unit/execution.test.ts` and `recovery.test.ts`.

Use controllable model/tool operations and deterministic barriers to cover:

- Deletion refusal during an actual in-flight operation.
- Cancellation of paused work reaching a terminal state.
- Late output flushes after deletion.
- Stale-generation and missing-run writes being discarded.
- No late artifacts, entries, attempts, or publication after removal.
- Normal recovery and cancellation continuing to work with the new fences.

### Client and synchronization tests

Extend `tests/unit/client.test.ts` and `sync.test.ts`.

Cover:

- Selected and unselected removal.
- Terminal deletion rejection leaving the outbox.
- Uncertain deletion retaining the original command ID.
- Fresh-snapshot reconciliation preceding replay.
- Pending-create and unacknowledged-delete preservation.
- Legacy outbox entries with incomplete target metadata.
- Draft cleanup, selection-generation response guards, and replaced-socket
  messages.
- Removal delivery to subscriptions selecting other conversations.

### Worker and browser tests

Extend `tests/workers/owner.test.ts` for deletion, migration, isolation,
receipt replay, and structured rejection through the actual owner RPC path.

Extend `tests/e2e/conversations.spec.ts`, `execution.spec.ts`, and relevant
connection fixtures for:

- Inline save/cancel, empty titles, IME composition, and failed-input retention.
- Rename during execution without losing activity indicators.
- Delete confirmation and cancellation of confirmation.
- Active-work rejection reaching the browser as a definitive error.
- Successful deletion, reload persistence, and absence of the old transcript.
- A second connected device observing deletion.
- An offline device reconciling drafts and pending work after reconnect.
- Stale history or artifact responses after selection changes.
- Keyboard operation and narrow layouts.

The browser rejection test must exercise the Solid server-function boundary;
an in-process `AppError` test alone is insufficient.

## Verification

During this documentation stage:

1. Verify the ADR remains Accepted and this PLAN remains Draft.
2. Inspect the complete documentation diff, including newly created files.
3. Confirm no implementation files changed.

After implementation is authorized:

1. `npm run typecheck`
2. `npm run test:unit`
3. `npm run test:workers`
4. `npm run test:e2e`

The Worker script already runs the build. Record actual outcomes and any
environmental blockers in the eventual implementation report.

Verify the deletion invariants through persisted data and observed frames,
not only disappearance of the list item.

Completion also requires resolution of the legacy-artifact prerequisite and
the planned ADR references. Passing tests alone does not resolve unknown
ownership of pre-existing data.

## Out of scope

- Trash, archive, restore, pinning, bulk deletion, and export.
- Undoing remote tool effects.
- Deleting shared skills, connectors, credentials, repository instructions, or
  owner settings as a consequence of conversation deletion.
- A general-purpose artifact garbage collector unrelated to this operation.
- General execution-engine or command-system redesign beyond the fences,
  cancellation completion, and deletion-outcome handling required here.
- Deployment during the documentation stage.

Pre-existing conversation artifacts are not excluded from permanent-deletion
requirements. Their unresolved attribution is an execution prerequisite below.

## Risks

**Unattributed legacy content.** Existing artifacts may contain conversation
payloads without an ownership relationship. Guessing an owner can destroy
unrelated resources; retaining them silently can make deletion incomplete.
Resolve the migration policy explicitly before approving execution.

**Incomplete reference discovery.** Direct SQL columns alone miss resolution
evidence and application-defined tool references. Maintain one documented
reference inventory, typed readers, and tests for every supported source.
Do not use arbitrary string matching as ownership evidence.

**Execution and recovery regressions.** A generation fence can reject valid
recovered work if it compares only stale persisted generations. Explicitly
claim execution and test both stale rejection and legitimate recovery.

**Delayed destructive commands.** Client-only rejection handling cannot
protect a rejection response lost in transport. Persist terminal deletion
outcomes so retry semantics remain stable.

**Migration failure.** Adding provenance and outcome storage must preserve
existing data and successful receipts. Keep migration transactional,
idempotent, and covered by a populated version-1 fixture.

**Large reference scans.** Atomic deletion must remain within transaction
limits. Index direct lookups, avoid loading unrelated payloads repeatedly, and
test representative large histories. If the required workload cannot fit the
atomic design, revise the PLAN before substituting partial cleanup.

**Browser races.** Reconnect, outbox replay, selection changes, and delayed
responses can restore obsolete state. Use an explicit snapshot boundary,
serialized replay, and selection-generation checks.

## Open Questions

**How should legacy artifacts with no provable ownership be handled?**

The baseline proves that unlinked artifacts can be created, but no inventory
has established whether affected data exists in the target stores.

Before PLAN approval, determine whether existing relationships and a
read-only artifact inventory can establish ownership without guessing. Do not
log or publish artifact payloads as part of that inventory.

The proposed disposition is:

- Backfill ownership where evidence establishes it.
- If no unresolved artifacts remain, close this prerequisite with evidence.
- If unresolved artifacts remain, prepare a concrete migration or cleanup
  proposal identifying the affected artifact classes, what would be retained
  or removed, and how shared resources are protected.
- Obtain agreement on that proposal before destructive migration. Do not
  silently defer the content to future garbage collection or claim complete
  permanent deletion while it remains attributable only by guesswork.

No implementation is authorized by this Draft PLAN. The accepted ADR remains
the governing decision while this prerequisite is resolved.

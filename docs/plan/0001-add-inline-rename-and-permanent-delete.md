# Plan-0001: Add inline rename and permanent delete to conversations

- Created Date: 2026-10-15
- Status: Draft

## Target

The owner can rename a conversation inline from the list and permanently
delete one after confirmation. Renaming works during any run state and keeps
the full conversation summary. Deletion is refused while a run in the
conversation is non-terminal, and, when it succeeds, removes the conversation,
its transcript, runs, attempts, live output, context snapshots, skill
selections, resolution records, and the artifacts owned exclusively by it.
Shared artifacts, skills, repository instructions, connectors, credentials,
and settings survive. Other devices observe the removal, and a definitive
active-run refusal is shown to the user instead of being retried later.

## Start

This plan starts from the ADR-0001 baseline. At that baseline:

- `conversation.rename` is wired end to end (command kind, server function,
  `OwnerRuntime` dispatch case, `ConversationService.rename`,
  `ConversationRepository.rename`). It publishes `conversation.upsert`, but
  the published summary carries only `queuedCount`, so it drops
  `activeRunState` and `lastEntryPreview`.
- There is no `conversation.delete` command kind, RPC method, service method,
  or repository delete. The wire protocol and `SyncHub` already support
  `conversation.remove`, and `ConversationReducer` removes the list item, but
  it leaves `selectedConversation` intact. Nothing produces the change.
- Conversation data is spread across `conversations`, `submissions`, `runs`,
  `attempts`, `entries`, `live_output`, `context_snapshots`,
  `conversation_skills`, and `attempt_resolutions`. The schema has no foreign
  keys. Artifacts have no ownership column. Skill resources and repository
  instructions reference shared artifacts.
- `OutputCommitter.flush` writes `live_output` without checking that the
  attempt still exists. `RunDriver.runLoop` reloads a run but falls back to the
  stale in-memory run when the row is gone.
- `CommandDispatcher` keeps every `CONFLICT` pending for retry, and
  `AppActions.dispatch` returns `Promise<void>`, so the client cannot observe
  or display a command outcome.
- Command receipts store only small result objects (`{ conversationId }`,
  `SubmitResult`, view results); they do not store conversation text or
  request/result bodies.

## Architecture

The change keeps the existing ownership boundaries:

- **Shared contracts.** `DeleteConversationInput` and the
  `conversation.delete` command kind join `src/shared/commands.ts`. No new
  wire change is needed: `conversation.remove` already exists.
- **RPC layer.** `deleteConversation` is added to the server functions
  (`src/rpc/conversations.ts`) and to the `OwnerRpc` interface/base
  (`src/worker/rpc/OwnerRpc.ts`). The existing `OwnerRpcClient` already turns
  RPC errors back into `AppError`, so a `CONFLICT` reaches the client intact.
- **Command path.** `OwnerRuntime.dispatch` gains a `deleteConversation` case
  routed through `CommandProcessor`, preserving receipt idempotency. After a
  successful commit it also clears in-memory committer buffers and aborts
  controllers for the deleted runs.
- **Domain service.** `ConversationService.delete` performs the eligibility
  check, dependent-row deletion, reference-aware artifact removal, and emits
  `conversation.remove`. All of it happens inside the existing synchronous
  `StoreTransaction`, so it commits atomically with the command receipt and
  revision.
- **Storage.** Repositories gain explicit delete/reference methods. Artifacts
  gain a nullable `conversation_id` provenance column so a conversation owns
  the artifacts it creates, including artifacts created before their
  referencing attempt row.
- **Execution boundary.** Deletion is gated on the authoritative run/attempt
  state, and the driver stops when its run row disappears. `OutputCommitter`
  refuses to write output for a missing attempt.
- **Client.** `ConversationList` owns the inline rename editor and the
  confirmed delete action. `AppActions.dispatch` returns a `DispatchResult`,
  the reducer clears the selected snapshot on removal, and the app clears its
  selection and conversation-scoped browser state.

## Changes

**1. `src/shared/commands.ts`**
- Add `DeleteConversationInput { conversationId: ConversationId }`.
- Add `"conversation.delete"` to `CommandKind`.
- Keep the existing rename/create inputs unchanged.

**2. `src/worker/storage/schema.ts`**
- Add `conversation_id TEXT` to the `CREATE TABLE IF NOT EXISTS artifacts`
  statement for fresh installs.
- Bump `SCHEMA_VERSION` to `2`.

**3. `src/worker/storage/records.ts`**
- Add optional `conversationId?: ConversationId` to `ArtifactRecord`.

**4. `src/worker/storage/SqlStore.ts`**
- Extend `migrate()`: after the schema statements and `ensure()` calls, if the
  recorded schema version is below `2`, add the `artifacts.conversation_id`
  column when `PRAGMA table_info(artifacts)` does not report it, then backfill
  provable ownership from `attempts` and `entries` and record version `2`.
- Extract `projectConversationSummary(tx, record): ConversationSummaryView`
  (active run state, last-entry preview, queued count) and use it from
  `buildSnapshot`.

**5. `src/worker/storage/repositories.ts`**
- `ConversationRepository.delete(id)`.
- `SubmissionRepository`: `listForConversation`, `deleteForConversation`.
- `RunRepository`: `listForConversation`, `deleteForConversation`.
- `AttemptRepository`: `listForConversation`, `deleteForConversation`,
  `listArtifactIds`.
- `EntryRepository`: `listForConversation`, `deleteForConversation`,
  `listArtifactIds`.
- `LiveOutputRepository`: `delete(attemptId)`.
- `ContextSnapshotRepository`: `deleteForConversation`.
- `AttemptResolutionRepository`: `listForConversation`, `deleteForAttempts`,
  `listAll`.
- `SkillRepository`: reuse `selectForConversation(id, [])` to clear
  selections; add `listResourceArtifactIds`.
- `RepositoryInstructionRepository`: `listArtifactIds`.
- `ArtifactRepository`: accept and map `conversationId` in `create`/`get`,
  add `listByConversation`, `listUnattributed`, `delete(id)`, and
  `deleteChunks(id)`.
- Keep every method synchronous and free of cross-repository calls.

**6. `src/worker/conversations/services.ts`**
- Add `ConversationService.delete(tx, input): ServiceOutcome<void>`.
  - Load the conversation; throw `NOT_FOUND` when absent.
  - Refuse with `CONFLICT` when `tx.runs.activeForConversation(id)` returns a
    run, or when the conversation's attempts include `prepared`, `dispatched`,
    or `unknown`.
  - Collect candidate artifact ids from provenance
    (`tx.artifacts.listByConversation`), the conversation's attempt
    request/result ids, the conversation's entry artifact ids, and artifact
    ids inside the conversation's `attempt_resolutions.evidence_json`.
  - Delete entries, submissions, live output for the attempts, attempts,
    runs, context snapshots, resolution records, and skill selections
    (`selectForConversation(id, [])`), then the conversation row.
  - Build the surviving-reference set from all attempts, entries, skill
    resources, repository instructions, and parsed resolution evidence, then
    delete each candidate artifact and its chunks that is not referenced.
  - Return `{ kind: "conversation.remove", conversationId }`.
- Make `ConversationService.rename` and `create` publish the full summary via
  the shared `projectConversationSummary` helper.

**7. `src/worker/rpc/OwnerRpc.ts`**
- Add `deleteConversation(command): Promise<CommandReceipt<void>>` to the
  interface and `OwnerRpcBase`.

**8. `src/rpc/conversations.ts`**
- Add the `deleteConversation` server function delegating to
  `requireRpcContext().ownerStub.deleteConversation`.

**9. `src/worker/owner/OwnerRuntime.ts`**
- Add the `deleteConversation` dispatch case using kind `conversation.delete`.
- Store the `OutputCommitter` as a field and add a post-commit cleanup that
  clears its buffers and aborts `RunDriver` controllers for the deleted
  conversation's runs. Capture the affected attempt ids before deletion (for
  example through the service outcome) so cleanup can run after commit.

**10. `src/worker/context/ContextAssembler.ts`**
- Create the compaction-plan artifact with
  `conversationId: run.conversationId`.

**11. `src/worker/runtime/RunDriver.ts`**
- Pass `run.conversationId` to `storeArtifact` and record provenance on every
  conversation artifact.
- In `runLoop`, stop when `reload(run.id)` returns `undefined` instead of
  continuing with the stale run object.
- Guard driver write helpers (`newEntry`, `applyTransition`, `insertAttempt`,
  `updateAttempt`, `storeArtifact`) so a missing conversation or run makes the
  step a no-op that stops the loop.

**12. `src/worker/runtime/OutputCommitter.ts`**
- In `flush`, check `tx.attempts.get(attemptId)` before appending live output;
  drop the buffer and skip the write when the attempt is gone.
- Keep `clear` idempotent.

**13. `src/client/commands/registry.ts`**
- Add the `conversation.delete` handler.

**14. `src/client/commands/CommandDispatcher.ts`**
- Treat a `CONFLICT` as terminal for the `conversation.delete` kind: reject
  it and remove it from the outbox instead of retrying. Keep the existing
  retry behavior for transport failures, lost acknowledgements, and
  `UNAUTHENTICATED`.
- Keep returning the `DispatchResult` so the UI can observe the outcome.

**15. `src/client/components/types.ts`**
- Change `AppActions.dispatch` to return `Promise<DispatchResult>`.

**16. `src/client/sync/ConversationReducer.ts`**
- On `conversation.remove`, also clear `selectedConversation` when its id
  matches.

**17. `src/App.tsx`**
- Return the `DispatchResult` from `actions.dispatch`.
- On a snapshot where the selected id is gone, clear `selectedId`, the feed
  selection, and the conversation draft.
- Track per-conversation rename/delete operation state (pending, error) for
  the list.
- Guard `onHistory`/`onReadArtifact` responses by selection identity.

**18. `src/client/components/ConversationList.tsx`**
- Add an inline rename editor with explicit save/cancel, IME-safe Enter
  handling, preserved input on failure, and pending/error display.
- Add a delete control with a confirmation that names the conversation and
  states that history is permanently removed.
- Show the blocking state when deletion is refused because a run is active.

**19. `src/client/components/ConversationScreen.tsx`**
- Reset loaded history when the selected conversation changes and discard
  late responses for a previous selection.

## Behavior

- Rename trims the title, rejects an empty result, and is allowed in every run
  state. The published summary preserves `activeRunState`,
  `lastEntryPreview`, and `queuedCount`.
- Rename with Enter during IME composition does not submit; blur alone does
  not commit. Escape cancels. A failed save keeps the typed value and shows
  the error.
- Delete is refused with `CONFLICT` for `queued`, `running`,
  `waiting_for_auth`, and `needs_attention` runs, and for any `prepared`,
  `dispatched`, or `unknown` attempt in the conversation.
- Delete on an unknown conversation returns `NOT_FOUND`.
- A repeated delete with the same `commandId` returns the durable receipt and
  does not delete twice.
- Successful deletion removes all conversation-owned rows in one transaction
  and publishes `conversation.remove` only after commit.
- Artifacts owned exclusively by the conversation are deleted with their
  chunks. Artifacts referenced by any surviving attempt, entry, skill
  resource, repository instruction, or resolution evidence are preserved.
- A refusal caused by an active run is terminal on the client: the command
  leaves the outbox and the user must act again. Transport-uncertain deletes
  keep their command id and remain pending.
- When the deleted conversation is selected, the reducer, app, and feed clear
  the selection and the empty conversation screen is shown. Deleting another
  conversation preserves the selection.
- Drafts, loaded history, and artifact previews for the deleted conversation
  are cleared. Late history/artifact responses for a removed or replaced
  selection are discarded.
- A missing run row stops the driver loop, and a missing attempt causes
  `OutputCommitter` to drop buffered output, so no late write recreates
  deleted records.

## Tests

Unit (`tests/unit`, node:sqlite backend):

- `storage.test.ts`: schema migration to version `2` adds the artifact
  provenance column and backfills provable ownership; artifact delete removes
  chunks.
- `idempotency.test.ts`: repeated delete returns the original receipt; a
  changed payload with the same command id conflicts.
- New `conversations.test.ts`:
  - delete cascades every owned table and emits `conversation.remove`;
  - delete is refused for each non-terminal run state and each
    prepared/dispatched/unknown attempt;
  - delete succeeds once the run is terminal;
  - exclusive artifacts are removed while shared skill-resource and
    repository-instruction artifacts survive;
  - an artifact referenced only by resolution evidence survives;
  - rename preserves `activeRunState`, `lastEntryPreview`, and `queuedCount`;
  - `OutputCommitter.flush` for a missing attempt does not recreate
    `live_output`.
- `client.test.ts`: the reducer clears `selectedConversation` on
  `conversation.remove`; the dispatcher rejects and drops a
  `conversation.delete` `CONFLICT` while keeping other conflicts pending.

Workers (`tests/workers`, workerd backend):

- `owner.test.ts`: delete round-trips through RPC and returns a receipt; a
  delete against a conversation with a queued run returns `409 CONFLICT`.

Browser (`tests/e2e`, Playwright):

- `conversations.spec.ts`: inline rename persists across reload; confirmed
  delete removes the conversation; a second device observes the removal.
- `execution.spec.ts`: deleting a conversation with an active run shows the
  blocking state and does not delete it.

## Verification

1. `npm run typecheck`
2. `npm run test:unit`
3. `npm run test:workers` (builds the client/worker before running)
4. `npm run test:e2e`

Completion requires all four to pass and the ADR-0001 code references to be in
place.

## Out of scope

- Trash, archive, restore, and undelete.
- A global artifact garbage collector and a purge of pre-existing
  unattributed artifacts.
- Reversing effects already performed by connected tools.
- Changes to run-recovery semantics beyond the write guards above.
- Bulk selection, multi-delete, and conversation export.
- Renaming or deleting from the conversation header or the settings screen.

## Risks

- **Schema migration on existing storage.** Adding a column and backfilling
  must be idempotent and safe on a live Durable Object. Mitigation: guarded
  `PRAGMA`/`ALTER`, bounded backfill, and a migration test from a version-1
  store.
- **Artifact reference completeness.** A missed reference could delete a
  shared artifact. Mitigation: provenance plus an explicit scan of every
  reference table and structured resolution evidence, with a test for each
  source.
- **Race between delete and the driver.** Mitigation: the non-terminal-run and
  non-settled-attempt gate, the `runLoop` reload stop, and the
  `OutputCommitter` attempt-existence guard.
- **Terminal-conflict policy.** Dropping a delete on `CONFLICT` is safe only
  because delete returns `CONFLICT` solely for an active run. Mitigation: keep
  the policy scoped to `conversation.delete` and cover it with a unit test.
- **Stale client state.** Mitigation: reducer/app/feed selection cleanup,
  history reset, and response-identity guards.

## Open Questions

- **Pre-existing unattributed artifacts.** Artifacts created before the
  provenance column, in particular compaction-plan artifacts that
  `ContextAssembler.prepare` created without a persisted reference, cannot be
  attributed to a conversation after migration. Proposed resolution: a
  follow-up audit that lists artifacts with no provenance and no reference;
  do not purge them indiscriminately, and do not invent ownership.
- **Receipt retention.** Receipts are retained minimally and currently hold no
  conversation text or request/result bodies. If a future command stores
  conversation content in a receipt, deletion must also purge or redact it.

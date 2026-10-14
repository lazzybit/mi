# ADR-0001: Add inline rename and permanent delete to conversations

- Created Date: 2026-10-15
- Status: Accepted
- Baseline: c7435dc8b9d78864754f47d6b0b351c3c6dead66

## Status Quo

The client can create and select conversations, but it provides no rename or
delete controls.

Rename already has a command, server function, runtime dispatch case, service,
and repository method. `ConversationService.rename` trims the title, rejects
an empty title, and publishes `conversation.upsert`. Its published summary
does not include all the fields assembled by a full snapshot, including the
active-run state and last-entry preview.

No conversation deletion command or storage operation exists. The wire
protocol already defines `conversation.remove`, and `SyncHub` forwards that
change regardless of the selected conversation. Nothing produces it.
`ConversationReducer` removes the list item but leaves the selected
conversation intact.

Conversation data spans `conversations`, `submissions`, `runs`, `attempts`,
`entries`, `live_output`, `context_snapshots`, `conversation_skills`, and
`attempt_resolutions`. The schema has no foreign-key cascades. Artifacts and
their chunks are stored separately without a conversation ownership column.
Artifact references also exist in shared resources, including skill resources
and repository instructions.

Commands use durable receipts for deduplication and a browser outbox for
retries. The dispatcher currently retains every `CONFLICT` for retry, and the
app's dispatch wrapper does not return the command outcome to its caller.

Execution continues independently of the browser. Cancelling a running or
paused run records a cancellation request; it does not synchronously finish
that run. The driver performs asynchronous work and is not protected by the
command processor's transition coordinator.

## Needs

The owner needs to rename conversations inline and permanently delete them
from the client.

Management actions must respect execution state. Changing a title must remain
available during execution, while deletion must not destroy state still
needed by running work or recovery.

Permanent deletion must remove conversation-owned content, including
identifiable stored request and result payloads. Shared owner resources must
remain available to their other users. The adopted interim approach has the
explicit historical-retention exception described below.

The client must distinguish pending work, successful commands, and definitive
rejections. Other devices must converge on the same conversation state,
including after reconnecting.

## Decision

### Inline rename

Provide an explicit rename control beside each conversation title. Editing
takes place within the list item.

Enter or an explicit save control submits the edited title. Escape or a
cancel control discards the edit. Enter during input-method composition does
not submit. Blur alone does not commit a change.

Trim the title and reject an empty result. Keep the entered value available
when saving fails, and show the pending or error state alongside the editor.

Reuse `conversation.rename` and its existing command path. Renaming is allowed
while a run is queued, running, waiting for authentication, or awaiting
attention: it changes display metadata, not execution input.

The published update must preserve the complete conversation summary,
including execution state, queued count, and preview. A rename must not make
an active conversation appear idle.

### Permanent delete

Add `conversation.delete` with payload `{ conversationId }` through the
existing server-function, runtime, service, and command-receipt path.

Require confirmation that identifies the conversation and states that its
history will be permanently removed. There is no trash, archive, or restore
operation.

Before deleting, check the authoritative state in the same transaction that
performs deletion. Refuse deletion while any run in the conversation is
non-terminal: `queued`, `running`, `waiting_for_auth`, or `needs_attention`.

The client explains the blocking state. The owner can finish, cancel, or
resolve the work through the existing controls, as appropriate, and then
request deletion again. Deletion does not implicitly cancel execution.

A cancellation request alone does not make a conversation deletable.
Successful deletion also requires that execution can no longer write or
publish data for that conversation. The implementation must establish a
quiescent boundary or prevent late writes before reporting success; a
displayed status alone is insufficient.

An unknown conversation id returns `NOT_FOUND`. Repeating an accepted command
with the same command id returns its durable receipt without repeating the
operation.

### Data removal

Perform the local deletion atomically with its command receipt and owner
revision. Remove:

- The conversation, transcript entries, and submissions.
- Its runs, attempts, and live output.
- Its context snapshots and attempt-resolution records.
- Its conversation-to-skill selections.
- Identifiable artifacts and artifact chunks owned exclusively by the deleted
  conversation and unused by surviving records.

Use existing, verifiable ownership relationships for the interim
implementation. Before removing referring records, collect request/result
artifact IDs from the conversation's attempts and any attachments whose
conversation ownership is established.

Resolution evidence and application-tool inputs are references, not proof
that their containing conversation owns the referenced artifact. Preserve
candidate artifacts used by surviving attempts, entries, resolution evidence,
skill resources, repository instructions, or supported application-defined
local references such as `app__read_tool_result`.

Do not introduce an artifact-provenance table or historical ownership
backfill for this feature.

Stop creating new unlinked conversation artifacts. Remove the unused
compaction-plan artifact write: the driver does not consume its returned
effect ID, and the actual compaction request is stored separately. Create
request artifacts with their attempt insertion and result artifacts with
their attempt update in the same transaction.

**Adopted temporary exception.** Pre-existing artifacts without a verifiable
ownership relationship are not removed by this operation. Historical
compaction-plan artifacts and payloads stranded before attempt linking may
therefore remain. This exception does not permit retaining identifiable
exclusive conversation payloads.

The operation permanently removes conversation records and identifiable
exclusive payloads; it does not guarantee complete content erasure of
previously unattributable payloads. Do not guess ownership or perform a
global purge.

The underlying separation of execution payloads, skill resources, and
repository instructions by ownership and lifecycle is deferred and recorded
in [TODO](../TODO.md). Historical inventory and cleanup belong to that work;
they are not prerequisites for preparing or approving this interim plan.

Keep resources that remain shared, including skill definitions and versions,
repository instructions, connectors, credentials, and owner settings.
Removing a conversation's skill selection does not remove the skill.

Keep the minimal command receipts required for deduplication. They must not
retain conversation text or request/result bodies. Retaining receipts prevents
a delayed retry of a previously accepted create or submit command from
recreating deleted work.

Deletion removes application-owned conversation data. It does not reverse
effects already performed by connected tools.

### Command outcomes

Management controls must receive and display the dispatch outcome.

A refusal because the conversation is active is a definitive, non-retryable
`CONFLICT`. Remove that command from the outbox; do not automatically delete
the conversation when execution later finishes. A new deletion attempt
requires a new user action.

Transport failures and lost acknowledgements retain the same logical command
and command id for retry. While its outcome is unknown, the client shows a
pending operation rather than claiming deletion succeeded.

### Synchronization and client cleanup

Publish `conversation.remove` only after deletion commits. All connected
devices receive the removal. Fresh snapshots omit the deleted conversation.

When the deleted conversation is selected, clear its selected snapshot, app
selection, and feed selection, and show the existing empty conversation
screen. Deleting another conversation preserves the current selection.

Clear conversation-specific browser state after authoritative deletion is
known: drafts, loaded history, artifact previews, and obsolete pending
mutations targeting the deleted records. Preserve an unacknowledged delete
command until its own outcome is settled.

Discard late history or artifact responses belonging to a deleted or replaced
selection. Reconnecting clients reconcile their local state against the
authoritative snapshot before replaying obsolete conversation mutations.
An offline device applies this cleanup when it reconnects.

## Reason

Inline editing provides a direct way to change a title and reuses the existing
rename operation. Allowing it during execution distinguishes harmless metadata
changes from operations that would invalidate execution state.

Removing identifiable conversation payloads as well as the conversation row
provides a bounded interim deletion operation. Reference-aware removal
preserves resources still used elsewhere. Atomic payload linking and removal
of the unused compaction-plan write prevent the demonstrated sources of new
unlinked conversation artifacts.

The accepted historical-retention exception avoids guessing ownership of
existing unlinked content. It is an explicit limitation, not complete content
erasure. Separating the different content lifecycles addresses the root
problem and is recorded in TODO instead of expanding this feature into an
artifact-storage redesign.

Refusing deletion during non-terminal work preserves the state needed for
execution and recovery. Implicit cancellation is insufficient because remote
work and output callbacks can outlive a cancellation request. The deletion
boundary must prevent those callbacks from restoring deleted data.

Using the existing command and synchronization paths preserves authorization,
deduplication, and multi-device consistency. Definitive rejections must leave
the retry queue so that an unavailable destructive action cannot silently run
later.

Soft deletion and archiving do not meet the requested permanent-deletion
behavior. Blocking all management during execution would unnecessarily prevent
renaming. Deleting immediately after requesting cancellation would introduce
a race with execution and output persistence.

# TODO

## Separate stored content by ownership and lifecycle

Status: Deferred architectural work.

Related documents:

- [ADR-0001](adr/0001-add-inline-rename-and-permanent-delete.md)
- [PLAN-0001](plan/0001-add-inline-rename-and-permanent-delete.md)

The current artifact abstraction combines model requests, tool arguments,
tool results, compaction plans, skill resources, and repository instructions.
These records have different owners, retention requirements, and deletion
boundaries. A common blob store does not establish a common domain lifecycle.

The root solution should give these responsibilities explicit domain owners
and lifecycle rules. Physical byte storage may remain shared where useful,
but domain ownership and deletion must not depend on reconstructing meaning
from an untyped artifact graph.

Future work:

- Define ownership and retention separately for execution requests, tool
  results, skill resources, and repository instructions.
- Keep execution payload creation and its owning record atomic.
- Remove persisted content that has no consumer, rather than introducing a
  storage category solely to retain it.
- Define explicit references and retention behavior for content used by more
  than one domain record.
- Design a migration from the existing artifact tables, including how to
  identify and dispose of historical unlinked payloads without guessing their
  owner or deleting unrelated resources.
- Test deletion and retention against each domain's lifecycle.
- Resolve the temporary retention limitation below as part of that work.

### Adopted interim approach

ADR-0001 uses existing, verifiable ownership relationships for conversation
deletion. It collects request/result artifacts linked from the conversation's
attempts and any attachments whose conversation ownership is established.
It removes those artifacts and their chunks only when surviving records do
not use them.

Resolution evidence and application-tool inputs are references, not ownership
proof. Shared skill resources, repository instructions, and content still used
by another conversation are preserved.

Prevent new unlinked conversation payloads by:

- Removing the unused compaction-plan artifact write.
- Creating request artifacts in the transaction that inserts their attempt.
- Creating result artifacts in the transaction that links them to their
  attempt.

This interim approach adds no artifact-provenance table and performs no
historical ownership backfill.

### Temporary retention limitation

Historical artifacts created without a persisted ownership relationship may
remain after conversation deletion. Known sources include the unused
compaction-plan write and interruption between artifact creation and attempt
linking.

The number of affected artifacts in deployed storage has not been established.
This is a known limitation of the adopted stopgap, not evidence that every
store contains such data.

Conversation records and identifiable exclusive payloads are permanently
removed. The operation does not guarantee complete erasure of previously
unattributable payloads.

Do not guess ownership from timestamps, content resemblance, arbitrary
strings, or external objects containing an `artifactId`. Do not perform a
global artifact purge as part of conversation deletion.

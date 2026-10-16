# ADR-0005: Prioritize user-relevant information in mi

- Created Date: 2026-10-16
- Status: Proposed
- Baseline: cb559334af4e3d89aa74f192067d270e51e054b7

## Status Quo

Following ADR-0003, mi projects pi-durable's committed conversation entries
and live assistant partial into the browser transcript.

`src/client/view.ts` flattens assistant `text` and `thinking` content blocks
into one string. Both committed messages and the live partial use this
projection. `AssistantMessage.tsx` renders the resulting string as ordinary
assistant text, so thinking content appears directly alongside the answer.

Tool results become individual display entries rendered by
`ToolCallCard.tsx`. A closed card still displays up to 200 characters of
output, together with a result or error label. Error results also receive
distinct styling.

The projection ignores assistant `toolCall` blocks. It therefore does not
currently preserve the call arguments and call identity needed to present
each invocation together with its result.

pi-ai's `ToolResultMessage` provides an optional `durationMs`. pi-durable
records this execution duration in tool results when available. It is
already part of the committed conversation data; older or otherwise
unmeasured results may omit it.

These behaviors share one problem: the default presentation gives execution
detail prominence without weighing its value to the user.

## Needs

- Keep assistant answers readable, and foreground what helps the user
  understand the result or the current activity.
- Reduce distracting execution detail. Simplicity does not mean hiding
  everything; it means choosing what deserves prominence.
- Retain access to thinking content, tool arguments, and tool results through
  explicit expansion.
- Show each tool invocation separately, in call order, with its recorded
  duration when available.
- Apply the same presentation to live responses and conversation history.
- Preserve the model conversation and its continuation data.

## Decision

mi shows the information that helps the user understand the result or the
current activity, and places supporting execution detail behind explicit
expansion. This policy is applied through deliberate UI decisions; it is not
automatic classification, and it does not remove content from messages.

1. Preserve assistant content structure in the client projection. Render
   ordinary assistant text directly and keep its position among the other
   elements. Do not concatenate thinking into answer text, and do not create
   empty answer rows for messages containing only thinking or tool calls.

2. Use the exact label `Thinking ...` for each thinking disclosure. It is
   collapsed by default, and clicking it reveals the available thinking
   content. Streaming updates update that content without automatically
   expanding or collapsing the disclosure.

   Do not display thinking seconds. Do not introduce thinking timers,
   server-side measurements, timing documents, or snapshot timing fields.

3. Render one disclosure row per tool invocation. Do not aggregate calls into
   counts or tool groups.

   Show the tool name and, when available, its recorded duration in seconds.
   The required format is exemplified by `Bash．10s`. The separator is `．`
   (U+FF0E), with no spaces on either side.

4. Read completed duration from `ToolResultMessage.durationMs`. When it is
   absent, show the tool name alone. Do not fabricate a duration from task
   timestamps, response duration, or the arrival of another transcript item.

5. A collapsed tool row contains its name and available duration only. Remove
   output previews, result labels, error labels, and error-specific styling
   from the collapsed presentation.

   Clicking the row reveals the available call arguments and result content.
   Error information contained in the result remains available in those
   details.

6. Establish tool rows from assistant tool calls and associate results using
   their call identifiers within the corresponding assistant message.
   Completing a call updates its existing row instead of adding another row.

   Preserve call order even when tools execute concurrently and their results
   arrive in a different order. A call whose result has not arrived can still
   appear under its tool name. Available historical results whose call record
   is not loaded remain accessible without inventing missing arguments.

7. Keep thinking and tools in their conversational sequence. For example,
   thinking followed by tools and then further thinking remains a sequence
   of separate disclosures. The resulting presentation can include:

       ▸ Thinking ...
       ▸ Bash．10s
       ▸ Read．2s
       ▸ Thinking ...

8. Keep expansion state local to the client and scoped to the conversation
   and disclosure identity. New disclosures default to collapsed. Streaming
   updates and the transition from a live item to its committed counterpart
   must preserve the user's expansion choice.

   Use accessible disclosure controls that work with touch and keyboard.

9. Implement this decision through client projection and rendering of
   existing conversation data. Preserve the original thinking blocks, tool
   calls, and tool results in the stored model conversation.

   No new durable documents, model-stream interception, or timing transport
   is required.

The principle guides future UI decisions, but the concrete changes in this
decision cover thinking and tool presentation only. It does not redesign
compaction summaries, queued submissions, connection errors, or submission
handling, and it adds no token counts, cost badges, tool grouping, or new
status indicators.

This decision refines the transcript presentation introduced by ADR-0003.
Its adoption of pi-durable, committed conversation state, and session
transport remains in force. ADR-0003 is not superseded.

## Reason

Relevance determines prominence. An answer the user asked for deserves
direct display; execution detail that merely accompanies it does not.
Treating every produced artifact as equally visible interrupts reading
without adding information the user needs at that moment.

Disclosures retain access to thinking text, tool arguments, and results
while keeping the default view compact. Concise labels and recorded tool
durations carry the useful signal: what ran, in what order, and how long it
took. Removing the existing tool preview is necessary because a closed card
that still exposes output continues the distraction it was meant to avoid.

Individual tool rows preserve execution sequence and make each invocation
available for inspection; group counts obscure that sequence. Thinking
duration was deliberately removed from scope, since the fixed `Thinking ...`
label provides access to the content without measurement and recovery
machinery.

Keeping this policy in the client preserves provider continuation data and
the durable conversation, while allowing live responses and history to share
one presentation.

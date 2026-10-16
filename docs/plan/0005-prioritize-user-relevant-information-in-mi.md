# Plan-0005: Prioritize user-relevant information in mi

- Created Date: 2026-10-16
- Status: Draft

## Target

- Assistant answer text remains directly visible in its conversational
  position.
- Each thinking block becomes a disclosure labelled exactly `Thinking ...`,
  collapsed by default. Expanding it reveals the available thinking text.
- Each tool invocation becomes a separate disclosure in call order.
  A completed call with recorded duration uses the format `Bash．10s`,
  preserving `．` (U+FF0E) without surrounding spaces.
- A tool without recorded duration displays its name alone.
- Closed tool disclosures show no output preview, result or error label,
  or error-specific styling. Expanded disclosures expose available arguments
  and result content.
- Streaming updates and live-to-committed transitions preserve the user's
  expansion choices.
- Loading history across call/result boundaries does not lose details or
  duplicate tool rows.
- The implementation uses existing conversation data and changes client
  projection and rendering. It introduces no thinking timing, durable
  documents, model-stream interception, or transport changes.

## Start

The starting implementation is the baseline recorded in ADR-0005. The claim
commit and subsequent ADR documentation have not changed application code.

ADR-0005 is currently recorded as Proposed. This Draft PLAN describes the
requested implementation approach; it does not change the ADR's status or
claim implementation approval.

`src/client/view.ts` projects each raw entry into at most one `DisplayEntry`.
For assistant messages, `assistantText()` concatenates `text` and `thinking`
blocks. The same function handles the committed transcript and the live
partial in `pi.live.generation.message`.

Assistant tool calls are ignored. Tool results become separate display
entries with flattened output, a tool name, and an error flag. The projection
does not retain call arguments, call identifiers, or recorded duration.

`AssistantMessage.tsx` renders assistant text and existing summary/error
notices. `ToolCallCard.tsx` owns an expansion signal, but its closed state
still displays up to 200 characters of result output and a result/error
label.

`Transcript.tsx` renders the projected array through Solid's `For`.
`ConversationScreen.tsx` stores older history as already-projected
`DisplayEntry[]`, separately from the active view. This arrangement cannot
reliably pair a call on one page with its result on another.

pi-ai's `ToolResultMessage.durationMs` is optional. pi-durable includes it
in committed results when execution timing is available.

The unit test project runs in Node and currently tests basic transcript
projection with text-only assistant fixtures. Browser tests exercise the
real application and already use Playwright WebSocket interception.

## Architecture

### Structured transcript projection

Keep `src/client/view.ts` as the pure projection layer.

Replace the flat display-entry shape with a discriminated representation
for user content, assistant text, thinking disclosures, tool disclosures,
and existing conversation summaries. Retain source identities separately
from rendered text.

An assistant message can produce several ordered rows. Tool results enrich
the corresponding call row rather than creating another row when a match
exists.

Projection reads the complete loaded raw entry sequence and the current
live partial. It does not mutate the conversation view or stored messages.

### Raw history ownership

`ConversationScreen` retains older pages as raw `EntryRecord[]`.

Combine and deduplicate loaded history and active entries before projecting
them. Preserve the existing page and active-view ordering; do not replace
pi-durable's context ordering with a global numeric-ID sort.

This gives projection the information needed to associate calls and results
across page boundaries.

### Disclosure identity and state

Use a small client-only presentation-state module to manage disclosure
identity and expansion choices.

Committed identities derive from the managed conversation identifier, source
entry, and content position. Tool identities additionally retain their call
identifier within the originating assistant message. A bare toolCallId or
array index is not a globally unique identity.

An observed live generation receives a local identity. When its assistant
entry is committed, reconcile that identity with the committed source and
retain the user's expansion choices.

This module owns presentation state only. It does not reconstruct execution
state, persist data, or introduce another session protocol.

### Disclosure rendering

Use a shared accessible disclosure component for thinking and tools.

The parent supplies expansion state. Component remounts or new projected
objects must not reset that state.

Thinking renders its exact label and available text. Tools render their
name, optional recorded duration, and available arguments/result details.

### Duration presentation

Read duration exclusively from the associated result's `durationMs`.

For a finite, non-negative value, round milliseconds to the nearest whole
second and append `s`. Zero is a valid recorded duration. Missing or invalid
values omit both the separator and duration.

For example, a tool named `Bash` with `durationMs: 10000` displays
`Bash．10s`. Preserve the available tool name; do not introduce a new naming
catalog.

There is no live duration ticker. Before a result provides a duration, the
row displays the tool name.

## Changes

**1. `src/client/view.ts`**

- Replace the single optional-field `DisplayEntry` structure with explicit
  row variants and source identity metadata.
- Preserve user-content conversion, queued-input projection, and live-run
  summaries.
- Replace `assistantText()` with ordered content-block projection.
- Emit assistant text separately from thinking blocks.
- Omit empty assistant text rows while retaining thinking and tool rows.
- Preserve the existing assistant failure presentation when no answer text
  is available. Thinking content must not become a substitute error message.
- Extract tool call identifiers, names, and available arguments from
  assistant `toolCall` blocks.
- Associate tool results with their originating calls using toolCallId within
  the corresponding assistant round.
- Attach result content and `durationMs` to the existing call row.
- Preserve call order when results arrive out of order.
- Keep unmatched historical results visible as standalone tool disclosures.
- Project the live partial using the same content rules.
- Preserve existing summary presentation and image placeholders.
- Add a concise ADR-0005 reference near the presentation responsibility.

**2. `src/client/transcript/DisclosureState.ts` — new**

- Own conversation-scoped expansion choices and presentation identity
  reconciliation.
- Assign local identities to observed live generations and their content
  blocks.
- Track the originating generation task/attempt and the surrounding committed
  entries needed to recognize a live-to-committed transition.
- Transfer state to the corresponding committed assistant rows using the
  observed transition and available task attribution. Do not use timestamp
  alone or transfer state to an unrelated retry.
- Preserve tool-row state when a live call receives its final identifier or
  result.
- Transfer expansion state when loading history replaces a standalone result
  row with its matched call row.
- Reset or isolate state when the managed conversation changes.
- Default newly encountered disclosures to collapsed.
- Keep this module independent of network and durable storage APIs.

**3. `src/client/components/ConversationScreen.tsx`**

- Store older history as raw entries instead of display entries.
- Deduplicate history and active data by raw entry identity before projection.
- Project the combined sequence once, then append or reconcile the live
  assistant content.
- Supply disclosure identities, expansion state, and toggle callbacks to the
  transcript.
- Preserve pagination cursors, selection-generation guards, and protection
  against late history responses.
- Preserve the existing conversation controls, composer, queue, and run
  status behavior.

**4. `src/client/components/Transcript.tsx`**

- Render the structured row variants.
- Route thinking rows to the thinking disclosure and tool rows to
  `ToolCallCard`.
- Keep user messages, assistant answer text, and summaries in their projected
  positions.
- Use stable presentation identities with the supported Solid rendering
  behavior; do not rely on projected object identity to retain expansion.
- Preserve the existing follow/scroll behavior. Disclosure toggles must not
  force the reader back to the bottom.

**5. `src/client/components/TranscriptDisclosure.tsx` — new**

- Provide the shared disclosure structure using native accessible disclosure
  controls.
- Accept the label, controlled expansion value, toggle callback, and details.
- Support touch and keyboard operation.
- Keep details hidden while closed, without an output preview.
- Reflect updates to the controlled state without creating toggle loops.

**6. `src/client/components/ThinkingBlock.tsx` — new**

- Render the exact label `Thinking ...`.
- Reveal the available thinking text when expanded.
- Update expanded content during streaming without changing expansion.
- Render textual content safely.
- Do not display thinking signatures or attempt to decode opaque provider
  continuation data.
- Add no duration, token count, or alternate completion label.

**7. `src/client/components/AssistantMessage.tsx`**

- Accept the assistant-text and summary row variants.
- Render answer text without thinking content.
- Preserve existing summary and assistant-failure notices.
- Keep `.assistant-text` associated with directly visible assistant text so
  existing browser assertions continue to identify answers.

**8. `src/client/components/ToolCallCard.tsx`**

- Replace its local expansion signal with the supplied disclosure state.
- Remove the 200-character preview and result/error label.
- Remove error-specific styling from the collapsed card.
- Format the label from the tool name and optional recorded duration.
- Reveal available arguments and result content on expansion.
- Show arguments as safely rendered structured data, not HTML.
- Retain error information contained in result details without adding a
  collapsed error badge.
- Support calls awaiting results and historical results without loaded calls.

**9. `src/styles.css`**

- Add compact styles for the shared disclosure and thinking details.
- Retain adequate touch targets and visible keyboard focus.
- Remove tool-preview and collapsed tool-error styling that no longer applies.
- Keep detail content readable and scrollable on narrow screens.
- Preserve existing styling for unrelated notices and application errors.
- Allow long tool names to wrap without changing the required label text.

**10. Tests**

- Expand `tests/unit/client.test.ts` for structured projection.
- Add focused Node tests for disclosure-state reconciliation and duration
  formatting.
- Add `tests/e2e/transcript.test.ts` for disclosure behavior.
- Add a browser-test fixture helper if needed for deterministic transcript
  snapshots, operation batches, and paged history.
- Use the existing WebSocket contract and Playwright interception for
  synthetic tool history. Do not install production tools or add Worker
  fixture endpoints solely to exercise the UI.

## Behavior

### Content order

Project assistant content in its recorded order. A message containing text,
thinking, more text, and tool calls preserves that sequence.

Thinking followed by tools and further thinking produces separate rows.
Tools are never aggregated into a count or group.

For parallel calls, row order follows the assistant's call order. Result
arrival order changes row contents, not row positions.

### Thinking disclosures

Both committed thinking and the live partial use `Thinking ...`.

A closed disclosure reveals no thinking preview. An open disclosure updates
as more text arrives. Neither an update nor completion overrides the user's
choice.

Messages containing only thinking or tools do not produce empty answer rows.

### Tool disclosures

A call can appear as soon as its name is available, before its result arrives.
Completing it updates that row.

A result without `durationMs` uses the name alone. There is no inferred
duration and no timer while the call is pending.

Argument fragments from a live call must not be presented as completed JSON.
Render the structured information actually available, and replace it with
the committed call arguments when supplied.

Repeated call identifiers in different assistant rounds must not share
results or expansion state.

An unmatched historical result remains inspectable. Loading its call later
merges the two representations without duplicate rows or lost expansion state.

### History and reconnect

Pairing occurs over all loaded raw entries, including entries spanning a
history-page boundary.

A fresh browser load starts disclosures collapsed. Existing local expansion
choices for committed rows survive an ordinary reconnect in the same mounted
conversation.

A live-to-committed transition transfers state to the corresponding message.
A retry or a different conversation must not inherit the previous live
message's expansion by accident.

Where a fresh snapshot has no locally observed live predecessor, use the
committed identity and the normal collapsed default.

### Errors and incomplete information

Tool errors do not add collapsed labels or styling. Their supplied result
details remain accessible after expansion.

Preserve existing connection, submission, and assistant-failure handling.

Absent arguments, results, or durations remain absent. Do not manufacture
values or expose additional metadata to fill the space.

## Tests

### Projection and formatting

Cover:

- Mixed assistant text/thinking content in original order.
- Thinking-only and tool-only messages without empty answer rows.
- The same content rules for committed entries and live partials.
- Multiple calls whose results arrive in reverse order.
- Call/result pairing across loaded-history boundaries.
- Reused call identifiers in separate assistant rounds.
- Pending calls and standalone historical results.
- A standalone result becoming a matched call after history loads.
- Duration formatting, including zero, fractional seconds, absent values, and
  invalid values.
- Exact `Thinking ...` and `Bash．10s` spelling, including U+FF0E and spacing.
- Preservation of summary, user-content, and assistant-failure behavior.
- Projection leaving input conversation data unchanged.

### Presentation state

Cover:

- Expanded thinking remaining expanded through content updates.
- A user's explicit collapse remaining closed through later updates.
- Expansion surviving live-to-committed replacement.
- Tool expansion surviving result arrival.
- Expansion surviving standalone-result reconciliation.
- No expansion leakage between conversations or retries.

### Browser behavior

Use deterministic session frames to exercise the real client renderer.

Verify that:

- Answers are directly visible while thinking and tool details start hidden.
- Clicking and keyboard activation expose and hide the correct details.
- Closed tool rows show neither output previews nor error badges.
- Streaming updates do not reset an open or closed disclosure.
- Committing the live message does not duplicate rows or reset expansion.
- Reverse result arrival preserves call order.
- Loading older history pairs a split call/result without duplication.
- Narrow-screen labels and detail panels remain usable.

Keep existing chat, reconnect, conversation-switching, and history coverage
passing.

The unit project remains a Node project. Use browser tests for DOM,
accessibility, and Solid component-lifetime behavior rather than introducing
a second component-test environment.

## Verification

Run implementation checks from the ADR worktree using the repository's
supported Node and browser execution environment.

1. Install locked dependencies and generate required ignored type declarations
   if the worktree does not already have them.
2. Run `npm run typecheck`.
3. Run `npm run test:unit`.
4. Run `npm run build`.
5. Run `npm run test:e2e` for the shared transcript changes and existing browser
   regressions.
6. Run `git diff --check`.
7. Inspect the diff for exact labels, client-only scope, preserved model data,
   and ADR-0005 comments.

No runtime checks have been run for this planning output. Record actual
verification results during implementation.

Worker-specific tests are not added by this plan because Worker behavior,
storage, and transport remain unchanged. Any implementation discovery that
requires server changes must be reconciled with this scope before proceeding.

## Out of scope

- Thinking seconds, frontend thinking timers, and server-side timing.
- Custom durable timing documents or snapshot timing fields.
- Model-stream interception and AgentEvent subscriptions.
- Changes to pi-durable execution, retries, recovery, storage, or transport.
- Tool grouping, aggregate counts, or live tool-duration tickers.
- Token counts, cost badges, or new status indicators.
- Redesigning compaction summaries, queues, connection errors, or submission
  handling.
- Persisting disclosure state across browser reloads or devices.
- General transcript redesign or a new Markdown-rendering system.
- Production deployment or merging the ADR branch.

## Risks

**Projection currently loses structure.** Replacing flattened entries with
multiple rows affects history, rendering, and identity together. Keep raw
entries until the combined projection and test page-boundary cases.

**Reactive updates can recreate components.** Local component signals alone
cannot guarantee expansion retention. Use controlled conversation-scoped
state and verify behavior in the actual Solid browser renderer.

**Live messages do not yet have committed entry identifiers.** Maintain an
explicit local identity and reconcile it at the observed terminal transition.
Do not treat timestamps or array positions as sufficient global keys.

**Tool results can arrive out of order or without loaded calls.** Anchor rows
to call order, scope identifiers to their originating assistant message, and
retain unmatched results until a safe association becomes available.

**Recorded durations are optional and have existing execution semantics.**
Display supplied values as recorded and omit missing values. Do not replace
them with task-lifetime estimates.

**History reconciliation can move or remove fallback rows.** Preserve
expansion when identities merge and avoid disturbing the reader's scroll
position.

**The baseline has no thinking/tool disclosure browser coverage.** Use
deterministic session fixtures to exercise the missing states without adding
production execution machinery.

## Open Questions

None blocking preparation of this Draft PLAN.

The display choices are settled: `Thinking ...`, one tool row per invocation,
the exact `．` separator, existing recorded tool durations, and no collapsed
tool previews or error indicators.

This plan selects whole-second rounding, name-only fallback for missing
duration, and initially collapsed disclosures as implementation defaults.
The request for this plan does not itself approve implementation.

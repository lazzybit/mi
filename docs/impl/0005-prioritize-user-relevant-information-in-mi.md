# Impl-0005: Prioritize user-relevant information in mi

- Created Date: 2026-10-16

## Commits

```
2087711
8a98bbd
```

`2087711` implements the projection, disclosure state, components, styles,
and tests. `8a98bbd` corrects the browser-test fixture so it returns to the
Chat screen after the shared reset helper leaves the app on Settings.

## Result

Implemented the approved plan on `adr-0005`.

`src/client/view.ts` now projects committed entries and the live partial into
discriminated rows. Assistant text, thinking, and tool calls keep their
recorded order; thinking is no longer concatenated into answer text and no
empty answer row is produced for thinking-only or tool-only messages. Tool
rows are established from assistant tool calls, results are attached by call
identifier within the same assistant round, call order is preserved when
results arrive out of order, and a result whose call is not loaded stays
visible as a standalone row. Durations are read only from the matched
result's `durationMs`, rounded to whole seconds, and joined with the tool name
by `．` (U+FF0E). A finite, non-negative zero renders `0s`; missing or invalid
values omit the separator and duration. The assistant failure notice is
preserved when no answer text exists. Projection does not mutate its input.

`src/client/DisclosureState.ts` owns conversation-scoped expansion choices and
presentation identity reconciliation. New disclosures default to collapsed,
explicit choices are retained, state is cleared when the managed conversation
changes, live rows transfer to their committed entry when the live partial
disappears, a retry receives a new identity, and a standalone result follows
its call when the call later loads.

`ConversationScreen` retains older history as raw `EntryRecord[]`, deduplicates
it against the active view before projection, and drives one observation per
view or history update. `Transcript` renders the structured rows with a keyed
`For` and routes them to `ThinkingBlock` and `ToolCallCard`, both built on a
shared controlled `TranscriptDisclosure` using native `<details>`/`<summary>`.
Closed tool rows show only the label; arguments and result content appear on
expansion, and error text remains available there without a collapsed badge.
`AssistantMessage` renders answer text without thinking content and keeps
`.assistant-text` on directly visible answers.

The PLAN Target is achieved. Verification, all executed in an x86_64 Linux
container because this host has no workerd build:

- `npm run typecheck`: passed.
- `npm run test:unit`: 34 passed (4 files), including 17 projection/formatting
  tests and 8 disclosure-state tests.
- `npm run build`: passed (client and server environments).
- `npm run test:e2e`: 54 passed across the `narrow` and `wide` projects,
  including 8 new transcript tests per project and the existing chat,
  connection, conversation, settings, and smoke regressions.
- `git diff --check`: clean.

Worker tests were not run; the plan adds none because Worker behavior,
storage, and transport are unchanged.

## Deviations

- **Live-to-committed reconciliation uses observed transitions, not task
  attribution.** The plan suggested tracking the originating generation task.
  Inspection of pi-durable 1.2.0 showed that `pi.live.generation` exposes an
  attempt but no generation task id, and that a scheduler-cleanup assistant
  entry can be appended without task attribution. The implementation instead
  identifies a live generation by its partial message timestamp, transfers
  state to the newest assistant entry that appeared after the live partial
  started, and deletes any remaining live-prefixed choices. This satisfies the
  accepted decision and the plan's requirement not to use timestamps alone for
  attribution.
- **The browser fixture sends full `view` frames rather than Chord `ops`
  batches.** The plan allowed "deterministic session frames" and "operation
  batches". Sending a complete `ConversationView` per step uses the existing
  `view` frame type and the real `SessionFeed`/client renderer while keeping
  the fixture small and deterministic.
- **Environment.** The repository's `vitest.config.ts` imports the Cloudflare
  workers pool at module load, and `workerd` has no Android build, so
  `npm run test:unit` cannot start on this host. Local unit runs used a
  temporary, uncommitted `vitest.unit.local.config.ts` that defines only the
  Node unit project. Full typecheck, unit, build, and browser verification were
  run in an x86_64 Linux container against the pushed branch. The container
  also needed `npm ci --include=dev` because its environment sets
  `NODE_ENV=production`. Neither workaround changes committed files.

## Follow-ups

- None required for the approved scope.
- `npm run test:workers` was not executed here; it is unaffected by this change
  and remains part of the repository's normal CI.

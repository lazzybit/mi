# Impl-0002: Adopt @earendil-works/pi-ai as the model call layer

- Created Date: 2026-10-15

## Commits

- `e523a33` adopt pi-ai as the model call layer (implementation)
- `6748055` cover the pi-ai adapter, durable retries, and workerd execution (tests)

The branch was rebased onto the planning commit before review, so these are
rewritten commit identities for the same verified trees. The documentation
commit that records this report is not listed.

## Result

ADR-0002 is implemented on `adr-0002` and the PLAN Target is achieved for the
authorized offline scope.

**Model boundary (ADR-0002 decision 1, 2, 8).** `@earendil-works/pi-ai@1.2.0` is
pinned and owns provider encoding, streaming, usage/cost, thinking control, stop
reasons, and error classification. `GatewayModelGateway` is the only model-path
implementation: it builds a keyless provider through `createModels`/
`createProvider` with the three required `/api/*.lazy` APIs, injects
`createAiBindingFetch`, sets `maxRetries: 0`, and disables ambient credential
discovery with an explicit `authContext`. `models/codecs/*`, the model SSE
parser, `AiBindingTransport`, and `HttpGatewayTransport` are gone.

**Transport and routing (decision 3, 6).** Production requests address
`https://workers-binding.ai/ai-gateway/gateways/{gateway}/compat/chat/completions`
with `cf-aig-authorization: Bearer cloudflare-gateway-binding` and suppressed
`Authorization`/`x-api-key`. The repository owns the mapping
`dynamic/runner -> deepseek/deepseek-flash`; the catalog entry is resolved from
`providers/deepseek.models`, its protocol is validated (`openai-completions`),
and the dispatched identity stays `model: "dynamic/runner"`. The fixture model
service is reached through the same adapter.

**Canonical contracts and persistence (decision 5).** Terminal results are pi-ai
`AssistantMessage`s, persisted as `metadata.modelMessage = { version: 1,
message }` and linked to a result artifact in the same transaction that settles
the attempt. `buildHistory`/`buildMessages` replay canonical messages; legacy
entries, bare legacy settings profiles, and legacy frozen requests are read
through explicit compatibility readers, and legacy requests convert to canonical
contexts on resume. Tool-call `name`/`alias`, Anthropic thinking content, and
Responses reasoning replay through pi-ai's message model.

**Stop reasons.** `stop`/`toolUse` persist and dispatch; a `stop` turn carrying
tool calls fails as a protocol inconsistency; `length` preserves the truncated
response, fails with `MODEL_OUTPUT_LIMIT`, and dispatches nothing; `error`
retries only when `isRetryableAssistantError` classifies it transiently;
`aborted` is never success; `pending`/`deferred` are protocol violations.

**Retries (decision 7).** Attempts form a `parentAttemptId` chain per logical
invocation; the chain length is the budget (`maxModelAttempts`). Settling a
parent, inserting the prepared child, and updating the run's active-attempt
pointer are one transaction; backoff uses `retryDelayMs` with runtime limits and
is persisted once as `retry_eligible_at`. Later slices dispatch the prepared
child from its frozen request artifact, and recovery adopts the same
bookkeeping, including adopting legacy prepared attempts and failing ambiguous
state visibly.

**Context.** The estimator covers system sections, canonical message content
(including thinking and tool calls/results), and tool definitions; the output
reserve is the effective cap, not a window fraction. Over-budget ordinary and
compaction requests are refused with `CONTEXT_OVER_BUDGET` when no safe
compaction plan exists. Compaction honors the planner's persisted source range
and preserves the uncompacted tail.

**Compatibility.** Artifact collection also recognizes `app__read_tool_result`
arguments inside canonical assistant content. A settings store migration adds
`retry_eligible_at` idempotently (schema version 3). Model setup is a route
selector with server-side validation and catalog-derived display metadata;
legacy profiles remain readable and are surfaced as a notice rather than an
editable raw-metadata form.

Verification outcomes:

- Termux (Android aarch64, Node v26.4.0): `npm run typecheck` passed;
  `npm run test:unit` passed (16 files, 122 tests); `npm run test:workers`
  passed (3 files, 16 tests), including the workerd adapter test.
  `npm run test:e2e` cannot run on this host: Playwright reports
  `Unsupported platform: android` and no browsers are installed.
- Container (x86_64 Debian, Node v24.21.0): `npm run typecheck` passed;
  `npm run test:unit` passed (122 tests); `npm run test:workers` passed
  (16 tests). `npm run test:e2e` passed (46 tests, 2.4 min) covering streaming,
  tool rounds, failure, cancellation, reload, settings persistence, recovery,
  and the narrow/wide projects, on the pre-rebase revision whose content is now
  `e523a33` plus `6748055`. The workerd adapter test was added after that run
  and re-ran in the workers suite; the browser suite was not repeated because
  the change touches no browser path.
- Production bundle: `dist/client` contains no pi-ai, openai, or typebox code.
  An esbuild bundle of the three lazy APIs plus the binding fetch and
  `createModels`/`createProvider` measures 1,639,866 bytes; adding the selected
  DeepSeek catalog measures 1,642,344 bytes, so the catalog contribution is
  about 2,478 bytes. No other provider catalogs are bundled.
- Wrangler dry-run at `6748055`: `Total Upload: 2112.80 KiB / gzip: 452.50 KiB`.
  The baseline `8c79b22` measured `600.88 KiB / gzip: 137.51 KiB`. Cloudflare
  removed the compressed size limit on 2026-09-04; the uncompressed limit is
  64 MiB, which this bundle is far below.
- Live binding smoke test: not executed. It requires a configured account and
  gateway plus explicit authorization, which this cycle did not have.

## Deviations

- `models/sse.ts` was moved to `src/worker/mcp/sse.ts` instead of being deleted:
  MCP streamable HTTP still parses SSE responses. It is an MCP transport
  concern, not a provider codec.
- `WakeScheduler.reconcile` now replaces a stale earlier alarm instead of only
  shortening it. The retained submission-time wake made persisted retry backoff
  ineffective; this was a defect found while testing backoff.
- `driveSlice` treats a run that produced no persisted change as stalled for the
  slice. Without this, a prepared retry waiting on backoff would spin inside one
  slice, which also violates the plan's "without busy-polling" requirement.
- Compaction requests are now budget-validated. A configured window too small
  for the compaction prompt fails with `CONTEXT_OVER_BUDGET` rather than
  dispatching; the plan required refusing over-budget requests, and this is a
  new explicit terminal path.
- Settings writes are route-based only. Legacy bare profiles stay readable and
  are shown as a historical notice; the raw metadata editor is no longer normal
  onboarding, per the plan.
- `RunCheckpoint` gained an `activeAttempt` pointer and a `compactionPlan`
  range, and the `compaction_required` event carries the plan. `RunMachine`
  states and its event set are otherwise unchanged.
- The frozen request artifact payload is immutable; only the `attemptId` field
  is rewritten when a prepared retry is dispatched.
- Node engine raised to `>=22.19.0` to match pi-ai's declared requirement.

## Follow-ups

- Live binding validation (streaming, stored gateway credentials, continuation)
  is unverified and requires a configured account and explicit authorization.
- `npm run test:e2e` cannot run on the Termux host; the browser suite was
  verified in the x86_64 container instead.
- Thinking signatures in pre-ADR-0002 records cannot be reconstructed; only
  their display text survives, as the ADR anticipated. Legacy native blobs are
  not used for continuation.
- The gateway's independently editable route definition can drift from the
  repository mapping and the host catalog; the mapping must be updated with
  deployment changes, and actual upstream identity or billing is not inferred
  from it.
- The route mapping is defined in source; adding or changing routes is a code
  change.
- The Anthropic API chunk includes SDK-side model name strings; no other
  provider catalogs are bundled, and further trimming was not required for the
  size limit.

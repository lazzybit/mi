# Plan-0002: Adopt @earendil-works/pi-ai as the model call layer

- Created Date: 2026-10-15
- Status: Done

## Target

Implement [ADR-0002](../adr/0002-adopt-pi-ai-as-the-model-call-layer.md) while preserving the repository's durable execution guarantees.

Completion requires:

- All three existing model protocols use pi-ai 1.2.0 through a thin `ModelGateway` adapter, without repository-owned provider codecs or SSE parsing.
- Production requests use the AI binding without provider API keys. Existing OpenAI-compatible gateway routing and local browser fixtures remain usable.
- Canonical assistant messages preserve tool calls, thinking signatures, encrypted continuation, stop reasons, and complete usage through persistence and replay.
- Historical entries, settings, snapshots, and pending model requests remain readable through explicit compatibility readers.
- Only successfully completed tool-use responses can dispatch tools. Truncation, stream failure, cancellation, and premature EOF cannot become successful turns.
- Driver-owned retries are bounded per logical model invocation, actually dispatch persisted replacements, and survive reconstruction without losing their budget or backoff.
- Context checks cover structured content and effective output reservations; requests known to exceed the configured budget do not dispatch.
- ADR-0001 deletion, generation fencing, and atomic artifact-linking guarantees continue to hold.
- The automated checks and production bundle inspection below pass.
- Normal model setup uses repository-configured routes and catalog-derived metadata, without requiring users to know provider protocols or token limits.

This work cycle prepares documentation only. Creating or revising this Draft
PLAN does not authorize implementation.

Live-account binding validation is separate from offline completion and requires configured infrastructure and explicit authorization.

## Start

The starting implementation is the baseline recorded in ADR-0002. The branch currently adds the accepted ADR without changing implementation.

The model boundary consists of three codecs, two transports, `GatewayModelGateway`, and a local SSE parser. `AttemptExecutor` reconstructs tool arguments and returns a reduced result that loses terminal semantics. Assistant metadata and history readers disagree on tool-call names and native continuation shapes.

Retries are counted across a run rather than an individual invocation. Both the driver and recovery create prepared replacements, but normal execution creates another attempt instead of dispatching those replacements. Backoff eligibility is not persisted.

Context estimation omits structured and opaque content. Preparation can dispatch an over-budget request when no compaction plan exists. Compaction execution separately rereads recent history rather than consuming the selected source range.

`ArtifactReferences.ts` understands legacy metadata and checkpoint representations. New canonical messages and request contexts require corresponding reference readers.

The repository requires Node `>=22.12.0`; pi-ai 1.2.0 requires `>=22.19.0`. Existing Worker tests run the built application with remote bindings disabled, and browser tests use `MI_FIXTURE_MODEL_URL`.

## Architecture

Keep `ModelGateway.stream(request, signal)` as the execution boundary. `GatewayModelGateway` becomes the pi-ai adapter; `createDefaultModelGateway` retains environment-specific wiring.

Use `createModels` and `createProvider` with keyless binding authentication and only the three required lazy APIs. The Models entry point normalizes a public `Context` before dispatch; raw contexts must not be passed directly to lazy `ProviderStreams`, which require `TranscriptContext`.

pi-ai owns provider encoding, stream interpretation, authoritative assistant
messages, usage, thinking controls, continuation handling, and provider error
classification. Use its exported APIs and helpers directly, including
`isRetryableAssistantError`, `retryDelayMs`, and model capability helpers
where applicable. Do not create replacement provider codecs, stream parsers,
message models, capability tables, error classifiers, or backoff algorithms.

This repository owns frozen request artifacts, durable attempts, output
commitment, tool dispatch, retry eligibility, cancellation, recovery, context
preparation, and compaction. Driver-owned durable scheduling consumes pi-ai's
classification and delay results; it is not a second provider retry engine.
Keep SDK retries disabled so each network attempt has its own durable record.
Keep the existing `RunMachine` states and events.

Runtime imports from `/utils/retry` and erased root type imports are permitted
as clarified in ADR-0002. The necessary model-path driver, recovery,
checkpoint, scheduling, and context-guard changes are within this plan's
scope. None requires a separate architectural decision.

New requests use canonical pi-ai `Context` messages. New assistant entry metadata stores a versioned canonical `AssistantMessage`. Legacy readers are compatibility boundaries, not a second write format.

## Changes

**1. Dependencies and model adapter**

Files: `package.json`, `package-lock.json`, `src/worker/models/GatewayModelGateway.ts`, `src/worker/models/index.ts`.

Pin `@earendil-works/pi-ai` to `1.2.0` and align the development Node requirement with its declared engine.

Load the catalog entries referenced by the configured routes and construct
the binding-authenticated provider for the existing APIs. Do not activate
catalog provider factories' credential discovery or add the `agents`
package solely to obtain model metadata.

Map `openai-chat-completions` to pi-ai's `openai-completions` API. Use the Responses and Anthropic lazy APIs for the other existing protocols.

Use `createAiBindingFetch` with the binding-auth sentinel. Suppress `Authorization` and `x-api-key` defaults while preserving `cf-aig-authorization`. Resolve the binding only when a production request starts.

Preserve supported `compat` and `dynamic/` routing, including the unified chat endpoint. Reject incompatible protocol/route combinations before network I/O.

Remove `models/codecs/*`, `models/sse.ts`, `AiBindingTransport.ts`, `HttpGatewayTransport.ts`, and their exports.

**2. Profiles and configuration**

Files: new `src/worker/models/ModelRoutes.ts`,
`src/shared/domain.ts`, `src/shared/commands.ts`,
`src/worker/types.ts`, `src/worker/settings/SettingsService.ts`,
`src/client/components/ModelSettingsForm.tsx`, configuration projections,
and the existing settings RPC path.

Define the application's route-to-catalog mapping in source. Initially,
`dynamic/runner` maps to provider `deepseek`, model ID `deepseek-flash`
(`deepseek/deepseek-flash`), resolved from
`@earendil-works/pi-ai/providers/deepseek.models`.
The catalog display name is `DeepSeek V4.1 Flash`; it is not the lookup ID.
Store qualified references, not copies of limits, capabilities, thinking
maps, compatibility flags, or pricing.

Resolve and validate this exact mapping server-side using pi-ai's exported
catalog data and helpers. The pinned 1.2.0 DeepSeek catalog contains this
model with API `openai-completions`. Missing references are repository
configuration errors; do not search other host catalogs for approximate
matches or ask users to enter metadata.

Keep the catalog's metadata identity separate from the dispatched route.
The initial route uses pi-ai's `openai-completions` API, the binding compat
base URL, and `model: "dynamic/runner"`. Never dispatch the catalog host's
URL or replace the route with its underlying model ID. Isolate the thin
transport overrides; do not blindly carry host-specific compatibility
settings across endpoints.

Replace required provider, model, protocol, context-window, and output-limit
inputs with selection from the configured routes. With one configured route,
select it by default and display its catalog-derived model name.
Gateway infrastructure configuration remains separate. Expose supported
thinking choices through pi-ai's capability helpers. Apply the existing
application output default, bounded by catalog limits, without requiring a
numeric value during normal setup.

Keep catalogs and SDK runtime server-side. Project only the serializable
route choices and display metadata needed by the settings interface.
The server validates the selected route; client-supplied model metadata is
not authoritative.

Freeze the selected route, qualified catalog reference, resolved model,
and effective options in snapshots and request artifacts. Retries reuse
that configuration after settings or package changes. This freezes the
local request, not the gateway's independently editable route definition.

Preserve historical profiles and frozen requests through explicit readers.
Do not force unrelated legacy profiles into the new mapping or expose the
legacy raw-metadata editor as normal onboarding.

Catalog prices are source-specific estimates, not proof of the gateway's
actual bill. Preserve their provenance and unknown-pricing semantics for
legacy/custom records. The route mapping describes the configured deployment;
it does not prove which upstream model a future routed response used.

**3. Canonical contracts and execution**

Files: `src/worker/models/types.ts`, `src/worker/runtime/AttemptExecutor.ts`, and focused model serialization helpers.

Replace bespoke history, native continuation, and usage representations with pi-ai types. Retain only the thin request/event/result envelopes needed by the existing execution boundary.

Use a versioned new request containing `attemptId`, normalized profile, and canonical `context`. Terminal events carry the authoritative `AssistantMessage`.

Continue committing text deltas through `OutputCommitter`. Remove fallback reconstruction of buffered tool arguments, invented tool IDs, and `"unknown"` names. Deltas support streaming output; they do not establish executable calls.

Forward final usage without dropping cache, reasoning, or cost fields. Reasoning tokens are a subset of output usage, not additional output tokens.

**4. History, persistence, and projections**

Files: `src/worker/context/ContextAssembler.ts`, `src/worker/runtime/RunDriver.ts`, `src/worker/storage/projections.ts`, and model serialization helpers.

Store successful assistant messages as `metadata.modelMessage = { version: 1, message }`. Derive entry text and tool display cards from that message. Keep repository tool-routing checkpoints distinct from model history.

Persist available terminal model results in result artifacts. Link results, settle attempts, append entries, and create tool cards atomically under existing execution-generation checks.

Dual-read legacy assistant metadata, accepting tool-call `name` and `alias`. Preserve readable text without inventing missing signatures or asserting that arbitrary legacy native blobs are valid continuation state.

Convert legacy persisted requests containing `system`, `history`, and `tools` into canonical contexts when resuming them. Keep historical artifacts immutable.

Project only the display metadata needed by clients; opaque continuation payloads remain server-side. Do not add a reasoning inspector or require a browser runtime import of pi-ai.

**5. Durable retry bookkeeping**

Files: `src/worker/runtime/RunDriver.ts`, `src/worker/runtime/limits.ts`, `src/worker/storage/records.ts`, `src/worker/storage/schema.ts`, and attempt repositories.

Set `maxRetries: 0` for every pi-ai invocation. Do not call `retryAssistantCall`; use only classification and delay helpers under driver-owned policy.

Count attempts along a `parentAttemptId` chain for one logical model or compaction invocation. Preserve the existing default of three total attempts, including the initial call. Successful tool rounds begin separate invocation chains.

Persist an optional active-model-attempt checkpoint pointer and nullable retry eligibility timestamp. Add an idempotent migration for existing stores; do not reset historical attempt identities or the ADR baseline.

Create a retry child atomically with settlement of its parent and update of the active pointer. Reuse the frozen request artifact, changing only the local executing attempt identity. Later settings changes must not mutate a scheduled retry's input.

Use `retryDelayMs` with explicit runtime limits, initially a one-second base and sixty-second cap. Persist the computed eligibility once; reconstruction must not recompute it.

Dispatch the prepared active replacement when eligible instead of creating another root attempt. Clear invocation bookkeeping on completion or terminal failure.

**6. Recovery and wake scheduling**

Files: `src/worker/runtime/RecoveryService.ts`, `src/worker/runtime/RunDriver.ts`, `src/worker/runtime/WakeScheduler.ts`, and necessary owner initialization wiring.

Reconcile prepared and dispatched model attempts using the same invocation-chain budget. Prepared retries retain their eligibility; interrupted dispatched attempts consume the existing chain budget.

Claim current execution generations before dispatch. Preserve ADR-0001 fencing against stale continuations.

Reconcile legacy pending bookkeeping against its stored request and current phase. Ambiguous historical state must fail visibly rather than dispatch duplicate roots or reset retry limits.

Make selection and alarm reconciliation honor retry eligibility without busy-polling. Preserve existing run ordering. Cancellation takes priority over scheduled backoff and prevents replacement dispatch.

Ensure persisted pending work retains an appropriate wake across interruption and reconstruction. Leave unrelated tool replay and unknown-remote-outcome semantics unchanged.

**7. Context budgeting and compaction**

Files: `src/worker/context/ContextBudget.ts`, `src/worker/context/ContextAssembler.ts`, and the driver's compaction preparation path.

Assess canonical system instructions, messages, thinking content, tool arguments/results, opaque continuation state, and tool definitions with a documented conservative estimator. Do not describe it as exact provider tokenization.

Reserve the effective output cap, including provider-specific thinking allocation where applicable. Do not retain the current quarter-window cap when the actual request can generate more.

Validate both ordinary and compaction requests before dispatch. Over-budget input without a safe compaction path becomes an explicit terminal failure, not a ready snapshot.

Honor the planner's selected source range and preserve its provenance. Assemble a resulting summary together with the uncompacted tail rather than losing recent entries because the summary was appended later.

Do not split unresolved tool rounds or repeatedly compact without progress. Preserve original transcript entries and ADR-0001's removal of unused compaction-plan artifacts.

**8. Artifact references and compatibility**

Files: `src/worker/storage/ArtifactReferences.ts` and relevant deletion tests.

Recognize application-defined `app__read_tool_result` arguments in canonical assistant content and frozen request contexts, while retaining supported legacy, checkpoint, and uncertainty readers.

Read only established representations associated with surviving records. Do not scan arbitrary provider fields for artifact-like strings or expand ownership inference.

Preserve shared request artifacts reused by retry children and retain atomic request/result ownership links.

**9. Fixtures and decision references**

Files: `tests/helpers/fakeTransport.ts`, `tests/helpers/runtime.ts`, `tests/e2e/start-dev.mjs`, model fixture wiring, and affected tests.

Replace codec/transport fixtures with injected fetch fixtures that exercise the actual pi-ai adapter. Preserve the browser fixture URL through the same adapter without retaining a production transport abstraction.

Update fake model results to provide canonical terminal messages. Keep binding resolution lazy so ordinary Worker construction tests remain credential-free.

Add concise English ADR-0002 comments near changed responsibilities. Preserve applicable ADR-0001 references.

## Behavior

- `stop`: persist a successful assistant response. Unexpected embedded tool calls are a protocol inconsistency, not permission to execute them.
- `toolUse`: dispatch only authoritative, valid final tool calls, after existing tool validation. Never dispatch a partially streamed call.
- `length`: preserve the truncated response, report an explicit output-limit failure, and dispatch no tools. Do not retry the same request automatically.
- `error`: preserve available partial text and canonical failure evidence. Retry only when pi-ai classifies the failure as transient and the invocation budget permits it.
- `aborted`: local cancellation terminates the run; a local deadline follows bounded interruption recovery. An unexplained provider abort is not success.
- Missing terminal events, `pending` terminal state, or unsolicited `deferred` results fail explicitly. Deferred execution is not requested or supported.
- Deterministic configuration, validation, and context-limit failures do not enter a transient retry loop.

Committed partial text remains readable and separate from replacement output. Failed or incomplete calls cannot become executable history. A retry replays its frozen pre-attempt context, not its own partial answer.

## Tests

Extend the existing suites with focused adapter and persistence coverage:

- All three protocol request/stream fixtures, exact endpoint paths, output/thinking controls, compatibility overrides, and one fetch per dispatched attempt.
- JSON persistence and continuation replay for tool calls, Anthropic signatures/redaction, and Responses encrypted reasoning.
- Terminal outcomes, premature EOF, partial failures, invalid calls, cancellation, and prevention of tool execution after truncation or error.
- Complete usage preservation and unknown-pricing semantics.
- Retry-chain budgets across multiple successful tool rounds, actual replacement dispatch, frozen requests, persisted backoff, reconstruction, cancellation during backoff, and exhaustion.
- Populated-store migration, legacy profiles/entries/requests, canonical history round trips, and ambiguous legacy pending state.
- Structured context budgeting, no-plan refusal, compaction-request validation, safe source ranges, uncompacted-tail preservation, and bounded progress.
- ADR-0001 artifact-reference, atomic-linking, deletion, stale-generation, and late-output regressions.
- Built Worker adapter execution with fixture fetches, plus browser settings persistence, streaming, tool rounds, failure, cancellation, and reload behavior.
- Default `dynamic/runner` selection, qualified catalog lookup, supported thinking choices, server-side selection validation, and exact binding routing with `model: "dynamic/runner"`. Cover missing mappings, missing catalog entries, incompatible metadata sources, frozen configuration, and legacy-profile compatibility.

## Verification

During this documentation stage:

1. Confirm the ADR remains Accepted and this PLAN remains Draft.
2. Review the complete diff and confirm no implementation, baseline, lock, or unrelated TODO changes.
3. Run `git diff --check`.
4. Read feedback on the existing draft PR and update that same PR with planning scope and unresolved approval questions.

After implementation is authorized:

1. Install dependencies using Node `>=22.19.0` and `npm ci`.
2. Run `npm run typecheck`.
3. Run `npm run test:unit`.
4. Run `npm run test:workers`, which includes the application build.
5. Run `npm run test:e2e`.
6. Inspect production imports and emitted chunks. Confirm no root runtime
   import, unintended credential flows, or pi-ai browser runtime dependency.
   Measure the actual contribution of the selected catalog imports.
7. Run a Wrangler deployment dry-run against the build-emitted Worker configuration. Record upload size and compare it with current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

Record actual results in the eventual IMPL; planned commands are not evidence of passing checks.

A live binding smoke test must separately verify streaming, stored gateway credentials, and continuation on a configured account. It requires authorization and must not be substituted with an HTTPS request carrying provider keys.

## Out of scope

- Implementation, deployment, merge, claim release, or creation of an IMPL during this planning cycle.
- Replacing the durable runtime with pi-agent-core, pi-durable, or Cloudflare Agents.
- Additional model protocols, provider authentication, fallback policies, or deferred responses.
- Gateway route creation, remote route discovery, and Cloudflare management API credentials. Route definitions remain deployment-managed.
- Artifact ownership redesign, global cleanup, historical ownership backfill, or unrelated TODO work.
- General tool recovery redesign, multimodal support, usage dashboards, or reasoning-display features.

## Risks

- **Duplicated library responsibilities:** keep provider semantics in pi-ai.
  Limit local code to transport wiring, legacy-data compatibility, projections,
  and durable application responsibilities. Prefer exported library helpers
  over equivalent local implementations.
- **Runtime and bundle compatibility:** fixture probes do not establish the production build or real binding route. Require built Worker coverage and bundle inspection; report live validation separately.
- **Historical continuation:** missing signatures cannot be recovered. Preserve readable history and explicitly limit legacy continuation guarantees.
- **Retry races:** duplicate dispatch, lost wakes, or reset budgets can cause extra requests. Persist identity, eligibility, and settlement atomically and test reconstruction boundaries.
- **Budget estimation:** configured limits and conservative estimates cannot eliminate provider-side overflow. Fail explicitly and avoid identical-request retry loops.
- **Reference regressions:** canonical metadata changes can undermine deletion safety. Maintain explicit readers and tests for both old and new representations.
- **Route/catalog drift:** the gateway route can change independently of the code mapping, and host catalogs can differ for the same named model. Validate qualified references, preserve metadata provenance, update the mapping with deployment changes, and record actual response model metadata where available. Do not infer actual upstream identity or billing from the mapping alone.

## Open Questions

None.

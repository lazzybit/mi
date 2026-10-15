# ADR-0002: Adopt @earendil-works/pi-ai as the model call layer

- Created Date: 2026-10-15
- Status: Accepted
- Baseline: 8c79b220fcd15772c0394d95f8ee358faa87a9e2

## Status Quo

The model boundary is implemented in this repository. `src/worker/models/`
contains three provider codecs (`OpenAIChatCodec`, `OpenAIResponsesCodec`,
`AnthropicMessagesCodec`), `GatewayModelGateway`, `AiBindingTransport`,
`HttpGatewayTransport`, and an SSE parser. `AttemptExecutor` converts codec
events into `ModelAttemptResult`; `RunDriver` owns durable attempts and
`RunMachine` owns pure transitions.

At this baseline the model boundary carries these concrete conditions.

- Reasoning is decoded but never requested. `AnthropicMessagesCodec.encode`
  sends no `thinking` parameter, neither OpenAI codec sends
  `reasoning`/`reasoning_effort`, and `OpenAIResponsesCodec.encode` sends no
  `include: ["reasoning.encrypted_content"]`, so the encrypted continuation it
  decodes is never produced by the provider.
- Output limits are not sent. `OpenAIChatCodec.ts:22` and
  `OpenAIResponsesCodec.ts:18` omit any output token limit, and
  `ModelProfile` (`src/worker/types.ts:8`) has no field for thinking control.
- Two message shapes disagree across layers. `RunDriver.ts:346` stores
  `result.toolCalls` (`PersistedModelToolCall`, key `name`) in entry metadata,
  while `ContextAssembler.ts:199` reads it as `PersistedToolCall` (key
  `alias`), so the next turn sends `undefined` tool names.
  `OpenAIResponsesCodec.ts:131` writes `native: { items }` but
  `toResponsesInput` (`:149`) accepts only `Array.isArray(item.native)`, so
  provider-native items never replay.
- Stream termination is not verified. All three codecs emit `completed`
  unconditionally after iteration ends (`OpenAIChatCodec.ts:111`,
  `OpenAIResponsesCodec.ts:124`, `AnthropicMessagesCodec.ts:141`). The Chat
  codec ignores `finish_reason`, the Responses codec ignores
  `response.incomplete`, and `stopReason` never reaches `ModelAttemptResult`
  (`models/types.ts:88`).
- Provider errors are unclassified. `GatewayModelGateway.ts:28` wraps every
  non-2xx response in a plain `Error`; `RunDriver.settleModelFailure` turns
  that into `definite_failure`; `AppError.retryable`
  (`src/shared/domain.ts:96`) is never consulted on the model path.
- Retry accounting is per run, not per interruption. `RunDriver.ts:431`
  counts attempts with `countForRunKind` across the whole run, and the
  replacement attempt created at `:462-477` is never dispatched by a later
  slice.
- Context budgeting undercounts. `ContextBudget.ts:16` estimates
  `length / 4`, ignores provider-native and structured payloads, and
  `ContextAssembler.ts:65-75` still creates a snapshot and dispatches when the
  request is over budget and no compaction plan exists.
- Usage is only written into entry metadata, and `normalizeUsage`
  (`codecs/shared.ts`) reads no cache or reasoning token breakdown.

These are observable failures, not theoretical ones: a second tool round sends
`undefined` tool names, Responses continuation never replays native items, and
a premature EOF is reported as a successful turn.

## Needs

- Do not reimplement provider wire encoding and decoding: thinking/reasoning
  control, streamed tool arguments, stop reasons, usage and cost, provider
  native continuation (signatures and encrypted reasoning), and prompt cache
  behavior.
- Preserve this repository's durable guarantees: attempt records, generation
  checks, request and result artifacts, committed partial output, cancellation,
  and recovery after an object generation restart.
- Run on Cloudflare Workers through the AI Gateway binding without provider API
  keys.
- Keep existing history readable and avoid maintaining a second message format.
- Keep exactly one owner of retry decisions.
- Avoid a second unnecessary abstraction layer or a larger dependency surface
  than the boundary needs.

## Decision

Adopt `@earendil-works/pi-ai` (1.2.0) as the model call layer, keeping the
durable execution engine in this repository.

1. Provider wire encoding, streaming events, message model, usage and cost,
   thinking control, stop reasons, and error classification come from pi-ai.
2. This repository keeps a thin adapter that implements the existing
   `ModelGateway` interface, mapping pi-ai stream events onto `ModelEvent` and
   `AttemptExecutor`. `RunMachine` and the repository's durable ownership
   model remain unchanged. Model-path changes to `RunDriver`, recovery,
   checkpoints, and wake scheduling integrate pi-ai outcomes and correct the
   identified retry defects; they do not reimplement provider semantics.
3. Transport uses `createAiBindingFetch` and
   `CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL` from
   `api/cloudflare-ai-binding`, addressing
   `https://workers-binding.ai/ai-gateway/gateways/{gateway}/{provider}/...`,
   so requests stay pre-authenticated by the binding and carry no provider key.
4. Reuse pi-ai catalogs for model metadata referenced by repository-configured
   routes. Prefer the required provider-scoped `/providers/*.models` imports;
   use `/providers/all` when necessary and assess the emitted bundle.
   Runtime imports also use `/models`, the three required `/api/*.lazy`
   modules, `/api/cloudflare-ai-binding`, and `/utils/retry`.
   Core types may use erased root `import type` declarations.
   Do not import the root runtime entrypoint or activate provider credential
   discovery merely to obtain catalog metadata.
5. The canonical persisted assistant message becomes pi-ai's `AssistantMessage`
   with its `ThinkingContent` and `ToolCall` content blocks. Entry metadata
   stores that message and `buildHistory` projects it back into a `Context`.
6. The repository owns a route-to-catalog mapping. Its initial deployment
   mapping is `dynamic/runner -> deepseek/deepseek-flash`.
   Resolve provider `deepseek` and model ID `deepseek-flash` from pi-ai's
   scoped DeepSeek catalog. Do not ask users to supply provider identifiers,
   model IDs, protocols, context windows, or compatibility metadata.

   Catalog identity and inference identity are distinct. Requests retain
   `model: "dynamic/runner"` and use the binding's OpenAI-compatible chat
   endpoint. Dynamic routes always use the OpenAI chat-completions request
   shape; the metadata source must not redirect requests to its hosting
   provider or change that protocol.

   Normal configuration selects an application-configured route, with the
   initial route selected by default. Supported thinking choices come from
   pi-ai helpers. Application output policy supplies a default bounded by
   the resolved model's limits. Freeze the route, resolved model metadata,
   and effective options in each execution request.
7. Retry stays owned by `RunDriver`. pi-ai and its SDKs run with `maxRetries: 0`;
   the driver decides retries from `stopReason` and pi-ai's classification
   helpers (`isRetryableAssistantError`, `retryDelayMs`) and records them as
   durable attempts.
8. `models/codecs/*`, `models/sse.ts`, `models/HttpGatewayTransport.ts`, and
   `models/AiBindingTransport.ts` are removed, and `GatewayModelGateway`
   shrinks to the adapter.

## Reason

Measured evidence for pi-ai 1.2.0 (local probes on 2026-10-15, fixture-backed
`fetch`, no network):

- OpenAI chat: the request carried `max_completion_tokens` and
  `reasoning_effort`, the turn ended with `stopReason: "toolUse"`, and usage
  included cost and reasoning token breakdown.
- JSON round-trip of a `Context`: tool call `name` survived and the tool result
  matched its call.
- Premature EOF: the turn ended with `stopReason: "error"`
  (`Stream ended without finish_reason`) instead of a successful completion.
- Anthropic: the request carried `thinking: {type:"enabled", budget_tokens}`;
  the response preserved `thinkingSignature` and the redacted thinking payload;
  the next request replayed `redacted_thinking` with its `data` and a
  `cache_control: {type:"ephemeral"}` marker was added automatically.
- OpenAI Responses: the request carried
  `include: ["reasoning.encrypted_content"]`; the continuation `input` contained
  the reasoning item with its `encrypted_content`.
- Binding headers: `Authorization` and `x-api-key` were removed while
  `cf-aig-authorization` was preserved.
- workerd: pi-ai, including its `openai` SDK dependency, loaded and completed a
  fixture stream inside workerd through this repository's existing
  `vitest-pool-workers` path.
- Bundle: a single esbuild bundle of the three lazy APIs plus the binding fetch
  measured 1.65–1.69 MB uncompressed.

Alternatives considered:

- Continue maintaining the hand-written codecs. The baseline shows this
  approach already produced cross-layer shape mismatches and lost semantics,
  and every new provider repeats the same responsibilities.
- Copy pi-ai's design without the dependency. That is the same work again and
  contradicts the requirement.
- Use another SDK. None of the candidates examined provides an equivalent
  binding-authenticated transport plus provider-native continuation with
  comparable evidence, so switching would trade a measured option for an
  unmeasured one.

Known risks and boundaries:

- The real `env.AI.fetch()` passthrough and AI Gateway behavior were not
  verified at this baseline; that requires a configured account and gateway.
- Production bundle size and vite code-splitting were not verified in a
  production build.
- Existing history uses the hand-written format and needs migration or dual
  reading. Thinking signatures in old records cannot be reconstructed, so only
  their display text survives.
- pi-ai sends `developer` role system messages by default for
  OpenAI-compatible providers, which requires a `compat` override where the
  provider does not accept it.
- pi-ai is not a replacement for the durable runtime. Attempts, generation
  checks, cancellation, recovery, compaction, and tool execution remain this
  repository's responsibility.

The artifact lifecycle work recorded in `docs/TODO.md` is unrelated to this
decision and stays out of scope.

Planning refinement: the deployment uses a configured dynamic route, not a
user-entered concrete provider model. The user specified
`dynamic/runner -> deepseek/deepseek-flash`. A repository-owned mapping plus
pi-ai catalog lookup replaces the initial blanket catalog exclusion and
avoids requiring users to supply model metadata. Existing bundle probes
did not measure these catalog imports; their actual contribution remains
part of implementation verification.

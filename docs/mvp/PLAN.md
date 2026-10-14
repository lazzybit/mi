# Plan: Build a mobile-first durable web harness

- Created Date: 2026-10-14
- Status: Approved
- Implementation tracking: [TASK.md](./TASK.md)

## Target

Deliver a web harness hosted on Cloudflare Workers that lets the owner perform coding and research work from a phone or desktop, leave the application while work continues, and reopen the same conversation with its previous state restored.

Completion requires:

1. A responsive interface for conversations, streamed assistant responses, tool activity, follow-ups, steering, and cancellation.
2. Server-side persistence of accepted input, conversation history, active work, tool-call state, and the information required to restore the interface.
3. Reconnection after screen lock, network loss, or device switching without duplicate submissions and without waiting for another model response.
4. Model requests through AI Gateway using the AI binding, for the model the owner configures, without requiring Workers AI models.
5. Remote tools from configured MCP servers, including the existing web-access and container-context helpers, each authenticated by the mechanism that server supports.
6. Instructions, skills, repository operations, and verification capabilities for the owner’s development workflow.
7. Defined handling of exceptional interruption and of remote operations whose outcome cannot be determined.
8. Verification of the normal reconnect path and the exceptional recovery boundaries that runs without real deployment credentials.

## Start

No harness implementation exists. The repository contains this plan only.

Two MCP helpers are already deployed and reachable over Streamable HTTP:

| Helper | Contract relevant to this MVP |
| --- | --- |
| Web access | `search_topic` returns structured results with an explicit completion, interruption, or failure status and may return partial results. `fetch_page` returns extracted readable content in full; truncation is the caller’s responsibility. |
| Container context | `read`, `write`, `edit`, and `bash` operate on one configured workspace inside a Linux container. `read` and `bash` output are truncated to a bounded head/tail. |

Both helpers sit behind Cloudflare Access and verify their own Access assertion (issuer, audience, signature, subject, expiry) before any tool runs.

Relevant container contracts that shape recovery:

- A container MCP session is bound to a verified identity of the form `issuer|subject`.
- Every session in the same container shares its filesystem.
- A dropped HTTP/SSE connection does not by itself terminate running container work.
- Closing a session or explicit cancellation can terminate the session-owned process groups.
- The container tools expose no durable operation-status or idempotency API.
- `bash` returns its accumulated output when the command finishes; it does not stream live stdout to the caller.

There is no Git repository yet, no deployed harness, and no configured gateway, domain, Access application, or connector.

## Architecture

### Deployment shape

One Vite build produces a Solid 2 client and a server handler, deployed as one Cloudflare Worker.

- **Vite + `@solidjs/vite-plugin`** in start mode with server functions: `solid({ start: true, serverFunctions: true })`.
- **`@cloudflare/vite-plugin`** mapped to the server environment, listed before `solid()`: `cloudflare({ viteEnvironment: { name: "ssr" } })`.
- **`wrangler.jsonc`** points the Worker at the Solid server handler, serves `./dist/client` as static assets through the `ASSETS` binding, declares the SQLite Durable Object binding and migration, and declares the `AI` binding.
- **Server functions** are typed RPC dispatched by Solid at `/_server`. They run in the Worker, resolve the owner from the request, and delegate to the owner’s Durable Object.
- **`getRequestEvent()`** supplies request-local context: `locals` carries the verified owner, and the native request event exposes the Worker `env` bindings.
- **One SQLite-backed `OwnerObject` per verified owner** owns all durable state and execution.
- **Outbound MCP clients** connect to configured MCP servers.

The application does not require SSR. The generated client renders the shell; the server build is still required because server functions need the `/_server` endpoint.

**Worker entry constraint.** The Worker must expose the Solid request handler and also export the `OwnerObject` Durable Object class. The Solid 2 deployment documentation specifies the virtual Solid handler as the Worker `main` and does not state how a named Durable Object export coexists with it. Resolving this is the first implementation task, before any feature work, using the first approach the toolchain supports:

1. An authored Solid server entry that exports `OwnerObject` and delegates rendering to the Solid `render`.
2. A thin Worker entry that imports the Solid `handleRequest` and exports `OwnerObject`.
3. If neither can be combined, serve `dist/client` as assets and use a hand-written Worker entry that dispatches `/_server` to the Solid handler and all other application traffic to the Durable Object. This is always possible because the Solid handler is a plain `handleRequest(Request)` function.

The selected approach is recorded in the implementation. No feature depends on the other approaches.

The MVP does not need D1, a queue, a second coordination object, or a separate scheduler. There is one owner and one authoritative transactional boundary; the conversation catalog, credentials, skills, submissions, and execution state live together in the Durable Object’s SQLite database.

### One authoritative state owner

Use a single owner-scoped Durable Object containing multiple conversations.

- Derive the object name from the verified `issuer|subject`. A client never selects another owner’s object.
- The object owns: the conversation catalog, application settings, delegated credentials, the MCP connector catalog and tool catalog, the skill registry, submissions, runs, attempts, entries, artifacts, and revisions.
- Allow **one active run per owner** initially, because the configured container workspace is shared. Other conversations stay readable and accept queued input. This is a deliberate scheduling limitation; it is not filesystem isolation and the plan does not claim any.
- Multiple container environments, per-conversation isolation, and distributed execution scheduling are deferred.

### Transport split

Three interfaces are kept distinct:

1. **Public commands and reads** — typed Solid server functions, authenticated HTTP.
2. **Continuous observation** — one same-origin, hibernatable WebSocket per client, routed to the Durable Object.
3. **Execution** — an alarm-backed server-side driver, independent of any browser connection.

| Interaction | Transport | Owner |
| --- | --- | --- |
| Submit, steer, cancel, configure connectors, manage skills | Solid server functions | Thin Worker functions delegate to `OwnerObject` |
| Read history, settings, bounded artifacts | Solid server functions | Durable Object repositories and projections |
| Observe committed conversation state | Same-origin hibernatable WebSocket at `/ws` | `OwnerObject` accepts the socket through the Hibernation API |
| Model streaming and remote tool execution | Server-side adapters | Alarm-backed runtime |

Commands and reads use typed RPC because they are request/response. Continuous observation uses a WebSocket because the Durable Object owns it and can hibernate between events; an indefinitely streaming server function relaying a Durable Object stream would hold that object active for the life of the stream. There is exactly one continuous-observation transport.

Solid’s streamed server functions (async generators) and `live()` remain available for one-shot or value-shaped streams, and the current-value-first reconnect contract of `live()` informs the wire design. They are not used as the observation transport in the MVP.

### Components

These are modules inside one deployment, not separately deployed services.

| Component / path | Responsibility and boundary | Reason |
| --- | --- | --- |
| `src/rpc/` | Public server functions grouped by area (`conversations`, `runs`, `settings`, `connectors`, `skills`, `artifacts`). | One typed RPC surface, no parallel REST client. |
| `src/worker/rpc/` | `RpcContext`, command schemas, runtime validation, owner resolution, delegation to the Durable Object. | Authorization and validation live inside the implementation boundary. |
| `src/worker/index.ts` | Worker entry: expose the Solid handler, export `OwnerObject`, route `/ws` and the OAuth callback. | Public ingress stays separate from execution. |
| `src/worker/auth/` | Verify issuer, audience, signature, subject, expiry; produce `OwnerIdentity` and a private delegated-credential update. | Client-provided owner IDs never select another owner’s state. |
| `src/worker/owner/OwnerObject.ts` | Initialize storage; dispatch HTTP, WebSocket, and alarm events; reconstruct transient services. | One lifecycle boundary owns all persistent state. |
| `src/worker/storage/` | Schema, migrations, repositories, transactions, revision allocation, chunked artifacts. | Business modules do not invent persistence semantics. |
| `src/worker/conversations/` | Conversation commands, history, submissions, steering, cancellation, resumption. | Product commands are independent of transport. |
| `src/worker/runtime/` | Select runnable work, execute model and tool steps, checkpoint results, recover interrupted attempts. | External I/O is coordinated through explicit persisted states. |
| `src/worker/models/` | AI Gateway binding transport and provider codecs. | Model transport is independent of conversations and tools. |
| `src/worker/mcp/` | Connector discovery, authentication, sessions, tool catalog, execution, cancellation. | One connector mechanism serves all MCP servers. |
| `src/worker/skills/` | Skill registry, versions, resources, per-conversation selection, skill tools. | Skills are configurable application data. |
| `src/worker/context/` | Context snapshots, budgeting, compaction, repository instructions. | Model context is a projection of stored history. |
| `src/worker/sync/` | Snapshots, view projection, revisioned frames, hibernatable subscriptions. | Reconnection restores the view independently of execution recovery. |
| `src/client/` | Solid application: conversations, composer, transcript, tool details, connection status, settings, skills. | Covers the requested workflow and configuration surfaces. |
| `src/shared/` | Versioned domain, command, and wire types shared by client and server. | Persistence internals and credentials never leak into client contracts. |

### Shared contracts

Define these in `src/shared/domain.ts`, `commands.ts`, and `wire.ts`.

```ts
type ConversationId = string;
type SubmissionId = string;
type RunId = string;
type AttemptId = string;
type ConnectorId = string;
type SkillId = string;
type ArtifactId = string;
type CommandId = string;

interface OwnerIdentity {
  issuer: string;
  subject: string;
}

interface CommandEnvelope<T> {
  commandId: CommandId;
  payload: T;
}

interface CommandReceipt<T> {
  commandId: CommandId;
  revision: number;
  result: T;
}

type RunState =
  | "queued"
  | "running"
  | "waiting_for_auth"
  | "needs_attention"
  | "completed"
  | "cancelled"
  | "failed";

type AttemptState =
  | "prepared"
  | "dispatched"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "unknown";

type SubmissionMode = "queue" | "steer";
type ReplayPolicy = "safe" | "unsafe";

interface SubmitInput {
  conversationId: ConversationId;
  text: string;
  mode: SubmissionMode;
}

interface SubmitResult {
  submissionId: SubmissionId;
  runId: RunId;
  state: "queued" | "joined";
}

interface ResolveAttemptInput {
  attemptId: AttemptId;
  action: "accept_observed_state" | "abandon" | "retry";
  explanation: string;
  evidenceArtifactIds: ArtifactId[];
}

interface ApiError {
  code:
    | "INVALID_INPUT"
    | "UNAUTHENTICATED"
    | "NOT_FOUND"
    | "CONFLICT"
    | "NOT_CONFIGURED"
    | "AUTH_REQUIRED"
    | "CONNECTOR_UNAVAILABLE"
    | "REMOTE_OUTCOME_UNKNOWN";
  message: string;
  retryable: boolean;
}
```

A repeated `commandId` with the same normalized payload returns the original receipt. Reusing it for a different command or payload returns `409 CONFLICT`. The receipt acknowledges durable acceptance, not completion of execution.

Display types are separate from persistence records:

```ts
interface ConversationSnapshot {
  conversation: ConversationView;
  entries: TranscriptEntryView[];
  olderEntriesCursor?: string;
  activeRun?: RunView;
  activeAttempt?: AttemptView;
  queuedInputs: SubmissionView[];
}

interface OwnerSnapshot {
  revision: number;
  conversations: ConversationSummaryView[];
  configuration: ConfigurationStatusView;
  selectedConversation?: ConversationSnapshot;
}

type ViewChange =
  | { kind: "conversation.upsert"; value: ConversationSummaryView }
  | { kind: "entry.append"; conversationId: string; value: TranscriptEntryView }
  | { kind: "attempt.update"; conversationId: string; value: AttemptView }
  | { kind: "run.update"; conversationId: string; value: RunView }
  | { kind: "inbox.replace"; conversationId: string; values: SubmissionView[] }
  | { kind: "configuration.update"; value: ConfigurationStatusView };

type ServerFrame =
  | { type: "snapshot"; streamId: string; sequence: 0; value: OwnerSnapshot }
  | {
      type: "changes";
      streamId: string;
      sequence: number;
      revision: number;
      changes: ViewChange[];
    };

type ClientFrame =
  | { type: "subscribe"; conversationId?: ConversationId }
  | { type: "resnapshot" };
```

### Server-function layer

Public server functions are module-level functions with `"use server"`; the compiler does not extract class methods.

```text
src/rpc/
  conversations.ts
  runs.ts
  settings.ts
  connectors.ts
  skills.ts
  artifacts.ts
src/worker/rpc/
  RpcContext.ts
  CommandSchemas.ts
```

Representative contracts:

```ts
export async function submitInput(
  command: CommandEnvelope<SubmitInput>
): Promise<CommandReceipt<SubmitResult>>;

export async function cancelRun(
  command: CommandEnvelope<{ runId: RunId }>
): Promise<CommandReceipt<void>>;

export async function getHistory(input: HistoryQuery): Promise<HistoryPage>;

export async function saveConnector(
  command: CommandEnvelope<SaveConnectorInput>
): Promise<CommandReceipt<ConnectorView>>;

export async function saveSkill(
  command: CommandEnvelope<SaveSkillInput>
): Promise<CommandReceipt<SkillView>>;

export async function readArtifact(input: ArtifactReadQuery): Promise<ArtifactPage>;
```

Each implementation:

1. Obtains the request context.
2. Requires a verified, unexpired owner.
3. Validates caller-controlled arguments at runtime.
4. Resolves the owner’s Durable Object from server-derived identity.
5. Delegates to the corresponding domain service.
6. Returns only a serializable public DTO.

```ts
interface RpcContext {
  owner: OwnerIdentity;
  ownerStub: OwnerRpc;
  requestSignal: AbortSignal;
}

interface OwnerRpc {
  submit(
    command: CommandEnvelope<SubmitInput>
  ): Promise<CommandReceipt<SubmitResult>>;
  cancel(
    command: CommandEnvelope<{ runId: RunId }>
  ): Promise<CommandReceipt<void>>;
  history(query: HistoryQuery): Promise<HistoryPage>;
  // Explicit methods for the remaining domain services.
}
```

`RpcContext` is private server code. Bindings, credentials, and Durable Object stubs never cross the Solid serialization boundary. Request-local context is captured before asynchronous work begins; the current owner is never stored in mutable module-global state. Typed RPC does not replace runtime validation or authorization: middleware supplies verified locals, and each implementation also enforces its required context because server functions can be invoked through several paths.

A submission function waits only for durable acceptance and returns its receipt. It does not stream the agent run. Once accepted, losing the RPC response or cancelling the browser fetch does not cancel the run; retrying the same command returns the original receipt.

### Persistence and scheduling

```ts
interface Commit<T> {
  value: T;
  revision: number;
  changes: ViewChange[];
}

interface StoreTransaction {
  commands: CommandRepository;
  conversations: ConversationRepository;
  runs: RunRepository;
  attempts: AttemptRepository;
  configuration: ConfigurationRepository;
  connectors: ConnectorRepository;
  credentials: CredentialRepository;
  skills: SkillRepository;
}

class SqlStore {
  migrate(): void;
  transaction<T>(operation: (tx: StoreTransaction) => T): Commit<T>;
  readSnapshot(conversationId?: ConversationId): OwnerSnapshot;
}

class TransitionCoordinator {
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
}

class WakeScheduler {
  ensureWakeBy(timestamp: number): Promise<void>;
  reconcile(nextRunnableAt: number | null): Promise<void>;
}
```

`SqlStore.transaction` uses synchronous SQLite transactions; its callback must not return a promise. All operations that combine queue changes and alarm scheduling pass through `TransitionCoordinator`, whose critical sections contain only local storage operations and alarm updates, never network calls.

Setting an alarm before inserting work is insufficient if an alarm handler can observe an empty queue between those operations. The acceptance sequence is therefore:

1. Enter the transition coordinator.
2. Check the command receipt table.
3. Ensure an alarm is scheduled.
4. Commit submission, run/inbox linkage, and receipt.
5. Leave the coordinator.
6. Publish the committed change and return the receipt.

The alarm handler also enters the coordinator before selecting work or removing or replacing a wake, so it cannot consume the only wake between steps 3 and 4. If the process dies after scheduling but before committing, an empty alarm is harmless; if it dies after committing, both the work and its wake exist.

Stored records:

| Table | Required fields and constraints |
| --- | --- |
| `owner_state` | Singleton: `revision`, `schema_version`, `driver_generation`. |
| `command_receipts` | `command_id PRIMARY KEY`, `kind`, `payload_hash`, `result_json`, `revision`, `created_at`. |
| `settings` | Singleton current settings and settings version. |
| `conversations` | `id PRIMARY KEY`, `title`, `created_at`, `updated_at`, selected profile and workspace configuration. |
| `submissions` | `id PRIMARY KEY`, `conversation_id`, `command_id UNIQUE`, `mode`, `owner_sequence`, `content`, `state`, `run_id`. |
| `runs` | `id PRIMARY KEY`, `conversation_id`, `state`, `phase`, `checkpoint_json`, `generation`, `cancel_requested_at`, timestamps. |
| `attempts` | `id PRIMARY KEY`, `run_id`, `kind`, `state`, `generation`, `request_artifact_id`, `result_artifact_id`, `replay_policy`, connector/catalog versions, timestamps. |
| `entries` | `id PRIMARY KEY`, `conversation_id`, `sequence`, `kind`, `attempt_id`, content/reference fields; unique `(conversation_id, sequence)`. |
| `live_output` | `attempt_id PRIMARY KEY`, committed partial content and output revision. |
| `artifacts` | `id PRIMARY KEY`, MIME type, encoding, byte count, digest, completion flag. |
| `artifact_chunks` | `(artifact_id, ordinal) PRIMARY KEY`, chunk data. |
| `mcp_servers` | `id PRIMARY KEY`, name, endpoint, configuration version, authentication mode, role, state, discovery metadata. |
| `mcp_tools` | Connector ID, tool name, catalog version, alias, input/output schemas, annotations, availability. |
| `credentials` | Private credential ID, kind, connector/owner association, value, expiry, version. |
| `oauth_transactions` | Random state digest, connector, owner association, PKCE verifier, issuer, redirect URI, expiry, exchange state. |
| `skills` | ID, name, description, enabled/deleted state, current version. |
| `skill_versions` | `(skill_id, version) PRIMARY KEY`, immutable instruction text and resource manifest. |
| `skill_resources` | Skill/version/path and artifact reference; unique normalized path per version. |
| `conversation_skills` | Conversation/skill selection, including whether to follow the current version at the next turn. |
| `context_snapshots` | ID, run/turn, model profile, skill versions, tool catalog versions, instruction references, history range, digest. |

`entries`, dispatched request artifacts, skill versions, and context snapshots are immutable. Soft deletion preserves anything referenced by historical attempts. Store raw MCP results once as artifacts; context and UI projections choose between equivalent text and structured representations rather than duplicating both.

### Domain services

```ts
class ConversationService {
  create(
    command: CommandEnvelope<{ title?: string }>
  ): Promise<CommandReceipt<{ conversationId: ConversationId }>>;
  list(): ConversationSummaryView[];
  history(conversationId: ConversationId, cursor?: string): HistoryPage;
  rename(
    command: CommandEnvelope<{ conversationId: ConversationId; title: string }>
  ): Promise<CommandReceipt<void>>;
}

class SubmissionService {
  submit(
    command: CommandEnvelope<SubmitInput>
  ): Promise<CommandReceipt<SubmitResult>>;
  withdraw(
    command: CommandEnvelope<{ submissionId: SubmissionId }>
  ): Promise<CommandReceipt<void>>;
}

class RunControlService {
  cancel(command: CommandEnvelope<{ runId: RunId }>): Promise<CommandReceipt<void>>;
  resolveAttempt(
    command: CommandEnvelope<ResolveAttemptInput>
  ): Promise<CommandReceipt<void>>;
  resume(command: CommandEnvelope<{ runId: RunId }>): Promise<CommandReceipt<void>>;
}
```

Semantics:

- `queue` creates a queued submission; the driver selects the oldest eligible submission by owner-wide sequence.
- `steer` joins the currently active run of that conversation after its current tool round. If that conversation has no active run, return a conflict; never silently reinterpret it as `queue`.
- Cancelling queued input withdraws that input; cancelling active work persists a cancellation request and signals the active attempt.
- Resolving an uncertain attempt records a separate resolution and preserves its original unknown outcome.
- Retrying an uncertain tool creates a new attempt explicitly linked to the old one; it never rewrites the old attempt into “not executed”.

### Execution engine

Persistent phases and checkpoint:

```ts
type RunPhase =
  | "prepare_context"
  | "compact_context"
  | "request_model"
  | "execute_tools"
  | "finish_turn";

interface RunCheckpoint {
  phase: RunPhase;
  turnNumber: number;
  contextSnapshotId?: string;
  assistantEntryId?: string;
  pendingToolCalls: PersistedToolCall[];
  nextToolIndex: number;
}

type RuntimeEvent =
  | { type: "context_ready"; snapshotId: string }
  | { type: "compaction_required"; requestArtifactId: ArtifactId }
  | { type: "model_finished"; entryId: string; tools: PersistedToolCall[] }
  | { type: "tool_finished"; attemptId: AttemptId }
  | { type: "authentication_required"; connectorId: ConnectorId }
  | { type: "remote_outcome_unknown"; attemptId: AttemptId }
  | { type: "cancel_requested" }
  | { type: "definite_failure"; code: string };

interface RunTransition {
  nextState: RunState;
  nextCheckpoint: RunCheckpoint;
  effects: RuntimeEffect[];
}

class RunMachine {
  transition(run: RunRecord, event: RuntimeEvent): RunTransition;
}

class RunDriver {
  driveSlice(): Promise<void>;
  signalCancellation(runId: RunId): void;
}

class AttemptExecutor {
  execute(attempt: PreparedAttempt, signal: AbortSignal): Promise<AttemptOutcome>;
}

class RecoveryService {
  recoverPreviousGeneration(): Promise<RecoverySummary>;
}

class OutputCommitter {
  append(attemptId: AttemptId, delta: OutputDelta): void;
  flush(attemptId: AttemptId): Promise<void>;
  close(attemptId: AttemptId): Promise<void>;
}
```

`RunMachine` is a pure transition function: it performs no I/O and writes no SQL. The driver coordinates effects.

A complete turn:

1. Resolve selected model, skills, instructions, and current tool descriptors.
2. Persist an immutable context snapshot.
3. If needed, schedule a tracked model attempt to compact history.
4. Persist a model attempt in `prepared`.
5. Resolve its required configuration and transition to `dispatched` before network I/O.
6. Consume the model stream, committing partial output in coalesced batches.
7. Persist the complete assistant message, including provider-native continuation data.
8. Only after a complete valid assistant response, create its tool attempts.
9. Execute tool calls sequentially, recording each result.
10. Append steering input at the tool-round boundary.
11. Start another model turn or finish the run.

Tool calls are never dispatched from partially streamed arguments.

Runtime limits:

```ts
interface RuntimeLimits {
  sliceBudgetMs: 600_000;
  externalAttemptBudgetMs: 540_000;
  cancellationGraceMs: 10_000;
  recoveryWakeIntervalMs: 30_000;
  outputFlushIntervalMs: 100;
}
```

These are internal runtime limits, not a claim that remote commands finish within them.

- The alarm handler awaits `driveSlice()`.
- Before external dispatch, persist the attempt and arm a recovery wake.
- Never rely on an untracked promise continuing after an HTTP response.
- Start no external attempt without enough remaining slice budget.
- At the external-attempt deadline, request cancellation and classify the outcome.
- An unsafe remote call that cannot be confirmed stopped becomes `unknown`; it is not replayed.
- Long-running commands exceeding this boundary are an explicit MVP limitation. Stronger support requires resumable remote operation handles, which the existing container helper does not expose.
- A new object generation recovers previous dispatched attempts; a second alarm in the same live generation must not misclassify an attempt the in-memory driver is still executing.
- Waiting for credentials or human resolution does not produce perpetual alarm polling.

Recovery matrix:

| Persisted state at reconstruction | Action |
| --- | --- |
| `prepared` | Dispatch may proceed; network I/O is forbidden before `dispatched` is committed. |
| Dispatched model attempt | Retain interrupted partial output; create a replacement attempt from the same valid context boundary. Bound retries. |
| Dispatched replay-safe tool | Create a linked retry attempt; preserve the original interruption. |
| Dispatched unsafe tool | Mark unknown and stop automatic mutation. |
| Successful attempt with committed result | Advance from the checkpoint; never repeat the operation. |
| Cancellation requested | Continue cancellation handling; do not start another ordinary turn. |

### Model boundary

```ts
interface ModelProfile {
  gatewayId: string;
  provider: string;
  model: string;
  protocol: "openai-responses" | "openai-chat-completions" | "anthropic-messages";
  contextWindow: number;
  maxOutputTokens: number;
}

interface ModelRequest {
  attemptId: AttemptId;
  profile: ModelProfile;
  system: string;
  history: ModelHistoryItem[];
  tools: ModelToolDefinition[];
}

type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_delta"; value: ToolCallDelta }
  | { type: "usage"; value: ModelUsage }
  | { type: "completed"; value: CompletedModelTurn };

interface ModelGateway {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

interface ProviderCodec {
  protocol: ModelProfile["protocol"];
  encode(request: ModelRequest): GatewayRequest;
  decode(response: Response, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

interface GatewayTransport {
  send(request: GatewayRequest, signal: AbortSignal): Promise<Response>;
}
```

`AiBindingTransport` is the only module that knows the AI binding’s universal-request API; tests replace it with `FakeGatewayTransport`.

Wire support is explicit:

- `OpenAIResponsesCodec`: Responses input items, function-call IDs and results, reasoning and encrypted continuation items.
- `OpenAIChatCodec`: assistant/tool message pairing, tool-call IDs, Chat Completions stream framing.
- `AnthropicMessagesCodec`: content blocks, `tool_use`/`tool_result` IDs, thinking signatures, stream stop reasons.

The active profile selects exactly one codec. There is no automatic provider or model fallback; an unsupported protocol selection is a configuration error before a run starts. Store canonical display content and the native continuation representation; never reconstruct reasoning signatures or native tool-call records from rendered text. Partial streaming errors after dispatch reach the driver and never trigger an invisible retry inside the codec.

### MCP subsystem

Configuration and discovered tools:

```ts
type ConnectorAuth =
  | { mode: "auto" }
  | { mode: "none" }
  | { mode: "oauth"; registration?: OAuthClientRegistration }
  | { mode: "header"; credentialId: string }
  | { mode: "cf-access"; trustedOrigin: string };

interface ConnectorConfig {
  id: ConnectorId;
  version: number;
  name: string;
  endpoint: string;
  auth: ConnectorAuth;
  role?: "container" | "web-research";
}

interface ToolDescriptor {
  alias: string;
  connectorId: ConnectorId;
  connectorVersion: number;
  catalogVersion: number;
  remoteName: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: Record<string, unknown>;
}

interface NormalizedToolResult {
  isError: boolean;
  content: ToolContent[];
  structuredContent?: unknown;
}
```

A configured role identifies the known helper contract; a matching tool name on an arbitrary server does not establish replay safety.

```ts
class ConnectorService {
  add(command: CommandEnvelope<AddConnectorInput>): Promise<CommandReceipt<{ connectorId: ConnectorId }>>;
  update(command: CommandEnvelope<UpdateConnectorInput>): Promise<CommandReceipt<void>>;
  connect(connectorId: ConnectorId): Promise<ConnectionReport>;
  disconnect(connectorId: ConnectorId): Promise<void>;
  refreshTools(connectorId: ConnectorId): Promise<ToolDescriptor[]>;
}

interface McpConnection {
  initialize(signal: AbortSignal): Promise<ServerCapabilities>;
  listTools(cursor?: string): Promise<ToolPage>;
  callTool(
    request: { requestId: string; name: string; arguments: unknown },
    signal: AbortSignal
  ): Promise<NormalizedToolResult>;
  cancel(requestId: string): Promise<void>;
  detach(): Promise<void>;
  terminateSession(): Promise<void>;
}

interface McpTransportFactory {
  open(
    connector: ConnectorConfig,
    credential: CredentialLease | undefined
  ): Promise<McpConnection>;
}

class McpSessionManager {
  acquire(connectorId: ConnectorId): Promise<McpConnection>;
  release(connectorId: ConnectorId): Promise<void>;
  invalidate(connectorId: ConnectorId): Promise<void>;
}

class ToolCatalog {
  replaceDiscovery(connectorId: ConnectorId, tools: DiscoveredTool[]): ToolDescriptor[];
  resolve(alias: string, catalogVersion: number): ToolDescriptor;
  snapshot(): ToolDescriptor[];
}
```

Streamable HTTP is the MVP transport; local stdio servers are out of scope. `detach()` closes unnecessary client transport resources without deleting a remote session; `terminateSession()` explicitly deletes the session and can affect active work. Tool aliases use a persisted, length-bounded form derived from connector ID and remote tool name, with a separate reserved prefix for application tools. Catalog refresh never silently points an existing alias at a different connector. An attempt pins connector configuration and catalog versions, so an endpoint change before dispatch cannot send the old invocation to the new endpoint.

Authentication services:

```ts
interface AuthDiscoveryResult {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  clientMetadataSupported: boolean;
  scopesSupported: string[];
  pkceS256Supported: boolean;
}

class AuthDiscovery {
  discover(endpoint: string, challenge?: string): Promise<AuthDiscoveryResult>;
}

class OAuthCoordinator {
  begin(connectorId: ConnectorId): Promise<{ authorizationUrl: string }>;
  complete(callback: {
    state: string;
    code?: string;
    issuer?: string;
    error?: string;
  }): Promise<void>;
  refresh(connectorId: ConnectorId): Promise<CredentialLease>;
}

interface CredentialLease {
  credentialId: string;
  version: number;
  expiresAt?: number;
  headers: Headers;
}

class CredentialBroker {
  forConnector(connector: ConnectorConfig): Promise<CredentialLease | undefined>;
  updateAccessAssertion(verified: VerifiedAccessAssertion): Promise<void>;
}

class DestinationPolicy {
  validateEndpoint(url: URL): void;
  validateCredentialDestination(connector: ConnectorConfig, destination: URL): void;
}
```

Connection sequence:

1. Save the entered endpoint and explicit authentication choice.
2. Probe without sending the harness assertion or unrelated credentials.
3. If initialization succeeds, negotiate capabilities and enumerate all tool pages.
4. On an OAuth challenge, discover protected-resource metadata from the challenge, otherwise the endpoint-path then root well-known locations.
5. Discover and validate the authorization issuer’s metadata: for issuers with a path, OAuth metadata with path insertion, OpenID Connect discovery with path insertion, then OpenID Connect discovery with path appending; for issuers without a path, OAuth metadata, then OpenID Connect discovery.
6. Select pre-registration, advertised Client ID Metadata Documents, advertised dynamic registration, or manual client registration, in that priority order.
7. Persist a short-lived OAuth transaction containing random state, PKCE verifier, connector, issuer, and fixed callback URI.
8. Redirect the browser to authorization.
9. Authenticate the callback to the same owner; validate and consume its stored state before exchanging the code.
10. Store tokens, initialize MCP, and discover tools.
11. Refresh issued refresh tokens when appropriate; if none exist or refresh fails definitively, return to authorization-required.

Validate the discovered issuer and resource binding, use PKCE S256, and send the resource indicator on authorization and token requests. Client ID Metadata Documents require an externally readable, credential-free metadata endpoint such as `/oauth/client-metadata.json`, publicly reachable even though the rest of the application is behind Access; the callback remains authenticated. OAuth code exchange and refresh-token rotation can themselves lose responses; a failed reconstruction must not loop on a consumed code or a rotated refresh token and must require fresh authorization when token state cannot be recovered.

Cloudflare delegation is explicit: the configured trusted origin receives the verified harness assertion as `Cf-Access-Token`. This is not inferred from generic OAuth discovery. Access reissues the helper-scoped assertion downstream. The harness assertion is never sent while probing an untrusted endpoint, credential forwarding starts only after the connector is configured for that destination, and a redirect is never followed when it would carry a credential to another origin.

Tool dispatch boundary:

```ts
class ToolRouter {
  prepare(invocation: ToolInvocation): Promise<PreparedToolCall>;
  execute(call: PreparedToolCall, signal: AbortSignal): Promise<ToolExecutionOutcome>;
}

class ToolPolicyRegistry {
  replayPolicy(descriptor: ToolDescriptor): ReplayPolicy;
  isAllowedDuringReconciliation(descriptor: ToolDescriptor): boolean;
}
```

Resolve configuration, validate arguments, and obtain a credential before marking the attempt dispatched; no usable credential means waiting-for-auth with no dispatched effect. Use an interpreted JSON Schema validator compatible with Workers’ prohibition on dynamic code generation, and reject unsupported schema features explicitly rather than silently dropping validation. Disable automatic retries of `tools/call` in the transport wrapper. Reconnecting a session may repeat initialization and discovery but must never repeat an unresolved tool invocation.

### Skills and context

```ts
interface SkillVersion {
  skillId: SkillId;
  version: number;
  name: string;
  description: string;
  instructions: string;
  resources: { path: string; mediaType: string; artifactId: ArtifactId }[];
}

class SkillRegistry {
  create(command: CommandEnvelope<CreateSkillInput>): Promise<CommandReceipt<SkillVersion>>;
  update(command: CommandEnvelope<UpdateSkillInput>): Promise<CommandReceipt<SkillVersion>>;
  disable(command: CommandEnvelope<{ skillId: SkillId }>): Promise<CommandReceipt<void>>;
  remove(command: CommandEnvelope<{ skillId: SkillId }>): Promise<CommandReceipt<void>>;
  selectForConversation(
    command: CommandEnvelope<{ conversationId: ConversationId; skillIds: SkillId[] }>
  ): Promise<CommandReceipt<void>>;
  resolveForTurn(conversationId: ConversationId): SkillVersion[];
}
```

`SkillTools` exposes reserved application tools `read_skill({ skillId, version })` and `read_skill_resource({ skillId, version, path })`. Only versions selected in the current context snapshot are readable, resource paths are normalized and traversal is rejected, and deleting a skill hides it from future selection while preserving versions referenced by past turns. Editing a skill takes effect at the next context boundary; an already dispatched model request keeps its pinned version.

```ts
interface ContextSnapshot {
  id: string;
  conversationId: ConversationId;
  modelProfile: ModelProfile;
  systemSections: PromptSection[];
  skillVersions: { skillId: SkillId; version: number }[];
  tools: ToolDescriptor[];
  historyRange: { firstSequence: number; lastSequence: number };
  summaryEntryId?: string;
  digest: string;
}

class ContextAssembler {
  prepare(runId: RunId): ContextPreparation;
  materialize(snapshotId: string): ModelRequest;
}

class ContextBudget {
  assess(profile: ModelProfile, request: ModelRequest): BudgetAssessment;
}

class CompactionPlanner {
  plan(conversationId: ConversationId, budget: BudgetAssessment): CompactionPlan | undefined;
}
```

`prepare()` returns either a ready snapshot or a compaction request; it never makes an untracked model call. Compaction is a normal persisted attempt with an explicit source-history range and digest. Do not compact unresolved tool rounds or separate a tool call from its result. Summaries coexist with original entries.

`RepositoryContextService` owns the selected workspace root and the repository-instruction cache. Fetching instructions uses recorded calls through the configured container connector; context assembly reads committed instruction records and never hides remote I/O inside prompt rendering. A `read_repository_instructions({ path })` application tool loads applicable nested instructions before work on a path. Repository instructions and imported skills remain separate sources.

Large tool artifacts are exposed through a bounded `read_tool_result({ artifactId, offset, limit })` application tool. Model context never receives both identical text and structured versions of a result.

### Synchronization

```ts
class SnapshotReader {
  read(conversationId?: ConversationId): OwnerSnapshot;
}

class ViewProjector {
  project(commit: Commit<unknown>): ViewChange[];
}

class SyncHub {
  attach(socket: WebSocket, selection?: ConversationId): void;
  restore(sockets: WebSocket[]): void;
  publish(commit: Commit<unknown>): void;
  resnapshot(socket: WebSocket): void;
  detach(socket: WebSocket): void;
}
```

`attach()` registers the subscription and reads its bounded snapshot synchronously, with no intervening `await`; that is the snapshot/subscription boundary. Artifact contents and older history are fetched separately.

The client connects to `/ws`; the Worker routes the request to the owner’s Durable Object, which accepts the socket with the WebSocket Hibernation API. Socket attachments store only the connection ID, verified owner digest, authentication expiry, and selected conversation — never bearer tokens. Each connection receives a fresh `streamId` and a sequence-zero snapshot; subsequent frames increment an in-memory sequence. A gap in owner revisions is normal for a filtered subscription and is not a missing frame; delivery continuity is detected with stream sequence numbers. After reconstruction, surviving sockets receive a new stream and snapshot. Slow clients receive a replacement snapshot or are disconnected when bounded buffers overflow. Before sending protected data, the socket’s authentication expiry is checked; a socket does not provide indefinite authorization, and another device’s login must not silently renew every existing socket.

### Client

```text
src/client/
  commands/CommandDispatcher.ts
  commands/CommandOutbox.ts
  sync/ConversationFeed.ts
  sync/ConversationReducer.ts
  storage/DraftStore.ts
  components/
    AppShell.tsx
    ConversationList.tsx
    ConversationScreen.tsx
    Transcript.tsx
    AssistantMessage.tsx
    ToolCallCard.tsx
    Composer.tsx
    QueuePanel.tsx
    RunStatusBar.tsx
    RecoveryPanel.tsx
    SettingsScreen.tsx
    ModelSettingsForm.tsx
    McpConnectionList.tsx
    McpConnectionEditor.tsx
    SkillList.tsx
    SkillEditor.tsx
    ConversationSkillPicker.tsx
```

```ts
class CommandDispatcher {
  dispatch(command: PendingCommand): Promise<CommandReceipt<unknown>>;
}

class CommandOutbox {
  enqueue(command: PendingCommand): Promise<void>;
  acknowledge(commandId: CommandId): Promise<void>;
  pending(): Promise<PendingCommand[]>;
}

interface ConversationViewSource {
  values(): AsyncIterable<OwnerSnapshot>;
  select(conversationId?: ConversationId): void;
  reconnect(): void;
  dispose(): void;
}

class ConversationFeed implements ConversationViewSource {
  values(): AsyncIterable<OwnerSnapshot>;
  select(conversationId?: ConversationId): void;
  reconnect(): void;
  dispose(): void;
}
```

`CommandDispatcher` maps stable application command kinds to statically imported server functions. IndexedDB stores command kind, payload, command ID, and schema version — never generated server-function URLs or build IDs. A deployment can change generated function references while a mobile browser keeps an old bundle; a stale-reference failure must preserve pending commands, refresh the application when necessary, and resend the same logical command through the current function reference.

`ConversationFeed` owns the browser WebSocket: it receives a complete snapshot first, applies every subsequent change frame through `ConversationReducer`, exposes complete current views to Solid’s async reactive primitives, keeps connection status separate from conversation values, requests a new snapshot after a stream-sequence gap, and preserves the last committed view during reconnect. Raw append-only deltas are reduced before being emitted as current state.

Client command states are `local_pending`, `sending`, `accepted`, and `rejected`. On acknowledgement loss the same command ID is resent; acceptance is never inferred from rendering the local message. Connection states are `connecting`, `live`, `reconnecting`, `authentication_required`, and `offline`; reconnecting does not imply execution has stopped. The composer offers queue and steer explicitly during a run. `RecoveryPanel` appears only for a real unresolved outcome and is not a generic approval screen.

Mobile requirements attach to concrete components: `AppShell` handles dynamic viewport height and safe-area padding; `Composer` stays visible with the software keyboard and uses touch-sized controls; `Transcript` bounds rendering and history pagination, preserves the reading position, and auto-follows only when already near the end; `ToolCallCard` folds the summary, bounds the preview, retrieves the full result on demand, and scrolls code and diff blocks independently; settings and skill editors use single-column narrow layouts with no hover-only actions.

### Public routing

| Route | Handler |
| --- | --- |
| Static assets and application shell | Workers Static Assets |
| `/_server/*` | Solid server-function dispatch |
| `/ws` | `OwnerObject` WebSocket upgrade, accepted with the Hibernation API |
| `GET /api/mcp/oauth/callback` | `OAuthCoordinator.complete` |
| `GET /oauth/client-metadata.json` | Public credential-free OAuth client metadata |
| Everything else | Solid handler (client shell) |

There is no parallel REST API for ordinary application commands; those are server functions.

## Changes

**1. Project and deployment configuration**

Add the Vite, Solid 2, TypeScript, Wrangler, and test configuration. Configure `solid({ start: true, serverFunctions: true })` and `cloudflare({ viteEnvironment: { name: "ssr" } })` in the documented order. Configure static assets, the AI binding, the SQLite Durable Object binding and migration, and Access settings. Resolve and record the Worker-entry export of `OwnerObject` as described in Deployment shape. Pin dependency versions and generate Worker binding types.

**2. `src/shared/`**

Define the domain, command, and wire types from Shared contracts.

**3. `src/rpc/` and `src/worker/rpc/`**

Implement the public server functions, `RpcContext`, runtime validation, owner resolution, and delegation to the Durable Object.

**4. `src/worker/index.ts` and `src/worker/auth/`**

Expose the Solid handler, export `OwnerObject`, route `/ws` and the OAuth callback, verify the Access assertion, and forward delegated credentials.

**5. `src/worker/owner/OwnerObject.ts`**

Implement startup reconstruction, HTTP/WebSocket/alarm dispatch, and transient service wiring.

**6. `src/worker/storage/`**

Implement the schema, migrations, repositories, transactions, revision allocation, and chunked artifact storage.

**7. `src/worker/conversations/`**

Implement the domain services for conversations, submissions, and run control.

**8. `src/worker/runtime/`**

Implement `RunMachine`, `RunDriver`, `WakeScheduler`, `RecoveryService`, `AttemptExecutor`, `OutputCommitter`, `ToolRouter`, `ToolPolicyRegistry`, `TransitionCoordinator`, and the runtime limits.

**9. `src/worker/models/`**

Implement `ModelGateway`, `AiBindingTransport`, `ProviderCodec`, and the three codecs.

**10. `src/worker/mcp/`**

Implement `ConnectorService`, `McpSessionManager`, `McpTransportFactory`, `ToolCatalog`, `AuthDiscovery`, `OAuthCoordinator`, `CredentialBroker`, and `DestinationPolicy`.

**11. `src/worker/skills/` and `src/worker/context/`**

Implement `SkillRegistry`, `SkillTools`, `ContextAssembler`, `ContextBudget`, `CompactionPlanner`, and `RepositoryContextService`.

**12. `src/worker/sync/`**

Implement `SnapshotReader`, `ViewProjector`, and `SyncHub`.

**13. `src/client/`**

Implement the Solid application: `CommandDispatcher`, `CommandOutbox`, `ConversationFeed`, `ConversationReducer`, `DraftStore`, and the components listed under Client.

**14. `tests/`**

Add unit, Durable Object integration, and browser tests using the injectable interfaces and fixtures described in Tests.

## Behavior

### Submission and follow-ups

A submission is acknowledged only after its input and scheduling state are durably stored. The client generates one ID per logical submission; retrying that ID returns the existing receipt, and reusing it with different content is rejected.

While a run is active, a follow-up waits for a subsequent run, and a steering message joins at the next execution boundary after the current tool work. Neither interrupts a remote operation merely because the user sent another message. Ordering and intent are persisted so a restart cannot turn steering into a separate unrelated task.

### Browser disconnection and device switching

Closing the page, locking the phone, or losing the network does not cancel a run. Reconnection restores the last committed view after normal connection, startup, and storage latency, without waiting for a heartbeat or the next model response and without rebuilding history through model calls.

A second authenticated device sees the same server-side conversations and execution state. Local unsent drafts stay device-local.

### Model interruption

Commit partial output in bounded batches and flush at completion; only committed output is presented as durable. Do not dispatch tools from incomplete streamed arguments.

If a model attempt is interrupted: retain its committed partial output with an interrupted status, preserve already committed tool rounds, resume from the last valid execution boundary, and do not append a regenerated answer onto the previous incomplete answer as though they were one stream. A request that repeatedly fails ends with an explicit recoverable failure; retries are bounded.

### Remote tool interruption

Persist dispatch intent before sending a tool request. If the object stops after dispatch intent but before committing a result, the remote outcome may be unknown, even if the request never reached the helper.

| Tool category | Recovery behavior |
| --- | --- |
| Verified read-only container reads and web research | May retry with bounded attempts, recording that results or resource usage can differ. |
| `write`, `edit`, `bash` | Never automatically replay an uncertain call. |
| Other external mutations | Never automatically replay without an established idempotency contract. |
| Unknown tools | Conservative default: unsafe to replay. |

When a command was sent and its response was lost: persist the unresolved call with its arguments, session information, and known output; do not dispatch a duplicate automatically; allow read-only reconciliation; ask the owner to act only when the result cannot be established automatically; and provide an explicit resume or retry action that creates a new attempt rather than reusing the old call. While such an uncertainty is unresolved, the run is `needs_attention` and no further mutating run starts against the shared workspace. An interrupted remote `bash` is never labelled definitely failed or stopped: restarting the harness does not restart or roll back the container.

### Cancellation

Cancellation is durable and stops new scheduling. Propagate it to model and MCP operations where supported, and distinguish four conditions: cancellation requested, local execution stopped, remote execution confirmed stopped, and remote outcome still unknown. Stopping a browser wait or subscription must not send MCP session deletion or otherwise terminate server work.

### Authentication

The Worker verifies the incoming Access assertion before associating it with an owner.

For a connector using Access delegation:

1. Forward the verified harness assertion as `Cf-Access-Token`.
2. Downstream Access validates its Linked App Token policy.
3. Downstream Access supplies a new assertion for the helper’s audience.
4. The helper performs its existing verification.

Persist the latest usable delegated assertion in private server-side state so ordinary hibernation does not lose it. Never include it in prompts, tool-visible arguments, snapshots, logs, or browser storage. Use the verified `exp`; assume no fixed lifetime.

When a credential is unavailable, expired, or rejected: preserve the run and queued work, pause further protected operations, surface `waiting_for_auth` or a specific policy or configuration failure, accept a fresh verified assertion from a later authenticated request or a successful OAuth refresh, and resume only the work whose execution status is known. Do not add a service-token fallback. A long-lived WebSocket must not authorize new actions indefinitely after its authenticated session expires. Forward credentials only to configured destinations and never across a redirect to another origin.

### MCP connections

Adding a connector runs discovery and reports the required authentication. Connecting an OAuth server may require a browser authorization step; the callback completes the flow and returns to Settings. Disconnecting preserves the conversation history that referenced the connector’s tools.

When a connector is disconnected, authorization-required, or failing, tool calls to it are not dispatched; affected work pauses rather than reporting success. A changed tool list is re-discovered and re-namespaced, and any collision with an existing alias is surfaced rather than silently remapped.

### Context and workflow

Maintain separate representations of the complete persisted history, the current model context, and the client’s visible history window. Use bounded excerpts for large tool results while retaining access to the complete stored artifact, and show truncation and partial-result status accurately.

Before exceeding the configured model context budget, create a persisted summary covering a specific history range. Preserve the objective and corrections, accepted decisions and authorization, relevant repository instructions, files and commits involved, completed verification and outstanding work, and unresolved remote-operation outcomes. Compaction never erases source history and never converts an uncertain result into success. The agent follows repository instructions and skills; the UI does not impose a mandatory approval step on every tool.

### Skills

The owner can create, edit, disable, and delete skills, and select which are enabled per conversation. Editing a skill creates a new version; a running request keeps the version it started with. Enabled skills appear to the model as a catalog, and the model reads instructions and resources through tools. A skill that requests shell work goes through the connected container tools and is subject to the same replay policy.

### Mobile interface

The behaviors listed under Client are acceptance criteria, not optional polish.

## Tests

The test environment supplies controlled identities and endpoints instead of adding any production authentication bypass. The production authentication path stays intact.

Define injectable interfaces for the model transport, MCP transport, credential provider, and time source. Provide fixtures for model streams, MCP initialization and `tools/list`, OAuth metadata and token endpoints, and signed Access assertions with a matching JWKS. The ordinary suite runs with no real gateway ID, provider key, public domain, Access tenant, or deployed helper.

### Deployment and RPC

- The Cloudflare build exports both the Solid handler and `OwnerObject`.
- Server functions run in the Workers runtime with fixture authentication.
- Private server modules and credentials are absent from client chunks.
- Runtime argument validation and cross-owner rejection.
- RPC acknowledgement loss returns the original receipt; a changed payload conflicts.
- A deployment that changes generated function references while the outbox contains input preserves and resends the same logical command.

### Persistence and scheduling

- Duplicate submission IDs and conflicting payloads.
- Queue and steering order.
- Reconstruction of conversations and pending work from storage.
- Prevention of concurrent execution drivers.
- Rejection of stale model and tool completions.
- Alarm scheduling before durable acknowledgement; an alarm injected between scheduling and submission commit never loses acknowledged work.
- Cancellation and authentication pauses without lost input.

### Execution and recovery

- Every `RunMachine` event/state pair has a defined transition or explicit rejection.
- One driver per live generation; old completions cannot overwrite cancellation; a slice exit leaves work scheduled.
- Prepared, dispatched-safe, dispatched-unsafe, and completed attempts each follow the recovery matrix.
- Snapshot contains committed partial output; final flush and attempt settlement do not duplicate text.
- Provider codecs preserve tool IDs, reasoning continuation fields, usage, and error boundaries from vendor stream fixtures.
- Tool dispatch intent is persisted before an external effect; an external completion followed by loss of the response yields `unknown` without replay.
- MCP session loss is not treated as proof that remote work stopped.

### MCP and authentication

- Standard discovery including both protected-resource metadata mechanisms and the authorization server metadata fallback order.
- Registration priority across pre-registration, Client ID Metadata Documents, and dynamic registration.
- OAuth success, failure, cancellation, expiry, refresh rotation, consumed-code failure, and cross-owner callback rejection.
- Explicit credential configuration.
- Access delegation: no assertion during untrusted discovery, exact destination forwarding, no credential across a cross-origin redirect, and expired credentials pausing before dispatch.
- Tool-list changes and namespace collisions.
- Issuer, audience, signature, subject, and expiry validation; owner isolation; credentials surviving reconstruction without appearing in client state.

### Skills, context, and sync

- Skill CRUD, versioning, deletion with historical references, selected-resource boundaries, and per-conversation selection.
- Context assembly from history, summaries, skills, and bounded artifacts; compaction preserving source history and unresolved outcomes.
- `SyncHub`: a commit during attachment is observed once; a surviving socket gets a fresh stream; sequence gaps trigger snapshots.
- Snapshot/change consistency and hibernatable socket reconstruction.
- Observer cleanup does not cancel execution.
- Authentication expiry does not cause endless reconnect or accidental acceptance of a login HTML response.

### Mobile and browser

Automate narrow and wide viewports, touch interaction, safe areas, orientation changes, and reconnect. Verify submission acknowledgement loss, duplicate resend, history scrolling, tool-detail rendering, and the skill and MCP settings surfaces. Perform targeted manual checks on the owner’s phone for software-keyboard behavior, screen lock, and network changes; emulation alone does not establish those. No particular phone model is required. Live-service smoke tests are optional and require owner-supplied configuration.

## Verification

Implement in this order:

1. Resolve the Worker-entry export of `OwnerObject` and establish the Cloudflare build.
2. Configuration, schema, and authenticated routing.
3. Durable submission, scheduling, snapshots, and reconnect with fake model and MCP services.
4. AI Gateway binding integration.
5. Helper integrations and their cancellation and recovery handling.
6. Additional connectors, skills, and context management.
7. Mobile interaction and cross-device verification.

Project commands:

```sh
npm ci
npm run cf-typegen
npm run typecheck
npm run test:unit
npm run test:workers
npm run build
npm run test:e2e
```

Live acceptance, run only with owner-supplied configuration and a disposable workspace:

1. Authenticate to the harness.
2. Verify an Access-delegated call against each helper.
3. Complete a model and tool round through AI Gateway.
4. Perform research, file inspection, editing, and test execution.
5. Disconnect during work and reconnect from the same device.
6. Open the conversation from a second device.
7. Exercise an expired-credential pause and a later resume.
8. Exercise an uncertain remote mutation without duplicate execution.
9. Demonstrate the repository workflow, including instructions, skills, and a configured connector.

## Out of scope

- Provisioning or switching between multiple container contexts.
- Filesystem isolation per conversation.
- Replacing the existing helper services.
- Exactly-once execution of arbitrary remote commands.
- Simultaneous mutating runs against the shared workspace.
- A multi-user collaboration or tenant-management product.
- PWA installation, push notifications, and offline agent execution.
- Exposing the harness itself as an MCP server.
- A general-purpose connector marketplace.
- Local stdio MCP servers.
- Forks, subagents, a separate advisor runtime, or a codemode execution environment.
- Unattended credential renewal or machine-identity fallback.
- Server-function streaming or `live()` as the continuous-observation transport.

Future priorities:

1. Multiple container contexts and their authentication, routing, and lifecycle.
2. Remote-operation reconciliation or idempotency where stronger recovery is required.
3. Workspace isolation and safe concurrent execution.
4. Additional model protocols and product capabilities justified by actual use.

## Risks

| Risk | Mitigation |
| --- | --- |
| The Solid virtual handler cannot coexist with a named `OwnerObject` export | Resolve before feature work; fall back to a hand-written Worker entry dispatching `/_server` to the Solid handler, which is always possible. |
| Model or MCP SDK code assumes a Node runtime | Verify the model adapter and MCP client in the Workers runtime before building the full UI. |
| A remote command completes without a persisted result | Record uncertainty, prohibit automatic replay, and reconcile before more mutations. |
| The shared container is changed outside this harness | Do not claim exclusive filesystem ownership or treat writes as replay-safe. |
| A run outlives delegated authentication | Persist the credential securely, use verified expiry, and pause for refreshed authentication. |
| Gateway or model protocol differences lose reasoning or tool-call semantics | Implement and verify the configured protocol explicitly; do not claim universal compatibility. |
| Large transcripts and tool results exceed storage, context, or mobile rendering limits | Chunk artifacts, paginate history, bound model context, and compact without deleting history. |
| Reconnect presents stale or duplicated state | Use consistent snapshots, stream sequences, and stable submission IDs. |
| Idle connections prevent hibernation | Use hibernatable sockets and close unnecessary outbound transports and timers. |
| Automatic connector discovery is assumed to cover Access delegation | Expose Access delegation as an explicit option and never probe untrusted endpoints with the harness assertion. |
| Architecture expands before the basic workflow works | Deliver the durable submit → execute → reconnect path first, with one model and one container context. |

## Open Questions

No open question blocks this draft. Gateway values, deployment values, connector endpoints, and the owner’s device are supplied at configuration time rather than being design decisions. The Worker-entry export constraint is an implementation task with a defined fallback, not an open product choice. Choices intentionally deferred to implementation are the exact context-budget thresholds, the compaction summary format, and the concrete worker-invocation slice length; each is bounded by the behavior and tests defined above.

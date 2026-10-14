// Shared domain contracts (PLAN.md -> Architecture -> Shared contracts).
// Persistence internals and credentials never appear here.

export type ConversationId = string;
export type SubmissionId = string;
export type RunId = string;
export type AttemptId = string;
export type ConnectorId = string;
export type SkillId = string;
export type ArtifactId = string;
export type CommandId = string;
export type EntryId = string;
export type ContextSnapshotId = string;
export type CredentialId = string;
export type OAuthTransactionId = string;

export interface OwnerIdentity {
  issuer: string;
  subject: string;
}

/** Canonical `issuer|subject` form used for Durable Object naming and digests. */
export function ownerKey(owner: OwnerIdentity): string {
  return `${owner.issuer}|${owner.subject}`;
}

export interface CommandEnvelope<T> {
  commandId: CommandId;
  payload: T;
}

export interface CommandReceipt<T> {
  commandId: CommandId;
  revision: number;
  result: T;
}

export type RunState =
  | "queued"
  | "running"
  | "waiting_for_auth"
  | "needs_attention"
  | "completed"
  | "cancelled"
  | "failed";

export const TERMINAL_RUN_STATES: readonly RunState[] = ["completed", "cancelled", "failed"];

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

export type AttemptState =
  | "prepared"
  | "dispatched"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "unknown";

export type AttemptKind = "model" | "tool" | "compaction";

export type SubmissionMode = "queue" | "steer";
export type ReplayPolicy = "safe" | "unsafe";

export interface SubmitInput {
  conversationId: ConversationId;
  text: string;
  mode: SubmissionMode;
}

export interface SubmitResult {
  submissionId: SubmissionId;
  runId: RunId;
  state: "queued" | "joined";
}

export interface ResolveAttemptInput {
  attemptId: AttemptId;
  action: "accept_observed_state" | "abandon" | "retry";
  explanation: string;
  evidenceArtifactIds: ArtifactId[];
}

export type ApiErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "NOT_CONFIGURED"
  | "AUTH_REQUIRED"
  | "CONNECTOR_UNAVAILABLE"
  | "REMOTE_OUTCOME_UNKNOWN";

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  retryable: boolean;
}

/** Thrown by server code; serialized into `ApiError` across the RPC boundary. */
export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly retryable: boolean;

  constructor(code: ApiErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.retryable = retryable;
  }

  toApiError(): ApiError {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

// ---------------------------------------------------------------------------
// Display / projection types (separate from persistence records)
// ---------------------------------------------------------------------------

export type ConversationTitle = string;

export interface ConversationView {
  id: ConversationId;
  title: ConversationTitle;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationSummaryView extends ConversationView {
  activeRunState?: RunState;
  lastEntryPreview?: string;
  queuedCount: number;
}

export type TranscriptEntryKind =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "system"
  | "summary"
  | "notice";

export interface TranscriptEntryView {
  id: EntryId;
  conversationId: ConversationId;
  sequence: number;
  kind: TranscriptEntryKind;
  createdAt: number;
  attemptId?: AttemptId;
  text?: string;
  /** Artifact reference for large or structured content. */
  artifactId?: ArtifactId;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  streaming?: boolean;
  metadata?: Record<string, unknown>;
}

export interface AttemptView {
  id: AttemptId;
  runId: RunId;
  conversationId: ConversationId;
  kind: AttemptKind;
  state: AttemptState;
  replayPolicy: ReplayPolicy;
  toolName?: string;
  remoteName?: string;
  createdAt: number;
  updatedAt: number;
  errorCode?: string;
  errorMessage?: string;
  resultArtifactId?: ArtifactId;
}

export interface RunView {
  id: RunId;
  conversationId: ConversationId;
  state: RunState;
  phase: string;
  turnNumber: number;
  createdAt: number;
  updatedAt: number;
  cancelRequestedAt?: number;
}

export interface SubmissionView {
  id: SubmissionId;
  conversationId: ConversationId;
  mode: SubmissionMode;
  content: string;
  state: SubmissionState;
  runId?: RunId;
  ownerSequence: number;
  createdAt: number;
}

export type SubmissionState = "queued" | "steering" | "accepted" | "withdrawn" | "rejected";

export interface ConversationSnapshot {
  conversation: ConversationView;
  entries: TranscriptEntryView[];
  olderEntriesCursor?: string;
  activeRun?: RunView;
  activeAttempt?: AttemptView;
  queuedInputs: SubmissionView[];
  /** Skills explicitly selected for this conversation. */
  selectedSkillIds?: string[];
}

export interface ModelProfileView {
  gatewayId: string;
  provider: string;
  model: string;
  protocol: ModelProtocol;
  contextWindow: number;
  maxOutputTokens: number;
}

export type ModelProtocol = "openai-responses" | "openai-chat-completions" | "anthropic-messages";

export type ConnectorAuthMode = "auto" | "none" | "oauth" | "header" | "cf-access";

export interface ConnectorView {
  id: ConnectorId;
  name: string;
  endpoint: string;
  authMode: ConnectorAuthMode;
  role?: "container" | "web-research";
  state: "unconfigured" | "connecting" | "ready" | "auth_required" | "error";
  version: number;
  toolCount: number;
  lastError?: string;
}

export interface SkillView {
  id: SkillId;
  name: string;
  description: string;
  enabled: boolean;
  deleted: boolean;
  currentVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface ConfigurationStatusView {
  model?: ModelProfileView;
  connectors: ConnectorView[];
  skills: SkillView[];
  workspaceRoot?: string;
  settingsVersion: number;
  missing: string[];
}

export interface OwnerSnapshot {
  revision: number;
  conversations: ConversationSummaryView[];
  configuration: ConfigurationStatusView;
  selectedConversation?: ConversationSnapshot;
}

export interface HistoryQuery {
  conversationId: ConversationId;
  beforeSequence?: number;
  limit?: number;
}

export interface HistoryPage {
  conversationId: ConversationId;
  entries: TranscriptEntryView[];
  olderEntriesCursor?: string;
  revision: number;
}

export interface ArtifactReadQuery {
  artifactId: ArtifactId;
  offset?: number;
  limit?: number;
}

export interface ArtifactPage {
  artifactId: ArtifactId;
  mimeType: string;
  encoding: "utf8" | "base64";
  byteCount: number;
  totalByteCount: number;
  complete: boolean;
  offset: number;
  text: string;
}

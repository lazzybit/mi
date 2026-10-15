// Persistence records (PLAN.md -> Persistence and scheduling -> Stored records).
// These are internal shapes; public projections live in `src/shared/domain.ts`.

import type {
  AttemptId,
  AttemptKind,
  AttemptState,
  ArtifactId,
  ConnectorAuthMode,
  ConnectorId,
  ConversationId,
  CredentialId,
  EntryId,
  ModelProfile,
  ModelProtocol,
  OAuthTransactionId,
  ReplayPolicy,
  RunId,
  RunState,
  SkillId,
  SubmissionId,
  SubmissionMode,
  SubmissionState,
} from "../types";

export interface OwnerStateRecord {
  revision: number;
  schemaVersion: number;
  driverGeneration: number;
}

/**
 * A durable command outcome. `rejected` rows record a definitive refusal so a
 * delayed retry returns the same rejection instead of running the command
 * later (ADR-0001). Existing rows without a discriminator are `accepted`.
 */
export type CommandOutcome = "accepted" | "rejected";

export interface CommandReceiptRecord {
  commandId: string;
  kind: string;
  payloadHash: string;
  resultJson: string;
  revision: number;
  outcome: CommandOutcome;
  createdAt: number;
}

export interface ConversationRecord {
  id: ConversationId;
  title: string;
  createdAt: number;
  updatedAt: number;
  selectedProfile?: string;
  workspaceConfig?: string;
}

export interface SubmissionRecord {
  id: SubmissionId;
  conversationId: ConversationId;
  commandId: string;
  mode: SubmissionMode;
  ownerSequence: number;
  content: string;
  state: SubmissionState;
  runId?: RunId;
  createdAt: number;
}

export interface RunCheckpoint {
  phase: RunPhase;
  turnNumber: number;
  contextSnapshotId?: string;
  assistantEntryId?: string;
  pendingToolCalls: PersistedToolCall[];
  nextToolIndex: number;
  /** ADR-0002: active model/compaction attempt for the current invocation. */
  activeAttempt?: ActiveAttemptPointer;
  /** ADR-0002: compaction source range selected by the planner. */
  compactionPlan?: { firstSequence: number; lastSequence: number; digest: string };
}

export interface ActiveAttemptPointer {
  attemptId: AttemptId;
  kind: AttemptKind;
}

export type RunPhase =
  | "prepare_context"
  | "compact_context"
  | "request_model"
  | "execute_tools"
  | "finish_turn";

export interface PersistedToolCall {
  toolCallId: string;
  alias: string;
  connectorId?: ConnectorId;
  remoteName?: string;
  arguments: unknown;
}

export interface RunRecord {
  id: RunId;
  conversationId: ConversationId;
  state: RunState;
  phase: RunPhase;
  checkpoint: RunCheckpoint;
  generation: number;
  cancelRequestedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AttemptRecord {
  id: AttemptId;
  runId: RunId;
  conversationId: ConversationId;
  kind: AttemptKind;
  state: AttemptState;
  generation: number;
  requestArtifactId?: ArtifactId;
  resultArtifactId?: ArtifactId;
  replayPolicy: ReplayPolicy;
  connectorId?: ConnectorId;
  connectorVersion?: number;
  catalogVersion?: number;
  toolName?: string;
  remoteName?: string;
  toolCallId?: string;
  parentAttemptId?: AttemptId;
  /** ADR-0002: persisted backoff eligibility; reconstruction never recomputes it. */
  retryEligibleAt?: number;
  uncertaintyJson?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

export interface EntryRecord {
  id: EntryId;
  conversationId: ConversationId;
  sequence: number;
  kind: string;
  attemptId?: AttemptId;
  text?: string;
  artifactId?: ArtifactId;
  toolName?: string;
  toolCallId?: string;
  isError: boolean;
  metadataJson?: string;
  createdAt: number;
}

export interface LiveOutputRecord {
  attemptId: AttemptId;
  content: string;
  outputRevision: number;
}

export interface ArtifactRecord {
  id: ArtifactId;
  mimeType: string;
  encoding: "utf8" | "base64";
  byteCount: number;
  digest?: string;
  complete: boolean;
  createdAt: number;
}

export interface McpServerRecord {
  id: ConnectorId;
  name: string;
  endpoint: string;
  configurationVersion: number;
  authenticationMode: ConnectorAuthMode;
  role?: "container" | "web-research";
  state: "unconfigured" | "connecting" | "ready" | "auth_required" | "error";
  enabled: boolean;
  discoveryJson?: string;
  headerName?: string;
  trustedOrigin?: string;
  credentialId?: CredentialId;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface McpToolRecord {
  connectorId: ConnectorId;
  toolName: string;
  catalogVersion: number;
  alias: string;
  description: string;
  inputSchemaJson: string;
  outputSchemaJson?: string;
  annotationsJson?: string;
  available: boolean;
}

export interface CredentialRecord {
  id: CredentialId;
  kind: "oauth" | "header" | "access";
  connectorId?: ConnectorId;
  ownerKey?: string;
  value: string;
  expiresAt?: number;
  version: number;
  createdAt: number;
}

export interface OAuthTransactionRecord {
  id: OAuthTransactionId;
  stateDigest: string;
  connectorId: ConnectorId;
  ownerKey: string;
  pkceVerifier: string;
  issuer: string;
  redirectUri: string;
  expiresAt: number;
  exchangeState: string;
  createdAt: number;
}

export interface SkillRecord {
  id: SkillId;
  name: string;
  description: string;
  enabled: boolean;
  deleted: boolean;
  currentVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface SkillVersionRecord {
  skillId: SkillId;
  version: number;
  name: string;
  description: string;
  instructions: string;
  createdAt: number;
}

export interface SkillResourceRecord {
  skillId: SkillId;
  version: number;
  path: string;
  mediaType: string;
  artifactId: ArtifactId;
}

export interface ConversationSkillRecord {
  conversationId: ConversationId;
  skillId: SkillId;
  followCurrent: boolean;
}

export interface ContextSnapshotRecord {
  id: string;
  conversationId: ConversationId;
  runId: RunId;
  turnNumber: number;
  modelProfileJson: string;
  skillVersionsJson: string;
  toolCatalogJson: string;
  systemSectionsJson: string;
  historyFirst: number;
  historyLast: number;
  summaryEntryId?: string;
  digest: string;
  createdAt: number;
}

export interface AttemptResolutionRecord {
  id: string;
  attemptId: AttemptId;
  action: string;
  explanation: string;
  evidenceJson: string;
  createdAt: number;
}

/** A committed repository instruction fetched through the container connector. */
export interface RepositoryInstructionRecord {
  id: string;
  workspaceRoot: string;
  path: string;
  directory: string;
  artifactId: ArtifactId;
  digest: string;
  /** False records a confirmed absence so a missing file is not refetched. */
  present: boolean;
  fetchedAt: number;
}

export interface StoredModelProfile extends ModelProfile {
  protocol: ModelProtocol;
}

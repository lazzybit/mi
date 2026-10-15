// ADR-0002: canonical model boundary types. Provider wire encoding, message
// model, usage, stop reasons, and error classification come from pi-ai; this
// module keeps only the thin envelopes the durable execution boundary needs.

import type {
  AssistantMessage,
  Context,
  Message,
  ModelThinkingLevel,
  Tool,
  Usage,
} from "@earendil-works/pi-ai";
import type { ArtifactId, AttemptId } from "../../shared/domain";
import type { ModelProfile } from "../types";

export type { ModelProfile };

/**
 * Frozen model configuration for one execution request. Route selections stay
 * qualified references plus the resolved catalog entry; legacy profiles keep
 * their historical shape so old artifacts remain executable.
 */
export type FrozenModelProfile = RouteModelProfile | LegacyModelProfile;

export interface RouteModelProfile {
  kind: "route";
  gatewayId: string;
  routeId: string;
  /** Catalog provider (metadata only; never dispatched as the identity). */
  provider: string;
  /** Catalog model id (metadata only). */
  modelId: string;
  api: string;
  /** Resolved catalog entry, frozen as plain JSON. */
  model: Record<string, unknown>;
  thinkingLevel?: ModelThinkingLevel;
  /** Effective output cap for this request. */
  maxTokens: number;
}

export interface LegacyModelProfile {
  kind: "legacy";
  profile: ModelProfile;
}

/** Canonical frozen request (ADR-0002). */
export interface CanonicalModelRequest {
  version: 2;
  attemptId: AttemptId;
  profile: FrozenModelProfile;
  context: Context;
}

/**
 * Historical request shape persisted before ADR-0002. Recovery converts it to
 * a canonical context when resuming; artifacts stay immutable.
 */
export interface LegacyModelRequest {
  attemptId: AttemptId;
  profile: ModelProfile;
  system: string;
  history: LegacyHistoryItem[];
  tools: LegacyToolDefinition[];
}

export type ModelRequest = CanonicalModelRequest | LegacyModelRequest;

export function isCanonicalRequest(request: ModelRequest): request is CanonicalModelRequest {
  return (request as CanonicalModelRequest).version === 2;
}

/** Legacy history items as stored by pre-ADR-0002 request artifacts. */
export interface LegacyHistoryItem {
  role: "user" | "assistant" | "tool" | "summary";
  text?: string;
  native?: unknown;
  toolCalls?: PersistedModelToolCall[];
  toolCallId?: string;
  name?: string;
  isError?: boolean;
}

export interface PersistedModelToolCall {
  toolCallId: string;
  name: string;
  arguments: unknown;
}

export interface LegacyToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** Streaming events the durable runtime consumes; deltas never create calls. */
export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "completed"; message: AssistantMessage };

export interface ModelGateway {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

/**
 * Terminal outcome of one model attempt. `message` is the authoritative pi-ai
 * assistant message, including error and length stop reasons.
 */
export interface ModelAttemptResult {
  message: AssistantMessage;
  usage?: Usage;
  artifactId?: ArtifactId;
}

export type { Message, Tool };

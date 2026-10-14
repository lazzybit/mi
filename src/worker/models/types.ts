// Model boundary types (PLAN.md -> Model boundary).

import type { ArtifactId, AttemptId, ModelProtocol } from "../../shared/domain";
import type { ModelProfile } from "../types";

export type { ModelProfile };

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export type ModelHistoryItem =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; native?: unknown; toolCalls?: PersistedModelToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; text: string; isError: boolean }
  | { role: "summary"; text: string };

export interface PersistedModelToolCall {
  toolCallId: string;
  name: string;
  arguments: unknown;
}

export interface CompletedModelTurn {
  text: string;
  reasoning?: string;
  toolCalls: PersistedModelToolCall[];
  usage?: ModelUsage;
  stopReason?: string;
  /** Provider-native continuation payload (encrypted reasoning, signatures, ...). */
  native?: unknown;
}

export interface ModelRequest {
  attemptId: AttemptId;
  profile: ModelProfile;
  system: string;
  history: ModelHistoryItem[];
  tools: ModelToolDefinition[];
}

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_delta"; value: ToolCallDelta }
  | { type: "usage"; value: ModelUsage }
  | { type: "completed"; value: CompletedModelTurn };

export interface ModelGateway {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

/** Universal request passed to the AI binding or another transport. */
export interface GatewayRequest {
  protocol: ModelProtocol;
  gatewayId: string;
  /** AI Gateway provider slug, e.g. `openai` or `anthropic`. */
  provider: string;
  /** Provider-native path, e.g. `/v1/chat/completions`. */
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface GatewayTransport {
  send(request: GatewayRequest, signal: AbortSignal): Promise<Response>;
}

export interface ProviderCodec {
  protocol: ModelProtocol;
  encode(request: ModelRequest): GatewayRequest;
  decode(response: Response, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

export interface ModelAttemptResult {
  text: string;
  toolCalls: PersistedModelToolCall[];
  native?: unknown;
  usage?: ModelUsage;
  artifactId?: ArtifactId;
}

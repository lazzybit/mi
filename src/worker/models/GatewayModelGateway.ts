// ADR-0002: thin adapter mapping pi-ai stream events onto the durable model
// boundary. pi-ai owns provider encoding, stream interpretation, authoritative
// assistant messages, usage, and error classification; this module only wires
// transport, frozen profiles, and event envelopes.

import type {
  Api,
  AssistantMessageEvent,
  FetchFunction,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  Tool,
  ToolCall,
} from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import {
  CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
  createAiBindingFetch,
} from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { BINDING_BASE_URL } from "./ModelRoutes";
import type { LegacyHistoryItem, LegacyToolDefinition } from "./types";
import {
  isCanonicalRequest,
  type CanonicalModelRequest,
  type ModelEvent,
  type ModelGateway,
  type ModelRequest,
  type RouteModelProfile,
} from "./types";
import { AppError, type ModelProtocol } from "../../shared/domain";

/** Internal provider id used for every dispatch through this adapter. */
const GATEWAY_PROVIDER_ID = "gateway";

/** Transport binding: where requests go and which fetch performs them. */
export interface GatewayTransportBinding {
  /** Lazily resolved fetch; the AI binding is only resolved on dispatch. */
  fetch: () => Promise<FetchFunction> | FetchFunction;
  /** Fixed base URL override (fixture mode); binding routing when absent. */
  baseUrlOverride?: string;
}

export class GatewayModelGateway implements ModelGateway {
  private readonly models;

  constructor(private readonly transport: GatewayTransportBinding) {
    // ADR-0002: keyless binding authentication. The resolver supplies the
    // gateway binding sentinel and suppresses provider credential defaults;
    // ambient credential discovery is disabled.
    const provider = createProvider({
      id: GATEWAY_PROVIDER_ID,
      name: "AI Gateway",
      models: [],
      auth: {
        apiKey: {
          name: "Cloudflare AI Gateway binding",
          resolve: async () => ({
            auth: {
              headers: {
                "cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
                Authorization: null,
                "x-api-key": null,
              },
            },
          }),
        },
      },
      api: {
        "openai-completions": openAICompletionsApi(),
        "openai-responses": openAIResponsesApi(),
        "anthropic-messages": anthropicMessagesApi(),
      },
    });
    this.models = createModels({
      // No ambient credentials and no filesystem probing inside the Worker.
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    this.models.setProvider(provider);
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const canonical = isCanonicalRequest(request)
      ? request
      : legacyToCanonical(request);
    const model = this.toPiModel(canonical);
    const options = await this.streamOptions(canonical, signal);
    const stream = this.models.streamSimple(model, canonical.context, options);
    for await (const event of stream) {
      yield* mapEvent(event);
    }
  }

  private async streamOptions(
    request: CanonicalModelRequest,
    signal: AbortSignal,
  ): Promise<SimpleStreamOptions> {
    const profile = request.profile;
    const fetch = await this.transport.fetch();
    const options: SimpleStreamOptions = {
      // ADR-0002: SDK retries are disabled; the durable driver owns retries.
      maxRetries: 0,
      fetch,
      signal,
      headers: {
        "cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
        Authorization: null,
        "x-api-key": null,
      },
    };
    if (profile.kind === "route") {
      if (profile.thinkingLevel && profile.thinkingLevel !== "off") {
        options.reasoning = profile.thinkingLevel;
      }
      options.maxTokens = profile.maxTokens;
    }
    return options;
  }

  /**
   * Build the pi-ai model object for a frozen request. Catalog identity and
   * inference identity are distinct: the dispatched model id is the route, and
   * the base URL is the binding's gateway route, never the catalog host.
   */
  private toPiModel(request: CanonicalModelRequest): Model<Api> {
    const baseUrl = this.baseUrlFor(request);
    const profile = request.profile;
    if (profile.kind === "route") {
      const entry = profile.model as unknown as Model<Api>;
      return {
        ...entry,
        id: profile.routeId,
        provider: GATEWAY_PROVIDER_ID,
        baseUrl,
      };
    }
    return {
      type: "chat",
      id: profile.profile.model,
      name: profile.profile.model,
      provider: GATEWAY_PROVIDER_ID,
      api: legacyApi(profile.profile.protocol),
      baseUrl,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: profile.profile.contextWindow,
      maxTokens: profile.profile.maxOutputTokens,
      reasoning: false,
    };
  }

  private baseUrlFor(request: CanonicalModelRequest): string {
    const profile = request.profile;
    const gatewayId = profile.kind === "route" ? profile.gatewayId : profile.profile.gatewayId;
    if (this.transport.baseUrlOverride !== undefined) {
      const base = this.transport.baseUrlOverride.replace(/\/+$/, "");
      const api = profile.kind === "route" ? profile.api : legacyApi(profile.profile.protocol);
      return api === "anthropic-messages" ? base : `${base}/v1`;
    }
    if (profile.kind === "route") {
      // Dynamic routes use the binding's unified (OpenAI-compatible) endpoint.
      return `${BINDING_BASE_URL}/${gatewayId}/compat`;
    }
    const provider = profile.profile.provider;
    if (profile.profile.protocol === "anthropic-messages") {
      return `${BINDING_BASE_URL}/${gatewayId}/${provider}`;
    }
    return `${BINDING_BASE_URL}/${gatewayId}/${provider}/v1`;
  }
}

function mapEvent(event: AssistantMessageEvent): ModelEvent[] {
  switch (event.type) {
    case "text_delta":
      return [{ type: "text_delta", text: event.delta }];
    case "thinking_delta":
      return [{ type: "thinking_delta", text: event.delta }];
    case "done":
      return [{ type: "completed", message: event.message }];
    case "error":
      return [{ type: "completed", message: event.error }];
    default:
      return [];
  }
}

/**
 * Convert a persisted legacy request into a canonical context (ADR-0002).
 * Historical artifacts stay immutable; conversion happens on resume only.
 * Missing thinking signatures cannot be reconstructed: legacy assistant turns
 * replay as plain text plus their tool calls.
 */
export function legacyToCanonical(request: ModelRequest): CanonicalModelRequest {
  if (isCanonicalRequest(request)) return request;
  const profile = request.profile;
  return {
    version: 2,
    attemptId: request.attemptId,
    profile: { kind: "legacy", profile },
    context: {
      systemPrompt: request.system,
      messages: request.history.map(toCanonicalMessage),
      tools: request.tools.map(toCanonicalTool),
    },
  };
}

/** Map the historical protocol names onto pi-ai API ids (ADR-0002). */
export function legacyApi(protocol: ModelProtocol): Api {
  switch (protocol) {
    case "openai-chat-completions":
      return "openai-completions";
    case "openai-responses":
      return "openai-responses";
    case "anthropic-messages":
      return "anthropic-messages";
    default:
      throw new AppError("NOT_CONFIGURED", `unsupported model protocol: ${protocol}`);
  }
}

function toCanonicalMessage(item: LegacyHistoryItem): Message {
  const timestamp = 0;
  if (item.role === "user") {
    return { role: "user", content: item.text ?? "", timestamp };
  }
  if (item.role === "summary") {
    return {
      role: "system",
      content: `Conversation summary:\n${item.text ?? ""}`,
      timestamp,
    };
  }
  if (item.role === "tool") {
    const text = item.isError ? `Error: ${item.text ?? ""}` : (item.text ?? "");
    return {
      role: "toolResult",
      toolCallId: item.toolCallId ?? "",
      toolName: item.name ?? "tool",
      content: [{ type: "text", text }],
      isError: item.isError ?? false,
      timestamp,
    };
  }
  const content: (TextContent | ToolCall)[] = [];
  if (item.text) content.push({ type: "text", text: item.text });
  for (const call of item.toolCalls ?? []) {
    content.push({
      type: "toolCall",
      id: call.toolCallId,
      name: call.name,
      arguments: asJsonObject(call.arguments) as ToolCall["arguments"],
    });
  }
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "legacy",
    model: "legacy",
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp,
  };
}

function toCanonicalTool(tool: LegacyToolDefinition): Tool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as Tool["parameters"],
  };
}

function asJsonObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export type { RouteModelProfile };

// Worker-internal type barrel. Re-exports shared domain contracts and adds
// server-only shapes that never cross the client boundary.

export * from "../shared/domain";
export * from "../shared/commands";
export * from "../shared/wire";

export interface ModelProfile {
  gatewayId: string;
  provider: string;
  model: string;
  protocol: "openai-responses" | "openai-chat-completions" | "anthropic-messages";
  contextWindow: number;
  maxOutputTokens: number;
}

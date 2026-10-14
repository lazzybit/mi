import type { ModelUsage, PersistedModelToolCall } from "../types";

export function normalizeUsage(raw: unknown): ModelUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const input = numberOrUndefined(value.input_tokens ?? value.prompt_tokens);
  const output = numberOrUndefined(value.output_tokens ?? value.completion_tokens);
  const total = numberOrUndefined(value.total_tokens);
  const usage: ModelUsage = {};
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (total !== undefined) usage.totalTokens = total;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function safeParseJson(value: string): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return { _raw: value };
  }
}

export function finalizeToolCalls(
  calls: Iterable<{ id?: string; name?: string; args: string }>,
): PersistedModelToolCall[] {
  return [...calls].map((call, index) => ({
    toolCallId: call.id ?? `call_${index}`,
    name: call.name ?? "unknown",
    arguments: safeParseJson(call.args),
  }));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Context budgeting and compaction (ADR-0002). The estimator is deliberately
// conservative and provider-independent: it must not claim to be exact
// tokenization, only never to undercount structured content.

import type { Context, Message, Tool } from "@earendil-works/pi-ai";
import type { FrozenModelProfile } from "../models/types";
import type { EntryRecord } from "../storage/records";

export interface BudgetAssessment {
  estimatedTokens: number;
  contextWindow: number;
  outputReserve: number;
  overBudget: boolean;
}

/**
 * Cheap, deterministic token estimate (ADR-0002). Structured content is
 * serialized before counting so tool arguments, tool results, thinking
 * payloads, and opaque continuation state are never skipped.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function messageTokens(message: Message): number {
  if (message.role === "system") {
    const content = typeof message.content === "string" ? message.content : "";
    let tokens = estimateTokens(content);
    for (const section of Object.values(message.sections ?? {})) {
      if (section) tokens += estimateTokens(section);
    }
    return tokens;
  }
  if (message.role === "user") {
    return typeof message.content === "string"
      ? estimateTokens(message.content)
      : message.content.reduce((sum, block) => sum + estimateTokens(JSON.stringify(block)), 0);
  }
  if (message.role === "toolResult") {
    return message.content.reduce((sum, block) => sum + estimateTokens(JSON.stringify(block)), 0);
  }
  // assistant
  return message.content.reduce((sum, block) => sum + estimateTokens(JSON.stringify(block)), 0);
}

export class ContextBudget {
  /**
   * Assess a canonical request against a frozen profile. The output reserve is
   * the effective output cap of the request, not a fraction of the window.
   */
  assess(context: Pick<Context, "systemPrompt" | "messages" | "tools">, profile: FrozenModelProfile): BudgetAssessment {
    let tokens = estimateTokens(context.systemPrompt ?? "");
    for (const message of context.messages) tokens += messageTokens(message);
    for (const tool of context.tools ?? []) tokens += toolTokens(tool);
    const contextWindow = resolvedWindow(profile);
    const outputReserve = resolvedOutputCap(profile);
    return {
      estimatedTokens: tokens,
      contextWindow,
      outputReserve,
      overBudget: tokens + outputReserve > contextWindow,
    };
  }
}

function toolTokens(tool: Tool): number {
  try {
    return estimateTokens(JSON.stringify(tool));
  } catch {
    return 0;
  }
}

function resolvedWindow(profile: FrozenModelProfile): number {
  if (profile.kind === "route") {
    const window = profile.model.contextWindow;
    return typeof window === "number" && window > 0 ? window : 0;
  }
  return profile.profile.contextWindow;
}

function resolvedOutputCap(profile: FrozenModelProfile): number {
  if (profile.kind === "route") return profile.maxTokens;
  return profile.profile.maxOutputTokens;
}

export interface CompactionPlan {
  firstSequence: number;
  lastSequence: number;
  entryIds: string[];
  digest: string;
}

/**
 * Plans a summary over an explicit history range. Never plans across an
 * unresolved tool round (a tool call without its result).
 */
export class CompactionPlanner {
  plan(entries: EntryRecord[], keepRecent = 4): CompactionPlan | undefined {
    if (entries.length <= keepRecent) return undefined;
    const candidates = entries.slice(0, entries.length - keepRecent);
    const last = candidates[candidates.length - 1];
    if (!last) return undefined;

    // Do not split a tool call from its result.
    const pendingCallIds = new Set<string>();
    for (const entry of candidates) {
      if (entry.kind === "tool_call" && entry.toolCallId) pendingCallIds.add(entry.toolCallId);
      if (entry.kind === "tool_result" && entry.toolCallId) pendingCallIds.delete(entry.toolCallId);
    }
    let cut = candidates.length;
    while (cut > 0 && pendingCallIds.size > 0) {
      const entry = candidates[cut - 1];
      if (entry?.kind === "tool_result" && entry.toolCallId) pendingCallIds.delete(entry.toolCallId);
      if (entry?.kind === "tool_call" && entry.toolCallId) pendingCallIds.delete(entry.toolCallId);
      cut -= 1;
      // Recompute pending for the shortened range.
      pendingCallIds.clear();
      for (let i = 0; i < cut; i++) {
        const e = candidates[i];
        if (e?.kind === "tool_call" && e.toolCallId) pendingCallIds.add(e.toolCallId);
        if (e?.kind === "tool_result" && e.toolCallId) pendingCallIds.delete(e.toolCallId);
      }
    }
    if (cut <= 0) return undefined;

    const range = candidates.slice(0, cut);
    const first = range[0];
    const lastInRange = range[range.length - 1];
    if (!first || !lastInRange) return undefined;
    return {
      firstSequence: first.sequence,
      lastSequence: lastInRange.sequence,
      entryIds: range.map((entry) => entry.id),
      digest: `${first.sequence}:${lastInRange.sequence}:${range.length}`,
    };
  }
}

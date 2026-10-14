// Context budgeting and compaction (PLAN.md -> Skills and context).

import type { ModelProfile } from "../types";
import type { ModelRequest } from "../models/types";
import type { EntryRecord } from "../storage/records";

export interface BudgetAssessment {
  estimatedTokens: number;
  contextWindow: number;
  outputReserve: number;
  overBudget: boolean;
}

/** Cheap, deterministic token estimate; exact tokenization is provider-specific. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class ContextBudget {
  assess(profile: ModelProfile, request: ModelRequest): BudgetAssessment {
    let tokens = estimateTokens(request.system);
    for (const item of request.history) {
      if ("text" in item) tokens += estimateTokens(item.text);
      if (item.role === "assistant" && item.toolCalls) {
        for (const call of item.toolCalls) tokens += estimateTokens(JSON.stringify(call.arguments ?? {}));
      }
    }
    for (const tool of request.tools) tokens += estimateTokens(JSON.stringify(tool));
    const outputReserve = Math.min(profile.maxOutputTokens, Math.floor(profile.contextWindow / 4));
    return {
      estimatedTokens: tokens,
      contextWindow: profile.contextWindow,
      outputReserve,
      overBudget: tokens + outputReserve > profile.contextWindow,
    };
  }
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

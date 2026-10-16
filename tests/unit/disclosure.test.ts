import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { DisclosureState } from "../../src/client/DisclosureState";
import { projectLiveRows, projectTranscript, type DisplayRow } from "../../src/client/view";

function assistantEntry(id: number, content: unknown[], stopReason = "stop", errorMessage?: string): EntryRecord {
  return {
    id: id as EntryRecord["id"],
    conversationId: 1 as EntryRecord["conversationId"],
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        content,
        api: "openai-completions",
        provider: "gateway",
        model: "dynamic/runner",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        stopReason,
        ...(errorMessage === undefined ? {} : { errorMessage }),
        timestamp: 1,
      },
    ],
  } as unknown as EntryRecord;
}

function toolResult(id: number, callId: string, text: string): EntryRecord {
  return {
    id: id as EntryRecord["id"],
    conversationId: 1 as EntryRecord["conversationId"],
    kind: "pi.tool-result",
    model: [
      {
        role: "toolResult",
        toolCallId: callId,
        toolName: "Bash",
        content: [{ type: "text", text }],
        isError: false,
        timestamp: 1,
      },
    ],
  } as unknown as EntryRecord;
}

function liveAssistant(content: unknown[], timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "gateway",
    model: "dynamic/runner",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: "stop",
    timestamp,
  } as unknown as AssistantMessage;
}

function observeLive(state: DisclosureState, conversationId: string, message: AssistantMessage, entries: EntryRecord[] = []): DisplayRow[] {
  state.observe({ conversationId, entries, rows: [], liveMessage: message });
  return projectLiveRows(message);
}

describe("DisclosureState", () => {
  it("keeps an expanded thinking row expanded while streaming", () => {
    const state = new DisclosureState();
    const first = liveAssistant([{ type: "thinking", thinking: "a" }], 100);
    const firstRows = observeLive(state, "c1", first);
    const key = firstRows[0]!.key;
    state.set(key, true);

    const second = liveAssistant([{ type: "thinking", thinking: "ab" }], 100);
    const secondRows = observeLive(state, "c1", second);
    expect(secondRows[0]!.key).toBe(key);
    expect(state.expanded(key)).toBe(true);
  });

  it("retains an explicit collapse through later updates", () => {
    const state = new DisclosureState();
    const first = liveAssistant([{ type: "thinking", thinking: "a" }], 100);
    const key = observeLive(state, "c1", first)[0]!.key;
    state.set(key, true);
    state.set(key, false);

    const second = liveAssistant([{ type: "thinking", thinking: "ab" }], 100);
    observeLive(state, "c1", second);
    expect(state.expanded(key)).toBe(false);
  });

  it("transfers expansion from the live partial to its committed entry", () => {
    const state = new DisclosureState();
    const live = liveAssistant([{ type: "thinking", thinking: "a" }], 100);
    const liveKey = observeLive(state, "c1", live)[0]!.key;
    state.set(liveKey, true);

    const committed = assistantEntry(7, [{ type: "thinking", thinking: "a" }]);
    const rows = projectTranscript([committed]);
    state.observe({ conversationId: "c1", entries: [committed], rows, liveMessage: undefined });

    const committedKey = rows[0]!.key;
    expect(committedKey).not.toBe(liveKey);
    expect(state.expanded(committedKey)).toBe(true);
    expect(state.expanded(liveKey)).toBe(false);
  });

  it("transfers a live tool row by call identifier", () => {
    const state = new DisclosureState();
    const live = liveAssistant([{ type: "toolCall", id: "call-x", name: "Bash", arguments: {} }], 100);
    const liveKey = observeLive(state, "c1", live)[0]!.key;
    state.set(liveKey, true);

    const committed = assistantEntry(9, [{ type: "toolCall", id: "call-x", name: "Bash", arguments: {} }]);
    const rows = projectTranscript([committed]);
    state.observe({ conversationId: "c1", entries: [committed], rows, liveMessage: undefined });
    expect(state.expanded(rows[0]!.key)).toBe(true);
  });

  it("keeps a tool row expanded when its result arrives", () => {
    const state = new DisclosureState();
    const call = assistantEntry(1, [{ type: "toolCall", id: "x", name: "Bash", arguments: {} }]);
    const before = projectTranscript([call]);
    state.observe({ conversationId: "c1", entries: [call], rows: before, liveMessage: undefined });
    const key = before[0]!.key;
    state.set(key, true);

    const result = toolResult(2, "x", "out");
    const after = projectTranscript([call, result]);
    state.observe({ conversationId: "c1", entries: [call, result], rows: after, liveMessage: undefined });
    expect(after[0]!.key).toBe(key);
    expect(state.expanded(key)).toBe(true);
  });

  it("follows expansion from a standalone result to its matched call", () => {
    const state = new DisclosureState();
    const result = toolResult(5, "x", "out");
    const standaloneRows = projectTranscript([result]);
    state.observe({ conversationId: "c1", entries: [result], rows: standaloneRows, liveMessage: undefined });
    const standaloneKey = standaloneRows[0]!.key;
    state.set(standaloneKey, true);

    const call = assistantEntry(1, [{ type: "toolCall", id: "x", name: "Bash", arguments: {} }]);
    const matchedRows = projectTranscript([call, result]);
    state.observe({ conversationId: "c1", entries: [call, result], rows: matchedRows, liveMessage: undefined });
    const matchedKey = matchedRows[0]!.key;
    expect(matchedKey).not.toBe(standaloneKey);
    expect(state.expanded(matchedKey)).toBe(true);
  });

  it("isolates choices between conversations", () => {
    const state = new DisclosureState();
    const live = liveAssistant([{ type: "thinking", thinking: "a" }], 100);
    const key = observeLive(state, "c1", live)[0]!.key;
    state.set(key, true);

    observeLive(state, "c2", live);
    expect(state.expanded(key)).toBe(false);
  });

  it("does not inherit expansion across a retry", () => {
    const state = new DisclosureState();
    const first = liveAssistant([{ type: "text", text: "a" }], 100);
    const firstKey = observeLive(state, "c1", first)[0]!.key;
    state.set(firstKey, true);

    const failed = assistantEntry(1, [{ type: "text", text: "a" }], "error", "boom");
    state.observe({
      conversationId: "c1",
      entries: [failed],
      rows: projectTranscript([failed]),
      liveMessage: undefined,
    });

    const retry = liveAssistant([{ type: "text", text: "a" }], 200);
    const retryKey = observeLive(state, "c1", retry, [failed])[0]!.key;
    expect(retryKey).not.toBe(firstKey);
    expect(state.expanded(retryKey)).toBe(false);
  });
});

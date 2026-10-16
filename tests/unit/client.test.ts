import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import {
  formatDuration,
  formatToolLabel,
  liveSummary,
  projectLiveRows,
  projectTranscript,
  queuedInputs,
  type ToolRow,
} from "../../src/client/view";
import { PendingSubmissionStore } from "../../src/client/pending/PendingSubmissions";
import { DraftStore } from "../../src/client/storage/DraftStore";

function view(entries: EntryRecord[], docs: Record<string, unknown> = {}): ConversationView {
  return {
    conversation: { id: 1 } as ConversationView["conversation"],
    entries,
    docs: docs as ConversationView["docs"],
  };
}

function user(id: number, text: string): EntryRecord {
  return {
    id: id as EntryRecord["id"],
    conversationId: 1 as EntryRecord["conversationId"],
    kind: "pi.user",
    model: [{ role: "user", content: text, timestamp: 1 }],
  } as unknown as EntryRecord;
}

function assistantEntry(
  id: number,
  content: unknown[],
  options: { stopReason?: string; errorMessage?: string } = {},
): EntryRecord {
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
        stopReason: options.stopReason ?? "stop",
        ...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
        timestamp: 1,
      },
    ],
  } as unknown as EntryRecord;
}

function toolResult(
  id: number,
  options: { callId: string; toolName: string; text: string; isError?: boolean; durationMs?: number },
): EntryRecord {
  return {
    id: id as EntryRecord["id"],
    conversationId: 1 as EntryRecord["conversationId"],
    kind: "pi.tool-result",
    model: [
      {
        role: "toolResult",
        toolCallId: options.callId,
        toolName: options.toolName,
        content: [{ type: "text", text: options.text }],
        isError: options.isError ?? false,
        ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
        timestamp: 1,
      },
    ],
  } as unknown as EntryRecord;
}

function liveAssistant(content: unknown[], timestamp = 100): AssistantMessage {
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

describe("transcript projection", () => {
  it("preserves assistant text and thinking order", () => {
    const rows = projectTranscript([
      user(1, "hello"),
      assistantEntry(2, [
        { type: "text", text: "first" },
        { type: "thinking", thinking: "why" },
        { type: "text", text: "second" },
      ]),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["user", "assistant", "thinking", "assistant"]);
    expect(rows[1]).toMatchObject({ kind: "assistant", text: "first" });
    expect(rows[2]).toMatchObject({ kind: "thinking", text: "why" });
    expect(rows[3]).toMatchObject({ kind: "assistant", text: "second" });
  });

  it("omits empty answer rows for thinking-only and tool-only messages", () => {
    const rows = projectTranscript([
      assistantEntry(1, [{ type: "thinking", thinking: "hmm" }]),
      assistantEntry(2, [{ type: "toolCall", id: "call-a", name: "Read", arguments: { path: "a" } }]),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["thinking", "tool"]);
  });

  it("pairs tool results with calls and preserves call order", () => {
    const rows = projectTranscript([
      assistantEntry(1, [
        { type: "toolCall", id: "a", name: "Bash", arguments: { command: "ls" } },
        { type: "toolCall", id: "b", name: "Read", arguments: { path: "x" } },
      ]),
      toolResult(2, { callId: "b", toolName: "Read", text: "file", durationMs: 2000 }),
      toolResult(3, { callId: "a", toolName: "Bash", text: "out", durationMs: 10000 }),
    ]);
    const tools = rows.filter((row): row is ToolRow => row.kind === "tool");
    expect(tools.map((row) => row.toolName)).toEqual(["Bash", "Read"]);
    expect(tools[0]?.result?.text).toBe("out");
    expect(formatToolLabel(tools[0]!)).toBe("Bash\uFF0E10s");
    expect(formatToolLabel(tools[1]!)).toBe("Read\uFF0E2s");
  });

  it("keeps an unmatched historical result inspectable", () => {
    const rows = projectTranscript([
      toolResult(5, { callId: "x", toolName: "Bash", text: "orphan", durationMs: 1500 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "tool", standalone: true, toolName: "Bash" });
    expect(formatToolLabel(rows[0] as ToolRow)).toBe("Bash\uFF0E2s");
  });

  it("does not share results between reused call identifiers", () => {
    const rows = projectTranscript([
      assistantEntry(1, [{ type: "toolCall", id: "call-1", name: "A", arguments: {} }]),
      toolResult(2, { callId: "call-1", toolName: "A", text: "first" }),
      assistantEntry(3, [{ type: "toolCall", id: "call-1", name: "B", arguments: {} }]),
      toolResult(4, { callId: "call-1", toolName: "B", text: "second" }),
    ]);
    const tools = rows.filter((row): row is ToolRow => row.kind === "tool");
    expect(tools.map((row) => row.result?.text)).toEqual(["first", "second"]);
  });

  it("matches a standalone result once its call is loaded", () => {
    const result = toolResult(5, { callId: "x", toolName: "Bash", text: "out" });
    expect(projectTranscript([result])[0]).toMatchObject({ kind: "tool", standalone: true });
    const matched = projectTranscript([
      assistantEntry(1, [{ type: "toolCall", id: "x", name: "Bash", arguments: {} }]),
      result,
    ]);
    expect(matched).toHaveLength(1);
    expect(matched[0]!.kind).toBe("tool");
    expect((matched[0] as ToolRow).standalone).toBeUndefined();
    expect((matched[0] as ToolRow).result?.text).toBe("out");
  });

  it("projects the live partial with the same content rules", () => {
    const rows = projectLiveRows(
      liveAssistant([
        { type: "thinking", thinking: "t" },
        { type: "text", text: "answer" },
      ]),
    );
    expect(rows.map((row) => row.kind)).toEqual(["thinking", "assistant"]);
    expect(rows.every((row) => row.key.startsWith("live:"))).toBe(true);
  });

  it("preserves the assistant failure notice when no answer text is available", () => {
    const rows = projectTranscript([
      assistantEntry(1, [{ type: "thinking", thinking: "hmm" }], {
        stopReason: "error",
        errorMessage: "boom",
      }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["thinking", "assistant"]);
    expect(rows[1]).toMatchObject({ kind: "assistant", isError: true, text: "boom" });
  });

  it("preserves user content, image placeholders, and summaries", () => {
    const rows = projectTranscript([
      {
        id: 1 as EntryRecord["id"],
        conversationId: 1 as EntryRecord["conversationId"],
        kind: "pi.user",
        model: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image", data: "abc", mimeType: "image/png" },
            ],
            timestamp: 1,
          },
        ],
      } as unknown as EntryRecord,
      {
        id: 2 as EntryRecord["id"],
        conversationId: 1 as EntryRecord["conversationId"],
        kind: "pi.compaction",
        model: [{ role: "user", content: "summary text", timestamp: 1 }],
      } as unknown as EntryRecord,
    ]);
    expect(rows[0]).toMatchObject({ kind: "user", text: "look\n[image: image/png]" });
    expect(rows[1]).toMatchObject({ kind: "summary", text: "summary text" });
  });

  it("does not mutate the input conversation data", () => {
    const entries = [
      assistantEntry(1, [{ type: "toolCall", id: "x", name: "Bash", arguments: { a: 1 } }]),
      toolResult(2, { callId: "x", toolName: "Bash", text: "out", durationMs: 1000 }),
    ];
    const before = structuredClone(entries);
    projectTranscript(entries);
    expect(entries).toEqual(before);
  });

  it("reports queued inputs and live run state", () => {
    const queued = queuedInputs(
      view([], {
        "pi.inbox": { items: [{ id: 7, mode: "followUp", content: "later" }] },
        "pi.live": { run: { taskId: 1, inputs: [7] }, generation: { attempt: 2 } },
      }),
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]?.mode).toBe("followUp");
    expect(queued[0]?.text).toBe("later");

    const summary = liveSummary(
      view([], { "pi.live": { run: { taskId: 1, inputs: [] }, generation: { attempt: 2 } } }),
    );
    expect(summary.active).toBe(true);
    expect(summary.attempt).toBe(2);
  });
});

describe("duration formatting", () => {
  it("rounds recorded milliseconds to whole seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(10000)).toBe("10s");
    expect(formatDuration(1500)).toBe("2s");
    expect(formatDuration(499)).toBe("0s");
  });

  it("omits missing or invalid durations", () => {
    expect(formatDuration(undefined)).toBeUndefined();
    expect(formatDuration(Number.NaN)).toBeUndefined();
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(formatDuration(-1)).toBeUndefined();
  });

  it("uses the exact separator and spacing", () => {
    const row: ToolRow = {
      kind: "tool",
      key: "k",
      toolName: "Bash",
      argumentsComplete: true,
      result: { text: "out", isError: false, durationMs: 10000 },
    };
    expect(formatToolLabel(row)).toBe("Bash\uFF0E10s");
  });
});

describe("PendingSubmissionStore", () => {
  it("tracks a submission until it is acknowledged", () => {
    const store = new PendingSubmissionStore();
    store.add({ requestId: "r1", conversationId: "c1", text: "hi", whenBusy: "followUp", createdAt: 1 });
    expect(store.list("c1")).toHaveLength(1);
    store.remove("r1");
    expect(store.list("c1")).toHaveLength(0);
  });

  it("clears every pending submission for a deleted conversation", () => {
    const store = new PendingSubmissionStore();
    store.add({ requestId: "r1", conversationId: "c1", text: "one", whenBusy: "followUp", createdAt: 1 });
    store.add({ requestId: "r2", conversationId: "c2", text: "two", whenBusy: "followUp", createdAt: 2 });
    store.clearConversation("c1");
    expect(store.list().map((entry) => entry.requestId)).toEqual(["r2"]);
  });
});

describe("DraftStore", () => {
  it("stores and clears a per-conversation draft", () => {
    const store = new DraftStore();
    store.set("c1", "hello");
    expect(store.get("c1")).toBe("hello");
    store.clear("c1");
    expect(store.get("c1")).toBe("");
  });
});

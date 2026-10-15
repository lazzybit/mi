import { describe, expect, it } from "vitest";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import {
  liveSummary,
  queuedInputs,
  transcriptEntries,
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

function assistant(id: number, text: string): EntryRecord {
  return {
    id: id as EntryRecord["id"],
    conversationId: 1 as EntryRecord["conversationId"],
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "openai-completions",
        provider: "gateway",
        model: "dynamic/runner",
        usage: {},
        stopReason: "stop",
        timestamp: 1,
      },
    ],
  } as unknown as EntryRecord;
}

function toolResult(id: number, toolName: string, text: string, isError = false): EntryRecord {
  return {
    id: id as EntryRecord["id"],
    conversationId: 1 as EntryRecord["conversationId"],
    kind: "pi.tool-result",
    model: [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName,
        content: [{ type: "text", text }],
        isError,
        timestamp: 1,
      },
    ],
  } as unknown as EntryRecord;
}

describe("transcript projection", () => {
  it("maps committed entries and the live partial into display entries", () => {
    const entries = transcriptEntries(
      view(
        [user(1, "hello"), assistant(2, "hi there"), toolResult(3, "echo", "echo: hi")],
        {
          "pi.live": {
            generation: {
              attempt: 1,
              message: {
                role: "assistant",
                content: [{ type: "text", text: "partial" }],
                api: "openai-completions",
                provider: "gateway",
                model: "dynamic/runner",
                usage: {},
                stopReason: "stop",
                timestamp: 1,
              },
            },
          },
        },
      ),
    );
    expect(entries.map((entry) => entry.kind)).toEqual([
      "user",
      "assistant",
      "tool_result",
      "assistant",
    ]);
    expect(entries[0]?.text).toBe("hello");
    expect(entries[2]?.toolName).toBe("echo");
    expect(entries[3]?.streaming).toBe(true);
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

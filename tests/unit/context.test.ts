import { describe, expect, it } from "vitest";
import { CompactionPlanner, ContextBudget } from "../../src/worker/context/ContextBudget";
import { buildHistory } from "../../src/worker/context/ContextAssembler";
import type { EntryRecord } from "../../src/worker/storage/records";
import { bootstrapConversation, createTestRuntime, envelope, TEST_MODEL_PROFILE } from "../helpers/runtime";

function entry(sequence: number, kind: string, extra: Partial<EntryRecord> = {}): EntryRecord {
  return {
    id: `e${sequence}`,
    conversationId: "c1",
    sequence,
    kind,
    isError: false,
    createdAt: sequence,
    ...extra,
  };
}

describe("CompactionPlanner", () => {
  it("never splits a tool call from its result", () => {
    const entries = [
      entry(1, "user", { text: "go" }),
      entry(2, "assistant", { text: "calling" }),
      entry(3, "tool_call", { toolCallId: "call_1" }),
      entry(4, "user", { text: "more" }),
      entry(5, "assistant", { text: "done" }),
    ];
    const plan = new CompactionPlanner().plan(entries, 2);
    expect(plan?.entryIds).toEqual(["e1", "e2"]);
    expect(plan?.entryIds).not.toContain("e3");
  });

  it("returns undefined when there is nothing to compact", () => {
    const plan = new CompactionPlanner().plan([entry(1, "user")], 4);
    expect(plan).toBeUndefined();
  });
});

describe("ContextBudget", () => {
  it("flags an over-budget request", () => {
    const budget = new ContextBudget();
    const assessment = budget.assess(
      { ...TEST_MODEL_PROFILE, contextWindow: 40, maxOutputTokens: 20 },
      {
        attemptId: "a",
        profile: { ...TEST_MODEL_PROFILE, contextWindow: 40, maxOutputTokens: 20 },
        system: "x".repeat(400),
        history: [],
        tools: [],
      },
    );
    expect(assessment.overBudget).toBe(true);
  });
});

describe("buildHistory", () => {
  it("folds tool_call display entries into the assistant item", () => {
    const history = buildHistory([
      entry(1, "user", { text: "hi" }),
      entry(2, "assistant", {
        text: "calling",
        metadataJson: JSON.stringify({ toolCalls: [{ toolCallId: "call_1", alias: "read", arguments: {} }] }),
      }),
      entry(3, "tool_call", { toolCallId: "call_1" }),
      entry(4, "tool_result", { toolCallId: "call_1", toolName: "read", text: "content" }),
    ]);
    expect(history.map((item) => item.role)).toEqual(["user", "assistant", "tool"]);
    const assistant = history[1];
    expect(assistant).toBeDefined();
    if (assistant?.role === "assistant") {
      expect(assistant.toolCalls?.[0]?.name).toBe("read");
    } else {
      throw new Error("expected an assistant history item");
    }
  });
});

describe("compaction preserves source history", () => {
  it("creates a summary without deleting original entries", async () => {
    const { runtime, model, backend } = createTestRuntime();
    await runtime.dispatch("saveModelProfile", [
      envelope({
        profile: { ...TEST_MODEL_PROFILE, contextWindow: 24, maxOutputTokens: 8 },
      }),
    ]);
    const created = (await runtime.dispatch("createConversation", [
      envelope({ title: "Long" }),
    ])) as { result: { conversationId: string } };
    const conversationId = created.result.conversationId;

    // Seed enough prior history that a compaction range exists.
    runtime.store.transaction((tx) => {
      for (let i = 0; i < 6; i++) {
        const sequence = tx.conversations.nextEntrySequence(conversationId);
        tx.entries.insert({
          id: `seed_${i}`,
          conversationId,
          sequence,
          kind: i % 2 === 0 ? "user" : "assistant",
          text: `prior message ${i}`,
          isError: false,
          createdAt: i,
        });
      }
    });

    // First model call is the compaction summary; second is the turn.
    model.pushText("summary of the conversation");
    model.pushText("final answer");

    await runtime.dispatch("submit", [
      envelope({ conversationId, text: "a very long message ".repeat(20), mode: "queue" }),
    ]);
    await runtime.alarm();

    const snapshot = runtime.store.readSnapshot(conversationId);
    const kinds = snapshot.selectedConversation?.entries.map((e) => e.kind) ?? [];
    expect(kinds).toContain("user");
    expect(kinds).toContain("summary");
    expect(kinds).toContain("assistant");
    // ADR-0001: compaction no longer leaves an unlinked plan artifact.
    const unlinked = backend.db
      .prepare(
        `SELECT COUNT(*) AS n FROM artifacts a WHERE NOT EXISTS (
           SELECT 1 FROM attempts t
           WHERE t.request_artifact_id = a.id OR t.result_artifact_id = a.id)`,
      )
      .get() as { n: number };
    expect(Number(unlinked.n)).toBe(0);
  });
});

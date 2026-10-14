import { describe, expect, it } from "vitest";
import { AppError } from "../../src/shared/domain";
import type { ModelEvent, ModelGateway, ModelRequest } from "../../src/worker/models/types";
import { OutputCommitter } from "../../src/worker/runtime/OutputCommitter";
import {
  FakeModelGateway,
  bootstrapConversation,
  createTestRuntime,
  envelope,
} from "../helpers/runtime";

describe("durable submission and execution", () => {
  it("acknowledges a queue submission with a run id, then executes it", async () => {
    const { runtime, model } = createTestRuntime();
    const { conversationId } = await bootstrapConversation(runtime);
    model.pushText("hello there");

    const receipt = (await runtime.dispatch("submit", [
      envelope({ conversationId, text: "hi", mode: "queue" }),
    ])) as { result: { submissionId: string; runId: string; state: string } };
    expect(receipt.result.state).toBe("queued");
    expect(receipt.result.runId).toBeTruthy();

    await runtime.alarm();

    const snapshot = runtime.store.readSnapshot(conversationId);
    const assistant = snapshot.selectedConversation?.entries.find((e) => e.kind === "assistant");
    expect(assistant?.text).toBe("hello there");
    expect(snapshot.selectedConversation?.activeRun).toBeUndefined();
    expect(model.requests).toHaveLength(1);
  });

  it("runs a tool round and then finishes", async () => {
    const { runtime, model, tools } = createTestRuntime();
    const { conversationId } = await bootstrapConversation(runtime);
    tools.register("read_file", { remoteName: "read", role: "container", replayPolicy: "safe" });
    model.pushText("let me read", [
      { toolCallId: "call_1", name: "read_file", arguments: { path: "a.txt" } },
    ]);
    model.pushText("the file says hi");

    await runtime.dispatch("submit", [
      envelope({ conversationId, text: "read a.txt", mode: "queue" }),
    ]);
    await runtime.alarm();

    const snapshot = runtime.store.readSnapshot(conversationId);
    const kinds = snapshot.selectedConversation?.entries.map((e) => e.kind) ?? [];
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    const assistant = snapshot.selectedConversation?.entries.filter((e) => e.kind === "assistant");
    expect(assistant?.at(-1)?.text).toBe("the file says hi");
    expect(tools.calls).toHaveLength(1);
  });

  it("persists dispatch intent before an external effect", async () => {
    const { runtime, model, tools } = createTestRuntime();
    const { conversationId } = await bootstrapConversation(runtime);
    let observedAttemptState: string | undefined;
    tools.register("mutate", {
      remoteName: "bash",
      role: "container",
      replayPolicy: "unsafe",
      handler: () => {
        const attempts = runtime.store.read((tx) =>
          tx.attempts.listForRun(
            runtime.store.read((tx2) => tx2.runs.activeForConversation(conversationId))?.id ?? "",
          ),
        );
        observedAttemptState = attempts.at(-1)?.state;
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      },
    });
    model.pushText("running", [{ toolCallId: "call_1", name: "mutate", arguments: {} }]);
    model.pushText("done");

    await runtime.dispatch("submit", [envelope({ conversationId, text: "go", mode: "queue" })]);
    await runtime.alarm();
    expect(observedAttemptState).toBe("dispatched");
  });
});

describe("steering", () => {
  it("rejects steer when there is no active run", async () => {
    const { runtime } = createTestRuntime();
    const { conversationId } = await bootstrapConversation(runtime);
    await expect(
      runtime.dispatch("submit", [envelope({ conversationId, text: "steer", mode: "steer" })]),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("joins steering input to the active run instead of queueing it", async () => {
    const { runtime, model } = createTestRuntime();
    const { conversationId } = await bootstrapConversation(runtime);
    model.pushText("first");
    await runtime.dispatch("submit", [envelope({ conversationId, text: "one", mode: "queue" })]);

    const steerReceipt = (await runtime.dispatch("submit", [
      envelope({ conversationId, text: "actually two", mode: "steer" }),
    ])) as { result: { state: string; runId: string } };
    expect(steerReceipt.result.state).toBe("joined");

    await runtime.alarm();
    const snapshot = runtime.store.readSnapshot(conversationId);
    expect(snapshot.selectedConversation?.queuedInputs).toHaveLength(0);
  });
});

describe("model interruption", () => {
  it("retains committed partial output and creates a replacement attempt", async () => {
    const model = new HangingModelGateway("partial answer");
    const { runtime } = createTestRuntime({
      model,
      limits: { externalAttemptBudgetMs: 5, outputFlushIntervalMs: 0, maxModelAttempts: 3 },
    });
    const { conversationId } = await bootstrapConversation(runtime);
    const submitted = (await runtime.dispatch("submit", [
      envelope({ conversationId, text: "go", mode: "queue" }),
    ])) as { result: { runId: string } };
    await runtime.alarm();

    const snapshot = runtime.store.readSnapshot(conversationId);
    const interrupted = snapshot.selectedConversation?.entries.find(
      (e) => e.kind === "assistant" && e.metadata?.interrupted === true,
    );
    expect(interrupted?.text).toBe("partial answer");
    const attempts = runtime.store.read((tx) => tx.attempts.listForRun(submitted.result.runId));
    expect(attempts.some((a) => a.state === "interrupted")).toBe(true);
    expect(attempts.some((a) => a.parentAttemptId)).toBe(true);
    // Bounded retries end in an explicit recoverable failure.
    expect(
      runtime.store.read((tx) => tx.runs.get(submitted.result.runId))?.state,
    ).toBe("failed");
  });
});

describe("unsafe tool interruption", () => {
  it("marks an uncertain unsafe call unknown and never replays it", async () => {
    const { runtime, model, tools } = createTestRuntime({
      limits: { externalAttemptBudgetMs: 5, maxSafeToolRetries: 2 },
    });
    const { conversationId } = await bootstrapConversation(runtime);
    tools.register("bash", {
      remoteName: "bash",
      role: "container",
      replayPolicy: "unsafe",
      handler: async (_args, signal) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      },
    });
    model.pushText("running bash", [{ toolCallId: "call_1", name: "bash", arguments: { cmd: "ls" } }]);

    await runtime.dispatch("submit", [envelope({ conversationId, text: "go", mode: "queue" })]);
    await runtime.alarm();

    const run = runtime.store.read((tx) => tx.runs.activeForConversation(conversationId));
    expect(run?.state).toBe("needs_attention");
    const attempts = runtime.store.read((tx) => (run ? tx.attempts.listForRun(run.id) : []));
    const toolAttempts = attempts.filter((a) => a.kind === "tool");
    expect(toolAttempts).toHaveLength(1);
    expect(toolAttempts[0]?.state).toBe("unknown");
    expect(tools.calls).toHaveLength(1);
  });

  it("retries a replay-safe tool after an interruption", async () => {
    const { runtime, model, tools } = createTestRuntime({
      limits: { externalAttemptBudgetMs: 5, maxSafeToolRetries: 2 },
    });
    const { conversationId } = await bootstrapConversation(runtime);
    let calls = 0;
    tools.register("read_file", {
      remoteName: "read",
      role: "container",
      replayPolicy: "safe",
      handler: async (_args, signal) => {
        calls += 1;
        if (calls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          if (signal.aborted) throw new DOMException("aborted", "AbortError");
        }
        return { isError: false, content: [{ type: "text", text: "content" }] };
      },
    });
    model.pushText("reading", [{ toolCallId: "call_1", name: "read_file", arguments: {} }]);
    model.pushText("finished");

    await runtime.dispatch("submit", [envelope({ conversationId, text: "go", mode: "queue" })]);
    await runtime.alarm();

    expect(calls).toBeGreaterThanOrEqual(2);
    const snapshot = runtime.store.readSnapshot(conversationId);
    expect(snapshot.selectedConversation?.entries.some((e) => e.kind === "tool_result")).toBe(true);
  });
});

describe("execution persistence boundaries", () => {
  it("links every execution artifact to its attempt", async () => {
    const { runtime, model, backend } = createTestRuntime();
    const { conversationId } = await bootstrapConversation(runtime);
    model.pushText("done");
    await runtime.dispatch("submit", [envelope({ conversationId, text: "go", mode: "queue" })]);
    await runtime.alarm();
    const unlinked = backend.db
      .prepare(
        `SELECT COUNT(*) AS n FROM artifacts a WHERE NOT EXISTS (
           SELECT 1 FROM attempts t
           WHERE t.request_artifact_id = a.id OR t.result_artifact_id = a.id)`,
      )
      .get() as { n: number };
    expect(Number(unlinked.n)).toBe(0);
  });

  it("discards late writes after the run disappears", async () => {
    const { runtime, model, tools, backend } = createTestRuntime();
    const { conversationId } = await bootstrapConversation(runtime);
    tools.register("mutate", {
      remoteName: "bash",
      role: "container",
      replayPolicy: "safe",
      handler: () => {
        // Simulate deletion while the tool is executing.
        runtime.store.transaction((tx) => {
          tx.runs.deleteForConversation(conversationId);
          tx.attempts.deleteForConversation(conversationId);
        });
        return { isError: false, content: [{ type: "text", text: "ok" }] };
      },
    });
    model.pushText("running", [{ toolCallId: "call_1", name: "mutate", arguments: {} }]);
    await runtime.dispatch("submit", [envelope({ conversationId, text: "go", mode: "queue" })]);
    await runtime.alarm();

    const results = backend.db
      .prepare(
        `SELECT COUNT(*) AS n FROM entries WHERE conversation_id = ? AND kind = 'tool_result'`,
      )
      .get(conversationId) as { n: number };
    expect(Number(results.n)).toBe(0);
  });

  it("completes cancellation for a paused run", async () => {
    const { runtime } = createTestRuntime();
    const { conversationId } = await bootstrapConversation(runtime);
    runtime.store.transaction((tx) => {
      tx.runs.insert({
        id: "r1",
        conversationId,
        state: "waiting_for_auth",
        phase: "prepare_context",
        checkpoint: { phase: "prepare_context", turnNumber: 1, pendingToolCalls: [], nextToolIndex: 0 },
        generation: tx.ownerState.readDriverGeneration(),
        cancelRequestedAt: 5,
        createdAt: 1,
        updatedAt: 1,
      });
    });
    await runtime.alarm();
    expect(runtime.store.read((tx) => tx.runs.get("r1"))?.state).toBe("cancelled");
  });

  it("discards buffered output for an attempt that no longer exists", () => {
    const { runtime, backend } = createTestRuntime();
    const committer = new OutputCommitter(runtime.store, { now: () => 1 });
    committer.append("ghost", "text");
    expect(committer.flush("ghost")).toBe("");
    const row = backend.db
      .prepare(`SELECT COUNT(*) AS n FROM live_output WHERE attempt_id = 'ghost'`)
      .get() as { n: number };
    expect(Number(row.n)).toBe(0);
  });
});

class HangingModelGateway implements ModelGateway {
  constructor(private readonly text: string) {}
  async *stream(_request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    yield { type: "text_delta", text: this.text };
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    yield { type: "completed", value: { text: this.text, toolCalls: [] } };
  }
}

export { AppError };

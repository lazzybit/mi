// ADR-0002: durable retry bookkeeping tests. Retry chains, persisted backoff,
// frozen requests, stop-reason handling, and reconstruction boundaries.

import { describe, expect, it } from "vitest";
import type { AttemptRecord } from "../../src/worker/storage/records";
import {
  assistantFixture,
  bootstrapConversation,
  createTestRuntime,
  envelope,
  type FakeModelGateway,
} from "../helpers/runtime";

function chainOf(attempts: AttemptRecord[], leaf: AttemptRecord): AttemptRecord[] {
  const chain: AttemptRecord[] = [leaf];
  let current = leaf;
  while (current.parentAttemptId) {
    const parent = attempts.find((attempt) => attempt.id === current.parentAttemptId);
    if (!parent) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}

describe("model stop reasons", () => {
  it("never dispatches tools from a truncated (length) response", async () => {
    const { runtime, model, tools } = createTestRuntime();
    const { conversationId } = await bootstrapConversation(runtime);
    tools.register("read_file", { remoteName: "read", replayPolicy: "safe" });
    model.pushAssistant(
      assistantFixture({
        text: "partial answer",
        stopReason: "length",
        toolCalls: [{ toolCallId: "call_1", name: "read_file", arguments: {} }],
      }),
    );

    await runtime.dispatch("submit", [envelope({ conversationId, text: "hi", mode: "queue" })]);
    await runtime.alarm();

    expect(tools.calls).toHaveLength(0);
    const snapshot = runtime.store.readSnapshot(conversationId);
    const run = runtime.store.read((tx) => tx.runs.listAll())[0];
    expect(run?.state).toBe("failed");
    const attempt = runtime.store
      .read((tx) => tx.attempts.listAll())
      .find((a) => a.kind === "model");
    expect(attempt?.errorCode).toBe("MODEL_OUTPUT_LIMIT");
    // The truncated response stays readable.
    expect(snapshot.selectedConversation?.entries.some((e) => e.text === "partial answer")).toBe(true);
  });

  it("fails a stop turn that embeds tool calls", async () => {
    const { runtime, model, tools } = createTestRuntime();
    const { conversationId } = await bootstrapConversation(runtime);
    tools.register("read_file", { remoteName: "read", replayPolicy: "safe" });
    model.pushAssistant(
      assistantFixture({
        text: "weird",
        stopReason: "stop",
        toolCalls: [{ toolCallId: "call_1", name: "read_file", arguments: {} }],
      }),
    );

    await runtime.dispatch("submit", [envelope({ conversationId, text: "hi", mode: "queue" })]);
    await runtime.alarm();

    expect(tools.calls).toHaveLength(0);
    const run = runtime.store.read((tx) => tx.runs.listAll())[0];
    expect(run?.state).toBe("failed");
  });
});

describe("transient model failures", () => {
  it("schedules a backoff retry child and dispatches it when eligible", async () => {
    const { runtime, model, clock } = createTestRuntime({ limits: { retryBaseDelayMs: 50 } });
    const { conversationId } = await bootstrapConversation(runtime);
    model.pushAssistant(assistantFixture({ text: "", stopReason: "error", errorMessage: "rate limit exceeded" }));
    model.pushText("recovered");

    await runtime.dispatch("submit", [envelope({ conversationId, text: "hi", mode: "queue" })]);
    await runtime.alarm();

    const attempts = () => runtime.store.read((tx) => tx.attempts.listAll());
    const modelAttempts = attempts().filter((a) => a.kind === "model");
    expect(modelAttempts).toHaveLength(2);
    const child = modelAttempts.find((a) => a.state === "prepared");
    expect(child).toBeDefined();
    expect(child?.parentAttemptId).toBe(modelAttempts.find((a) => a.state === "interrupted")?.id);
    // The computed eligibility is persisted once.
    expect(child?.retryEligibleAt).toBeTypeOf("number");
    // The child reuses the parent's frozen request artifact.
    expect(child?.requestArtifactId).toBe(modelAttempts[0]?.requestArtifactId);

    // A later slice, after the persisted backoff, dispatches the prepared
    // child instead of creating a new root.
    clock.advance((child?.retryEligibleAt ?? 0) - clock.now());
    await runtime.alarm();
    const after = attempts().filter((a) => a.kind === "model");
    expect(after.filter((a) => a.state === "succeeded")).toHaveLength(1);
    const snapshot = runtime.store.readSnapshot(conversationId);
    expect(snapshot.selectedConversation?.activeRun?.state ?? "completed").toBe("completed");
    const run = runtime.store.read((tx) => tx.runs.listAll())[0];
    expect(run?.state).toBe("completed");
    // One child, dispatched: no duplicate roots were created.
    expect(after.length).toBe(2);
  });

  it("does not retry non-transient provider errors", async () => {
    const { runtime, model } = createTestRuntime();
    const { conversationId } = await bootstrapConversation(runtime);
    model.pushAssistant(
      assistantFixture({ text: "", stopReason: "error", errorMessage: "Your request was rejected: invalid api key" }),
    );

    await runtime.dispatch("submit", [envelope({ conversationId, text: "hi", mode: "queue" })]);
    await runtime.alarm();

    const attempts = runtime.store.read((tx) => tx.attempts.listAll());
    expect(attempts.filter((a) => a.kind === "model")).toHaveLength(1);
    const run = runtime.store.read((tx) => tx.runs.listAll())[0];
    expect(run?.state).toBe("failed");
  });

  it("exhausts the per-invocation chain budget and fails", async () => {
    const { runtime, model } = createTestRuntime({ limits: { retryBaseDelayMs: 0, maxModelAttempts: 3 } });
    const { conversationId } = await bootstrapConversation(runtime);
    for (let i = 0; i < 5; i++) {
      model.pushAssistant(assistantFixture({ text: "", stopReason: "error", errorMessage: "temporarily overloaded" }));
    }

    await runtime.dispatch("submit", [envelope({ conversationId, text: "hi", mode: "queue" })]);
    await runtime.alarm();
    await runtime.alarm();
    await runtime.alarm();
    await runtime.alarm();

    const attempts = runtime.store.read((tx) => tx.attempts.listAll()).filter((a) => a.kind === "model");
    expect(attempts).toHaveLength(3);
    const chain = chainOf(attempts, attempts[attempts.length - 1] as AttemptRecord);
    expect(chain).toHaveLength(3);
    const run = runtime.store.read((tx) => tx.runs.listAll())[0];
    expect(run?.state).toBe("failed");
  });

  it("reuses the frozen request across retries", async () => {
    const { runtime, model } = createTestRuntime({ limits: { retryBaseDelayMs: 0 } });
    const { conversationId } = await bootstrapConversation(runtime);
    model.pushAssistant(assistantFixture({ text: "", stopReason: "error", errorMessage: "temporarily overloaded" }));
    model.pushText("done");

    await runtime.dispatch("submit", [envelope({ conversationId, text: "frozen input", mode: "queue" })]);
    await runtime.alarm();
    await runtime.alarm();

    const requests = model.requests;
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const contexts = requests.map((request) =>
      JSON.stringify("context" in request ? request.context.messages : request),
    );
    expect(contexts[0]).toBe(contexts[1]);
  });
});

describe("backoff and wake scheduling", () => {
  it("schedules the alarm at the persisted retry eligibility", async () => {
    const { runtime, model, alarms, clock } = createTestRuntime({ limits: { retryBaseDelayMs: 10_000 } });
    const { conversationId } = await bootstrapConversation(runtime);
    model.pushAssistant(assistantFixture({ text: "", stopReason: "error", errorMessage: "temporarily overloaded" }));
    model.pushText("recovered");

    await runtime.dispatch("submit", [envelope({ conversationId, text: "hi", mode: "queue" })]);
    await runtime.alarm();

    const child = runtime.store
      .read((tx) => tx.attempts.listAll())
      .find((a) => a.kind === "model" && a.state === "prepared");
    expect(child?.retryEligibleAt).toBeDefined();
    // The wake matches the persisted eligibility, not a busy poll.
    expect(alarms.alarm).toBe(child?.retryEligibleAt);

    // Advancing the clock past eligibility lets the retry dispatch.
    clock.advance(child?.retryEligibleAt !== undefined ? child.retryEligibleAt : 0);
    await runtime.alarm();
    const run = runtime.store.read((tx) => tx.runs.listAll())[0];
    expect(run?.state).toBe("completed");
  });
});

describe("canonical assistant persistence", () => {
  it("persists the authoritative message and replays it into the next context", async () => {
    const { runtime, model, tools } = createTestRuntime();
    const { conversationId } = await bootstrapConversation(runtime);
    tools.register("read_file", { remoteName: "read", replayPolicy: "safe" });
    model.pushAssistant(
      assistantFixture({
        text: "let me look",
        stopReason: "toolUse",
        toolCalls: [{ toolCallId: "call_1", name: "read_file", arguments: { path: "a" } }],
        thinking: "hmm",
      }),
    );
    model.pushText("the file says hi");

    await runtime.dispatch("submit", [envelope({ conversationId, text: "hi", mode: "queue" })]);
    await runtime.alarm();

    const requests = model.requests;
    expect(requests).toHaveLength(2);
    const second = requests[1];
    if (!second) throw new Error("expected a second request");
    if (!("context" in second)) throw new Error("expected a canonical request");
    const assistantMessages = second.context.messages.filter((m) => m.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    const assistant = assistantMessages[0];
    if (!assistant) throw new Error("expected an assistant message");
    if (assistant.role !== "assistant") throw new Error("expected an assistant message");
    // Thinking content, tool call identity, and usage survive the round trip.
    expect(assistant.content.some((block) => block.type === "thinking" && block.thinking === "hmm")).toBe(true);
    expect(assistant.content.some((block) => block.type === "toolCall" && block.name === "read_file")).toBe(true);
    expect(assistant.usage.output).toBe(8);
  });
});

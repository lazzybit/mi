import { describe, expect, it } from "vitest";
import { createRuntimeOnBackend, bootstrapConversation, createTestRuntime } from "../helpers/runtime";
import type { AttemptRecord, RunRecord } from "../../src/worker/storage/records";

function seedRun(store: ReturnType<typeof createTestRuntime>["runtime"]["store"], conversationId: string, overrides: Partial<RunRecord> = {}): RunRecord {
  const run: RunRecord = {
    id: "run_old",
    conversationId,
    state: "running",
    phase: "request_model",
    checkpoint: { phase: "request_model", turnNumber: 1, pendingToolCalls: [], nextToolIndex: 0 },
    generation: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
  store.transaction((tx) => tx.runs.insert(run));
  return run;
}

function seedAttempt(
  store: ReturnType<typeof createTestRuntime>["runtime"]["store"],
  overrides: Partial<AttemptRecord>,
): AttemptRecord {
  const attempt: AttemptRecord = {
    id: "attempt_old",
    runId: "run_old",
    conversationId: "conv_1",
    kind: "model",
    state: "dispatched",
    generation: 0,
    replayPolicy: "safe",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
  store.transaction((tx) => tx.attempts.insert(attempt));
  return attempt;
}

describe("RecoveryService", () => {
  it("creates a replacement attempt for a dispatched model attempt", async () => {
    const { runtime, backend } = createTestRuntime();
    const { conversationId } = await bootstrapConversation(runtime);
    seedRun(runtime.store, conversationId);
    seedAttempt(runtime.store, { conversationId, kind: "model" });

    const { runtime: recovered } = createRuntimeOnBackend(backend);
    const attempts = recovered.store.read((tx) => tx.attempts.listForRun("run_old"));
    expect(attempts.some((a) => a.state === "interrupted")).toBe(true);
    expect(attempts.some((a) => a.parentAttemptId === "attempt_old")).toBe(true);
  });

  it("creates a linked retry for a dispatched replay-safe tool", async () => {
    const { runtime, backend } = createTestRuntime();
    const { conversationId } = await bootstrapConversation(runtime);
    seedRun(runtime.store, conversationId, { phase: "execute_tools" });
    seedAttempt(runtime.store, { conversationId, kind: "tool", replayPolicy: "safe", toolName: "read" });

    const { runtime: recovered } = createRuntimeOnBackend(backend);
    const attempts = recovered.store.read((tx) => tx.attempts.listForRun("run_old"));
    expect(attempts.some((a) => a.state === "interrupted")).toBe(true);
    expect(attempts.some((a) => a.parentAttemptId === "attempt_old")).toBe(true);
  });

  it("marks a dispatched unsafe tool unknown and stops automatic mutation", async () => {
    const { runtime, backend } = createTestRuntime();
    const { conversationId } = await bootstrapConversation(runtime);
    seedRun(runtime.store, conversationId, { phase: "execute_tools" });
    seedAttempt(runtime.store, { conversationId, kind: "tool", replayPolicy: "unsafe", toolName: "bash" });

    const { runtime: recovered } = createRuntimeOnBackend(backend);
    const attempts = recovered.store.read((tx) => tx.attempts.listForRun("run_old"));
    const toolAttempt = attempts.find((a) => a.kind === "tool");
    expect(toolAttempt?.state).toBe("unknown");
    expect(toolAttempt?.errorCode).toBe("REMOTE_OUTCOME_UNKNOWN");
    expect(recovered.store.read((tx) => tx.runs.get("run_old"))?.state).toBe("needs_attention");
    expect(attempts.filter((a) => a.parentAttemptId)).toHaveLength(0);
  });

  it("continues cancellation handling for a cancelled run", async () => {
    const { runtime, backend } = createTestRuntime();
    const { conversationId } = await bootstrapConversation(runtime);
    seedRun(runtime.store, conversationId, { cancelRequestedAt: 5 });

    const { runtime: recovered } = createRuntimeOnBackend(backend);
    expect(recovered.store.read((tx) => tx.runs.get("run_old"))?.state).toBe("cancelled");
  });

  it("leaves a prepared attempt for normal dispatch", async () => {
    const { runtime, backend } = createTestRuntime();
    const { conversationId } = await bootstrapConversation(runtime);
    seedRun(runtime.store, conversationId);
    seedAttempt(runtime.store, { conversationId, state: "prepared" });

    const { runtime: recovered } = createRuntimeOnBackend(backend);
    const attempts = recovered.store.read((tx) => tx.attempts.listForRun("run_old"));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.state).toBe("prepared");
  });
});

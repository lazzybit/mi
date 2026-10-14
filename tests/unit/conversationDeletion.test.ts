import { describe, expect, it } from "vitest";
import { ConversationRepository } from "../../src/worker/storage/repositories";
import type { NodeSqlBackend } from "../helpers/nodeSql";
import { bootstrapConversation, createTestRuntime, envelope } from "../helpers/runtime";

function count(backend: NodeSqlBackend, table: string, where = "", ...bindings: unknown[]): number {
  const row = backend.db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`)
    .get(...(bindings as never[])) as { n: number };
  return Number(row.n);
}

function createConversation(runtime: ReturnType<typeof createTestRuntime>["runtime"], id: string) {
  runtime.store.transaction((tx) => {
    tx.conversations.create({ id, title: id, createdAt: 1, updatedAt: 1 });
  });
}

function seedRun(
  runtime: ReturnType<typeof createTestRuntime>["runtime"],
  input: { id: string; conversationId: string; state?: string; cancelRequestedAt?: number },
) {
  runtime.store.transaction((tx) => {
    tx.runs.insert({
      id: input.id,
      conversationId: input.conversationId,
      state: (input.state ?? "completed") as never,
      phase: "finish_turn",
      checkpoint: { phase: "finish_turn", turnNumber: 1, pendingToolCalls: [], nextToolIndex: 0 },
      generation: tx.ownerState.readDriverGeneration(),
      cancelRequestedAt: input.cancelRequestedAt,
      createdAt: 1,
      updatedAt: 1,
    });
  });
}

function seedAttempt(
  runtime: ReturnType<typeof createTestRuntime>["runtime"],
  input: {
    id: string;
    runId: string;
    conversationId: string;
    requestArtifactId?: string;
    resultArtifactId?: string;
    state?: string;
    toolName?: string;
  },
) {
  runtime.store.transaction((tx) => {
    tx.attempts.insert({
      id: input.id,
      runId: input.runId,
      conversationId: input.conversationId,
      kind: "model",
      state: (input.state ?? "succeeded") as never,
      generation: 0,
      replayPolicy: "safe",
      toolName: input.toolName,
      requestArtifactId: input.requestArtifactId,
      resultArtifactId: input.resultArtifactId,
      createdAt: 1,
      updatedAt: 1,
    });
  });
}

function seedArtifact(
  runtime: ReturnType<typeof createTestRuntime>["runtime"],
  id: string,
  content = "payload",
) {
  runtime.store.transaction((tx) => {
    tx.artifacts.create({
      id,
      mimeType: "application/json",
      encoding: "utf8",
      byteCount: 0,
      complete: false,
      createdAt: 1,
    });
    tx.artifacts.appendChunk(id, 0, content, content.length);
    tx.artifacts.complete(id, "digest");
  });
}

function captureSocket() {
  const frames: { type: string; changes?: { kind: string }[] }[] = [];
  return {
    frames,
    socket: {
      send: (data: string) => frames.push(JSON.parse(data)),
      close: () => {},
    },
  };
}

describe("conversation deletion", () => {
  it("removes every conversation-owned record and publishes the removal", async () => {
    const { runtime, backend } = createTestRuntime();
    const { conversationId } = await bootstrapConversation(runtime);
    seedRun(runtime, { id: "r1", conversationId });
    seedAttempt(runtime, { id: "a1", runId: "r1", conversationId, requestArtifactId: "req1", resultArtifactId: "res1" });
    seedArtifact(runtime, "req1");
    seedArtifact(runtime, "res1");
    runtime.store.transaction((tx) => {
      tx.entries.insert({
        id: "e1",
        conversationId,
        sequence: 1,
        kind: "tool_result",
        attemptId: "a1",
        artifactId: "att1",
        isError: false,
        createdAt: 1,
      });
      tx.submissions.insert({
        id: "s1",
        conversationId,
        commandId: "sub-cmd",
        mode: "queue",
        ownerSequence: 1,
        content: "hello",
        state: "accepted",
        runId: "r1",
        createdAt: 1,
      });
      tx.liveOutput.append("a1", "partial", 1);
      tx.contextSnapshots.insert({
        id: "ctx1",
        conversationId,
        runId: "r1",
        turnNumber: 1,
        modelProfileJson: "{}",
        skillVersionsJson: "[]",
        toolCatalogJson: "[]",
        systemSectionsJson: "[]",
        historyFirst: 1,
        historyLast: 1,
        digest: "d",
        createdAt: 1,
      });
      tx.attemptResolutions.insert({
        id: "res1-id",
        attemptId: "a1",
        action: "abandon",
        explanation: "x",
        evidenceJson: "[]",
        createdAt: 1,
      });
      tx.skills.selectForConversation(conversationId, []);
    });
    seedArtifact(runtime, "att1");

    const { frames, socket } = captureSocket();
    runtime.attachSocket({}, socket);

    const receipt = (await runtime.dispatch("deleteConversation", [
      envelope({ conversationId }),
    ])) as { result: unknown };
    expect(receipt.result).toBeUndefined();

    expect(count(backend, "conversations", "WHERE id = ?", conversationId)).toBe(0);
    expect(count(backend, "runs", "WHERE conversation_id = ?", conversationId)).toBe(0);
    expect(count(backend, "attempts", "WHERE conversation_id = ?", conversationId)).toBe(0);
    expect(count(backend, "entries", "WHERE conversation_id = ?", conversationId)).toBe(0);
    expect(count(backend, "submissions", "WHERE conversation_id = ?", conversationId)).toBe(0);
    expect(count(backend, "context_snapshots", "WHERE conversation_id = ?", conversationId)).toBe(0);
    expect(count(backend, "attempt_resolutions", "WHERE attempt_id = ?", "a1")).toBe(0);
    expect(count(backend, "live_output", "WHERE attempt_id = ?", "a1")).toBe(0);
    expect(count(backend, "artifacts", "WHERE id IN ('req1','res1','att1')")).toBe(0);

    const removal = frames.find((frame) =>
      frame.changes?.some((change) => change.kind === "conversation.remove"),
    );
    expect(removal).toBeDefined();
  });

  it("refuses deletion while any run is non-terminal, including pending cancellation", async () => {
    for (const state of ["queued", "running", "waiting_for_auth", "needs_attention"]) {
      const { runtime } = createTestRuntime();
      const { conversationId } = await bootstrapConversation(runtime);
      seedRun(runtime, { id: "r1", conversationId, state, cancelRequestedAt: 5 });
      await expect(
        runtime.dispatch("deleteConversation", [envelope({ conversationId })]),
      ).rejects.toMatchObject({ code: "CONFLICT", retryable: false });
      expect(runtime.store.readSnapshot(conversationId).selectedConversation).toBeDefined();
    }
  });

  it("returns NOT_FOUND for an unknown conversation", async () => {
    const { runtime } = createTestRuntime();
    await expect(
      runtime.dispatch("deleteConversation", [envelope({ conversationId: "missing" })]),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps a rejected deletion rejected after execution finishes", async () => {
    const { runtime } = createTestRuntime();
    const { conversationId } = await bootstrapConversation(runtime);
    seedRun(runtime, { id: "r1", conversationId, state: "queued" });
    const command = envelope({ conversationId });

    await expect(runtime.dispatch("deleteConversation", [command])).rejects.toMatchObject({
      code: "CONFLICT",
    });

    runtime.store.transaction((tx) => {
      const run = tx.runs.get("r1")!;
      run.state = "completed";
      tx.runs.update(run);
    });

    // The durable rejection is replayed instead of deleting later.
    await expect(runtime.dispatch("deleteConversation", [command])).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(runtime.store.readSnapshot(conversationId).selectedConversation).toBeDefined();
  });

  it("returns the accepted receipt when a successful deletion is replayed", async () => {
    const { runtime } = createTestRuntime();
    const { conversationId } = await bootstrapConversation(runtime);
    const command = envelope({ conversationId });

    await runtime.dispatch("deleteConversation", [command]);
    await expect(runtime.dispatch("deleteConversation", [command])).resolves.toBeDefined();
    expect(runtime.store.readSnapshot(conversationId).conversations).toHaveLength(0);
  });

  it("rejects a command id reused with a different payload or kind", async () => {
    const { runtime } = createTestRuntime();
    const { conversationId } = await bootstrapConversation(runtime);
    const command = envelope({ conversationId });
    await runtime.dispatch("deleteConversation", [command]);

    await expect(
      runtime.dispatch("deleteConversation", [
        { commandId: command.commandId, payload: { conversationId: "other" } },
      ]),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(
      runtime.dispatch("renameConversation", [
        { commandId: command.commandId, payload: { conversationId, title: "renamed" } },
      ]),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("preserves shared, referenced, and unattributable artifacts", async () => {
    const { runtime, backend } = createTestRuntime();
    const { conversationId } = await bootstrapConversation(runtime);
    createConversation(runtime, "c2");

    // Exclusive candidate.
    seedArtifact(runtime, "exclusive");
    // Shared with a surviving attempt in c2.
    seedArtifact(runtime, "shared");
    // Referenced by a surviving app__read_tool_result call.
    seedArtifact(runtime, "read-result");
    // Referenced by a surviving skill resource.
    seedArtifact(runtime, "skill-resource");
    // Referenced by a surviving repository instruction.
    seedArtifact(runtime, "repo-instruction");
    // Only named in resolution evidence; never a candidate.
    seedArtifact(runtime, "evidence-only");
    // No ownership link at all.
    seedArtifact(runtime, "orphan");

    seedRun(runtime, { id: "r1", conversationId });
    seedAttempt(runtime, {
      id: "a1",
      runId: "r1",
      conversationId,
      requestArtifactId: "exclusive",
    });
    seedAttempt(runtime, {
      id: "a2",
      runId: "r1",
      conversationId,
      requestArtifactId: "shared",
    });
    seedAttempt(runtime, {
      id: "a3",
      runId: "r1",
      conversationId,
      requestArtifactId: "read-result",
    });
    seedAttempt(runtime, {
      id: "a4",
      runId: "r1",
      conversationId,
      requestArtifactId: "skill-resource",
    });
    seedAttempt(runtime, {
      id: "a5",
      runId: "r1",
      conversationId,
      requestArtifactId: "repo-instruction",
    });

    // Surviving conversation c2 holds the shared attempt and the read_tool_result call.
    seedRun(runtime, { id: "r2", conversationId: "c2" });
    seedAttempt(runtime, {
      id: "b1",
      runId: "r2",
      conversationId: "c2",
      requestArtifactId: "shared",
    });
    runtime.store.transaction((tx) => {
      tx.entries.insert({
        id: "b-entry",
        conversationId: "c2",
        sequence: 1,
        kind: "assistant",
        metadataJson: JSON.stringify({
          toolCalls: [{ name: "app__read_tool_result", arguments: { artifactId: "read-result" } }],
        }),
        isError: false,
        createdAt: 1,
      });
      tx.skills.upsertSkill({
        id: "sk1",
        name: "skill",
        description: "d",
        enabled: true,
        deleted: false,
        currentVersion: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      tx.skills.insertVersion({
        skillId: "sk1",
        version: 1,
        name: "skill",
        description: "d",
        instructions: "i",
        createdAt: 1,
      });
      tx.skills.insertResource({
        skillId: "sk1",
        version: 1,
        path: "p",
        mediaType: "text/plain",
        artifactId: "skill-resource",
      });
      tx.repositoryInstructions.upsert({
        id: "ri1",
        workspaceRoot: "/w",
        path: "AGENTS.md",
        directory: "",
        artifactId: "repo-instruction",
        digest: "d",
        present: true,
        fetchedAt: 1,
      });
      tx.attemptResolutions.insert({
        id: "res-evidence",
        attemptId: "a1",
        action: "abandon",
        explanation: "x",
        evidenceJson: JSON.stringify(["evidence-only"]),
        createdAt: 1,
      });
    });

    await runtime.dispatch("deleteConversation", [envelope({ conversationId })]);

    expect(count(backend, "artifacts", "WHERE id = ?", "exclusive")).toBe(0);
    for (const id of ["shared", "read-result", "skill-resource", "repo-instruction", "evidence-only", "orphan"]) {
      expect(count(backend, "artifacts", "WHERE id = ?", id)).toBe(1);
    }
  });

  it("rolls back every removal when deletion fails mid-transaction", async () => {
    const { runtime, backend } = createTestRuntime();
    const { conversationId } = await bootstrapConversation(runtime);
    seedRun(runtime, { id: "r1", conversationId });
    seedAttempt(runtime, { id: "a1", runId: "r1", conversationId });

    const original = ConversationRepository.prototype.delete;
    ConversationRepository.prototype.delete = () => {
      throw new Error("boom");
    };
    try {
      await expect(
        runtime.dispatch("deleteConversation", [envelope({ conversationId })]),
      ).rejects.toThrow("boom");
    } finally {
      ConversationRepository.prototype.delete = original;
    }

    expect(count(backend, "conversations", "WHERE id = ?", conversationId)).toBe(1);
    expect(count(backend, "runs", "WHERE conversation_id = ?", conversationId)).toBe(1);
    expect(count(backend, "attempts", "WHERE conversation_id = ?", conversationId)).toBe(1);
  });
});

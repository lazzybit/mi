import { describe, expect, it } from "vitest";
import { AppError } from "../../src/shared/domain";
import { bootstrapConversation, createTestRuntime, envelope } from "../helpers/runtime";

describe("command idempotency", () => {
  it("returns the original receipt for a repeated commandId with the same payload", async () => {
    const { runtime } = createTestRuntime();
    await bootstrapConversation(runtime);
    const command = envelope({ title: "Once" });

    const first = (await runtime.dispatch("createConversation", [command])) as {
      result: { conversationId: string };
      revision: number;
    };
    const second = (await runtime.dispatch("createConversation", [command])) as {
      result: { conversationId: string };
      revision: number;
    };
    expect(second.result.conversationId).toBe(first.result.conversationId);
    expect(second.revision).toBe(first.revision);
    // bootstrapConversation created one; the repeated command must not create another.
    expect(runtime.store.readSnapshot().conversations).toHaveLength(2);
  });

  it("rejects a commandId reused with a different payload", async () => {
    const { runtime } = createTestRuntime();
    await bootstrapConversation(runtime);
    const command = envelope({ title: "First" });
    await runtime.dispatch("createConversation", [command]);

    await expect(
      runtime.dispatch("createConversation", [
        { commandId: command.commandId, payload: { title: "Second" } },
      ]),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("treats a lost acknowledgement as a duplicate, not a second submission", async () => {
    const { runtime, model } = createTestRuntime();
    const { conversationId } = await bootstrapConversation(runtime);
    model.pushText("answer");
    const command = envelope({ conversationId, text: "hello", mode: "queue" });

    const first = (await runtime.dispatch("submit", [command])) as { result: { submissionId: string } };
    const second = (await runtime.dispatch("submit", [command])) as { result: { submissionId: string } };
    expect(second.result.submissionId).toBe(first.result.submissionId);

    await runtime.alarm();
    const snapshot = runtime.store.readSnapshot(conversationId);
    const userEntries = snapshot.selectedConversation?.entries.filter((e) => e.kind === "user") ?? [];
    expect(userEntries).toHaveLength(1);
  });

  it("rejects an empty command envelope", async () => {
    const { runtime } = createTestRuntime();
    await expect(runtime.dispatch("createConversation", [{ payload: {} }])).rejects.toBeInstanceOf(
      AppError,
    );
  });
});

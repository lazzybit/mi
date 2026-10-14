import { describe, expect, it } from "vitest";
import { AppError, type OwnerSnapshot } from "../../src/shared/domain";
import { applyChanges } from "../../src/client/sync/ConversationReducer";
import { CommandOutbox } from "../../src/client/commands/CommandOutbox";
import { CommandDispatcher } from "../../src/client/commands/CommandDispatcher";
import { DraftStore } from "../../src/client/storage/DraftStore";

function snapshot(): OwnerSnapshot {
  return {
    revision: 0,
    conversations: [],
    configuration: { connectors: [], skills: [], settingsVersion: 0, missing: [] },
    selectedConversation: {
      conversation: { id: "c1", title: "One", createdAt: 1, updatedAt: 1 },
      entries: [],
      queuedInputs: [],
    },
  };
}

describe("ConversationReducer", () => {
  it("appends entries and upserts conversations", () => {
    const next = applyChanges(snapshot(), [
      {
        kind: "conversation.upsert",
        value: { id: "c1", title: "One", createdAt: 1, updatedAt: 2, queuedCount: 0 },
      },
      {
        kind: "entry.append",
        conversationId: "c1",
        value: { id: "e1", conversationId: "c1", sequence: 1, kind: "user", text: "hi", createdAt: 1 },
      },
    ]);
    expect(next.conversations[0]?.updatedAt).toBe(2);
    expect(next.selectedConversation?.entries[0]?.text).toBe("hi");
  });

  it("replaces the inbox and clears a terminal run", () => {
    const next = applyChanges(snapshot(), [
      {
        kind: "inbox.replace",
        conversationId: "c1",
        values: [
          {
            id: "s1",
            conversationId: "c1",
            mode: "queue",
            content: "later",
            state: "queued",
            ownerSequence: 1,
            createdAt: 1,
          },
        ],
      },
      {
        kind: "run.update",
        conversationId: "c1",
        value: {
          id: "r1",
          conversationId: "c1",
          state: "completed",
          phase: "finish_turn",
          turnNumber: 1,
          createdAt: 1,
          updatedAt: 2,
        },
      },
    ]);
    expect(next.selectedConversation?.queuedInputs).toHaveLength(1);
    expect(next.selectedConversation?.activeRun).toBeUndefined();
  });
});

describe("CommandOutbox and CommandDispatcher", () => {
  it("accepts once and clears the outbox", async () => {
    const outbox = new CommandOutbox();
    let calls = 0;
    const dispatcher = new CommandDispatcher(outbox, {
      "conversation.create": async (command) => {
        calls += 1;
        return { commandId: command.commandId, revision: 1, result: { conversationId: "c1" } };
      },
    });
    const command = dispatcher.newCommand("conversation.create", {});
    const result = await dispatcher.dispatch(command);
    expect(result.status).toBe("accepted");
    expect(calls).toBe(1);
    expect(await outbox.pending()).toHaveLength(0);
  });

  it("keeps a command pending after a transport failure so it can be resent", async () => {
    const outbox = new CommandOutbox();
    let attempts = 0;
    const dispatcher = new CommandDispatcher(outbox, {
      "submission.submit": async (command) => {
        attempts += 1;
        if (attempts === 1) throw new Error("network down");
        return { commandId: command.commandId, revision: 1, result: {} };
      },
    });
    const command = dispatcher.newCommand("submission.submit", { text: "hi" });
    const first = await dispatcher.dispatch(command);
    expect(first.status).toBe("retry");
    expect(await outbox.pending()).toHaveLength(1);

    // The same logical command id is resent through the current reference.
    const results = await dispatcher.flush();
    expect(results[0]?.status).toBe("accepted");
    expect(await outbox.pending()).toHaveLength(0);
  });

  it("drops a command on a definitive application rejection", async () => {
    const outbox = new CommandOutbox();
    const dispatcher = new CommandDispatcher(outbox, {
      "skill.create": async () => {
        throw new AppError("INVALID_INPUT", "bad skill");
      },
    });
    const command = dispatcher.newCommand("skill.create", {});
    const result = await dispatcher.dispatch(command);
    expect(result.status).toBe("rejected");
    expect(await outbox.pending()).toHaveLength(0);
  });

  it("keeps unauthenticated commands pending for a later login", async () => {
    const outbox = new CommandOutbox();
    const dispatcher = new CommandDispatcher(outbox, {
      "conversation.create": async () => {
        throw new AppError("UNAUTHENTICATED", "login required");
      },
    });
    const command = dispatcher.newCommand("conversation.create", {});
    const result = await dispatcher.dispatch(command);
    expect(result.status).toBe("retry");
    expect(await outbox.pending()).toHaveLength(1);
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

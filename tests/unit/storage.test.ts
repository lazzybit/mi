import { describe, expect, it } from "vitest";
import { SqlStore } from "../../src/worker/storage/SqlStore";
import { NodeSqlBackend } from "../helpers/nodeSql";

function newStore() {
  const backend = new NodeSqlBackend();
  const store = new SqlStore(backend);
  store.migrate();
  return { backend, store };
}

describe("SqlStore", () => {
  it("migrates from empty storage and records the schema version", () => {
    const { store } = newStore();
    const revision = store.read((tx) => tx.ownerState.read());
    expect(revision.schemaVersion).toBe(3);
    expect(revision.revision).toBe(0);
  });

  it("allocates a revision per transaction", () => {
    const { store } = newStore();
    const first = store.transaction(() => "a");
    const second = store.transaction(() => "b");
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
  });

  it("round-trips conversations, entries, and submissions", () => {
    const { store } = newStore();
    store.transaction((tx) => {
      tx.conversations.create({
        id: "c1",
        title: "First",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const sequence = tx.conversations.nextEntrySequence("c1");
      tx.entries.insert({
        id: "e1",
        conversationId: "c1",
        sequence,
        kind: "user",
        text: "hello",
        isError: false,
        createdAt: 1000,
      });
      tx.submissions.insert({
        id: "s1",
        conversationId: "c1",
        commandId: "cmd-1",
        mode: "queue",
        ownerSequence: tx.submissions.nextOwnerSequence(),
        content: "hello",
        state: "queued",
        createdAt: 1000,
      });
    });

    const snapshot = store.readSnapshot("c1");
    expect(snapshot.conversations).toHaveLength(1);
    expect(snapshot.selectedConversation?.entries[0]?.text).toBe("hello");
    expect(snapshot.selectedConversation?.queuedInputs[0]?.content).toBe("hello");
  });

  it("chunks artifacts and distinguishes partial from complete", () => {
    const { store } = newStore();
    store.transaction((tx) => {
      tx.artifacts.create({
        id: "a1",
        mimeType: "text/plain",
        encoding: "utf8",
        byteCount: 0,
        complete: false,
        createdAt: 1000,
      });
      tx.artifacts.appendChunk("a1", 0, "hello ", 6);
      tx.artifacts.appendChunk("a1", 1, "world", 5);
    });
    const partial = store.read((tx) => tx.artifacts.get("a1"));
    expect(partial?.complete).toBe(false);
    expect(partial?.byteCount).toBe(11);

    store.transaction((tx) => tx.artifacts.complete("a1", "digest"));
    const complete = store.read((tx) => tx.artifacts.get("a1"));
    expect(complete?.complete).toBe(true);
    const chunks = store.read((tx) => tx.artifacts.readChunks("a1"));
    expect(chunks.map((c) => c.data).join("")).toBe("hello world");
  });

  it("migrates a populated version-1 receipt table and is repeatable", () => {
    const backend = new NodeSqlBackend();
    backend.sql.exec(
      `CREATE TABLE command_receipts (
         command_id TEXT PRIMARY KEY,
         kind TEXT NOT NULL,
         payload_hash TEXT NOT NULL,
         result_json TEXT NOT NULL,
         revision INTEGER NOT NULL,
         created_at INTEGER NOT NULL
       )`,
    );
    backend.sql.exec(
      `INSERT INTO command_receipts (command_id, kind, payload_hash, result_json, revision, created_at)
       VALUES ('cmd-legacy', 'conversation.create', 'hash', '{}', 1, 1000)`,
    );
    const store = new SqlStore(backend);
    store.migrate();
    expect(store.read((tx) => tx.commands.find("cmd-legacy"))?.outcome).toBe("accepted");
    // A repeated migration is a no-op and preserves the row.
    store.migrate();
    expect(store.read((tx) => tx.commands.find("cmd-legacy"))?.outcome).toBe("accepted");
  });

  it("enforces command receipt idempotency at the storage level", () => {
    const { store } = newStore();
    store.transaction((tx) =>
      tx.commands.insert({
        commandId: "cmd-1",
        kind: "conversation.create",
        payloadHash: "hash-a",
        resultJson: JSON.stringify({ conversationId: "c1" }),
        revision: 1,
        outcome: "accepted",
        createdAt: 1000,
      }),
    );
    const found = store.read((tx) => tx.commands.find("cmd-1"));
    expect(found?.payloadHash).toBe("hash-a");

    expect(() =>
      store.transaction((tx) =>
        tx.commands.insert({
          commandId: "cmd-1",
          kind: "conversation.create",
          payloadHash: "hash-b",
          resultJson: "{}",
          revision: 2,
          outcome: "accepted",
          createdAt: 1001,
        }),
      ),
    ).toThrow();
  });
});

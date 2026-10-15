import { describe, expect, it } from "vitest";
import { SyncHub, type SyncSocket } from "../../src/worker/sync/SyncHub";
import type { Commit } from "../../src/worker/storage/SqlStore";
import type { OwnerSnapshot } from "../../src/shared/domain";
import { decodeServerFrame } from "../../src/shared/wire";

class FakeSocket implements SyncSocket {
  readonly messages: string[] = [];
  closed?: { code?: number; reason?: string };
  send(data: string): void {
    this.messages.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  frames() {
    return this.messages.map((message) => decodeServerFrame(message)!);
  }
}

function snapshot(revision: number): OwnerSnapshot {
  return {
    revision,
    conversations: [],
    configuration: { routes: [], connectors: [], skills: [], settingsVersion: 0, missing: [] },
  };
}

function commit(revision: number, changes: Commit<unknown>["changes"]): Commit<unknown> {
  return { value: undefined, revision, changes };
}

describe("SyncHub", () => {
  it("sends a sequence-zero snapshot synchronously on attach", () => {
    const hub = new SyncHub((selection) => snapshot(selection ? 5 : 0));
    const socket = new FakeSocket();
    hub.attach(socket, socket, "conv_1");
    const frames = socket.frames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "snapshot", sequence: 0 });
  });

  it("observes a commit during attachment exactly once", () => {
    let revision = 1;
    const hub = new SyncHub(() => snapshot(revision));
    const socket = new FakeSocket();
    hub.attach(socket, socket);
    revision = 2;
    hub.publish(
      commit(2, [
        {
          kind: "entry.append",
          conversationId: "conv_1",
          value: {
            id: "e1",
            conversationId: "conv_1",
            sequence: 1,
            kind: "user",
            createdAt: 1,
          },
        },
      ]),
    );
    const frames = socket.frames();
    expect(frames.map((f) => f.type)).toEqual(["snapshot", "changes"]);
    const changes = frames[1];
    if (!changes || changes.type !== "changes") throw new Error("expected a changes frame");
    expect(changes.sequence).toBe(1);
    expect(changes.changes).toHaveLength(1);
  });

  it("filters changes by selected conversation but keeps global changes", () => {
    const hub = new SyncHub(() => snapshot(0));
    const socket = new FakeSocket();
    hub.attach(socket, socket, "conv_1");
    hub.publish(
      commit(1, [
        {
          kind: "entry.append",
          conversationId: "conv_2",
          value: { id: "e1", conversationId: "conv_2", sequence: 1, kind: "user", createdAt: 1 },
        },
        {
          kind: "configuration.update",
          value: { routes: [], connectors: [], skills: [], settingsVersion: 1, missing: [] },
        },
      ]),
    );
    const frames = socket.frames();
    const changes = frames[1];
    if (!changes || changes.type !== "changes") throw new Error("expected a changes frame");
    expect(changes.changes).toHaveLength(1);
    expect(changes.changes[0]?.kind).toBe("configuration.update");
  });

  it("issues a fresh stream on resnapshot", () => {
    const hub = new SyncHub(() => snapshot(0));
    const socket = new FakeSocket();
    hub.attach(socket, socket);
    hub.resnapshot(socket);
    const frames = socket.frames();
    expect(frames).toHaveLength(2);
    expect(frames[0]?.streamId).not.toBe(frames[1]?.streamId);
    expect(frames[1]).toMatchObject({ type: "snapshot", sequence: 0 });
  });

  it("re-registers surviving sockets with a fresh stream after reconstruction", () => {
    const hub = new SyncHub(() => snapshot(0));
    const socket = new FakeSocket();
    hub.restore([{ key: socket, socket, authExpiresAt: Number.POSITIVE_INFINITY }]);
    expect(hub.connectionCount()).toBe(1);
    expect(socket.frames()[0]).toMatchObject({ type: "snapshot", sequence: 0 });
  });

  it("closes a socket whose authentication expired", () => {
    const hub = new SyncHub(() => snapshot(0));
    const socket = new FakeSocket();
    hub.attach(socket, socket, undefined, Date.now() - 1);
    hub.publish(commit(1, [{ kind: "configuration.update", value: { routes: [], connectors: [], skills: [], settingsVersion: 1, missing: [] } }]));
    expect(socket.closed?.code).toBe(4401);
    expect(hub.connectionCount()).toBe(0);
  });

  it("detaching an observer does not affect other observers", () => {
    const hub = new SyncHub(() => snapshot(0));
    const first = new FakeSocket();
    const second = new FakeSocket();
    hub.attach(first, first);
    hub.attach(second, second);
    hub.detach(first);
    expect(hub.connectionCount()).toBe(1);
  });
});

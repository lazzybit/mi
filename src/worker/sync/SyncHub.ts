// Synchronization hub (PLAN.md -> Synchronization).
//
// `attach()` registers the subscription and reads its bounded snapshot
// synchronously, with no intervening `await`; that is the snapshot/subscription
// boundary. Each connection receives a fresh streamId and a sequence-zero
// snapshot; subsequent frames increment an in-memory sequence.

import type { ConversationId, OwnerSnapshot } from "../../shared/domain";
import type { ViewChange } from "../../shared/wire";
import { encodeFrame } from "../../shared/wire";
import type { Commit } from "../storage/SqlStore";

export interface SyncSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface Connection {
  socket: SyncSocket;
  streamId: string;
  sequence: number;
  selection?: ConversationId;
  authExpiresAt: number;
}

export interface SnapshotReader {
  (conversationId?: ConversationId): OwnerSnapshot;
}

export class SyncHub {
  private readonly connections = new Map<object, Connection>();
  private streamCounter = 0;

  constructor(private readonly readSnapshot: SnapshotReader) {}

  attach(
    key: object,
    socket: SyncSocket,
    selection?: ConversationId,
    authExpiresAt = Number.POSITIVE_INFINITY,
  ): OwnerSnapshot {
    const streamId = this.nextStreamId();
    // Synchronous bounded snapshot with no intervening await.
    const snapshot = this.readSnapshot(selection);
    const connection: Connection = { socket, streamId, sequence: 0, selection, authExpiresAt };
    this.connections.set(key, connection);
    this.send(connection, {
      type: "snapshot",
      streamId,
      sequence: 0,
      value: snapshot,
    });
    return snapshot;
  }

  detach(key: object): void {
    this.connections.delete(key);
  }

  /** Change a connection's conversation selection and send a fresh snapshot. */
  subscribe(key: object, selection?: ConversationId): void {
    const connection = this.connections.get(key);
    if (!connection) return;
    connection.selection = selection;
    this.resnapshot(key);
  }

  publish(commit: Commit<unknown>): void {
    if (commit.changes.length === 0) return;
    for (const [key, connection] of [...this.connections]) {
      if (this.expired(connection)) {
        this.connections.delete(key);
        try {
          connection.socket.close(4401, "authentication expired");
        } catch {
          /* ignore */
        }
        continue;
      }
      const changes = commit.changes.filter((change) => this.matches(connection.selection, change));
      if (changes.length === 0) continue;
      connection.sequence += 1;
      this.send(connection, {
        type: "changes",
        streamId: connection.streamId,
        sequence: connection.sequence,
        revision: commit.revision,
        changes,
      });
    }
  }

  resnapshot(key: object): void {
    const connection = this.connections.get(key);
    if (!connection) return;
    if (this.expired(connection)) {
      this.connections.delete(key);
      try {
        connection.socket.close(4401, "authentication expired");
      } catch {
        /* ignore */
      }
      return;
    }
    connection.streamId = this.nextStreamId();
    connection.sequence = 0;
    this.send(connection, {
      type: "snapshot",
      streamId: connection.streamId,
      sequence: 0,
      value: this.readSnapshot(connection.selection),
    });
  }

  /** Re-register surviving sockets after reconstruction with a fresh stream. */
  restore(
    entries: { key: object; socket: SyncSocket; selection?: ConversationId; authExpiresAt: number }[],
  ): void {
    for (const entry of entries) {
      this.attach(entry.key, entry.socket, entry.selection, entry.authExpiresAt);
    }
  }

  connectionCount(): number {
    return this.connections.size;
  }

  private send(connection: Connection, frame: Parameters<typeof encodeFrame>[0]): void {
    try {
      connection.socket.send(encodeFrame(frame));
    } catch {
      // Slow client: replace with a fresh snapshot; if that also fails, drop it.
      try {
        connection.streamId = this.nextStreamId();
        connection.sequence = 0;
        connection.socket.send(
          encodeFrame({
            type: "snapshot",
            streamId: connection.streamId,
            sequence: 0,
            value: this.readSnapshot(connection.selection),
          }),
        );
      } catch {
        this.connections.delete([...this.connections.entries()].find(([, c]) => c === connection)?.[0] as object);
        try {
          connection.socket.close(1011, "slow consumer");
        } catch {
          /* ignore */
        }
      }
    }
  }

  private expired(connection: Connection): boolean {
    return Date.now() >= connection.authExpiresAt;
  }

  private matches(selection: ConversationId | undefined, change: ViewChange): boolean {
    if (!selection) return true;
    switch (change.kind) {
      case "conversation.upsert":
      case "conversation.remove":
      case "configuration.update":
        return true;
      default:
        return change.conversationId === selection;
    }
  }

  private nextStreamId(): string {
    this.streamCounter += 1;
    return `stream_${this.streamCounter}`;
  }
}

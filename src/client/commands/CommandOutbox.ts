// Durable client outbox (PLAN.md -> Client). Stores the logical command kind,
// payload, command id, and schema version — never generated server-function
// URLs or build ids — so a stale bundle can resend the same logical command
// through the current function reference.

export const OUTBOX_SCHEMA_VERSION = 1;

export type PendingCommandState = "local_pending" | "sending" | "accepted" | "rejected";

export interface PendingCommand {
  commandId: string;
  kind: string;
  payload: unknown;
  schemaVersion: number;
  createdAt: number;
  state: PendingCommandState;
}

const STORE = "commands";
const DB_NAME = "mi-outbox";

export class CommandOutbox {
  private db?: IDBDatabase;
  private readonly memory = new Map<string, PendingCommand>();

  async open(): Promise<void> {
    if (typeof indexedDB === "undefined") return;
    try {
      this.db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, OUTBOX_SCHEMA_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "commandId" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } catch {
      this.db = undefined;
    }
  }

  async enqueue(command: PendingCommand): Promise<void> {
    if (!this.db) {
      this.memory.set(command.commandId, command);
      return;
    }
    await this.tx("readwrite", (store) => store.put(command));
  }

  async acknowledge(commandId: string): Promise<void> {
    if (!this.db) {
      this.memory.delete(commandId);
      return;
    }
    await this.tx("readwrite", (store) => store.delete(commandId));
  }

  async reject(commandId: string): Promise<void> {
    await this.acknowledge(commandId);
  }

  async pending(): Promise<PendingCommand[]> {
    if (!this.db) {
      return [...this.memory.values()].sort((a, b) => a.createdAt - b.createdAt);
    }
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(STORE, "readonly");
      const request = transaction.objectStore(STORE).getAll();
      request.onsuccess = () => resolve((request.result as PendingCommand[]).sort((a, b) => a.createdAt - b.createdAt));
      request.onerror = () => reject(request.error);
    });
  }

  private tx(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(STORE, mode);
      operation(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }
}

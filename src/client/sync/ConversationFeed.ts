// The browser WebSocket client (PLAN.md -> Client -> ConversationFeed).
// Receives a complete snapshot first, applies every subsequent change frame
// through the reducer, keeps connection status separate from conversation
// values, requests a new snapshot after a stream-sequence gap, and preserves
// the last committed view during reconnect.

import type { ConversationId, OwnerSnapshot } from "../../shared/domain";
import { decodeServerFrame, type ClientFrame, type ServerFrame } from "../../shared/wire";
import { applyChanges } from "./ConversationReducer";

export type ConnectionStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "authentication_required"
  | "offline";

export interface ConversationViewSource {
  values(): AsyncIterable<OwnerSnapshot>;
  select(conversationId?: ConversationId): void;
  reconnect(): void;
  dispose(): void;
}

export class ConversationFeed implements ConversationViewSource {
  private socket?: WebSocket;
  private snapshot?: OwnerSnapshot;
  private streamId?: string;
  private sequence = 0;
  private selection?: ConversationId;
  private status: ConnectionStatus = "connecting";
  private disposed = false;
  private listening = false;
  private retry = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private readonly valueListeners = new Set<(snapshot: OwnerSnapshot) => void>();
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly pendingValues: ((snapshot: OwnerSnapshot) => void)[] = [];

  constructor(private readonly url: string) {}

  get current(): OwnerSnapshot | undefined {
    return this.snapshot;
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  connect(): void {
    if (this.disposed) return;
    this.listenForNetwork();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.setStatus(this.retry === 0 ? "connecting" : "reconnecting");
    const url = new URL(this.url, globalThis.location?.origin ?? "http://localhost");
    if (this.selection) url.searchParams.set("conversationId", this.selection);
    const socket = new WebSocket(url.toString());
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.retry = 0;
      this.setStatus("live");
      this.send({ type: "subscribe", conversationId: this.selection });
    });
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("close", (event) => this.onClose(socket, event.code));
    socket.addEventListener("error", () => this.onClose(socket, undefined));
  }

  select(conversationId?: ConversationId): void {
    this.selection = conversationId;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.send({ type: "subscribe", conversationId });
    }
  }

  reconnect(): void {
    this.socket?.close();
    this.connect();
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopNetworkListeners();
    this.socket?.close();
  }

  subscribe(listener: (snapshot: OwnerSnapshot) => void): () => void {
    this.valueListeners.add(listener);
    if (this.snapshot) listener(this.snapshot);
    return () => this.valueListeners.delete(listener);
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  async *values(): AsyncIterable<OwnerSnapshot> {
    if (this.snapshot) yield this.snapshot;
    for (;;) {
      const next = await new Promise<OwnerSnapshot>((resolve) => this.pendingValues.push(resolve));
      yield next;
    }
  }

  private onMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    const frame = decodeServerFrame(raw);
    if (!frame) return;
    if (frame.type === "snapshot") {
      this.streamId = frame.streamId;
      this.sequence = 0;
      this.emit(frame.value);
      return;
    }
    // A gap in the stream sequence means frames were missed; request a fresh
    // snapshot rather than applying a partial change set.
    if (frame.streamId !== this.streamId || frame.sequence !== this.sequence + 1) {
      this.send({ type: "resnapshot" });
      return;
    }
    this.sequence = frame.sequence;
    if (this.snapshot) this.emit(applyChanges(this.snapshot, frame.changes));
  }

  private onClose(socket: WebSocket, code?: number): void {
    // Ignore events from a socket that has already been replaced.
    if (this.disposed || this.socket !== socket) return;
    if (code === 4401) {
      this.setStatus("authentication_required");
      return;
    }
    // A dropped connection while the browser reports no network is not a
    // reconnect attempt; keep the distinct offline state.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      this.setStatus("offline");
      return;
    }
    this.setStatus("reconnecting");
    const delay = Math.min(1000 * 2 ** this.retry, 15_000);
    this.retry += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private emit(snapshot: OwnerSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.valueListeners) listener(snapshot);
    const pending = this.pendingValues.splice(0);
    for (const resolve of pending) resolve(snapshot);
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private readonly handleOffline = (): void => {
    if (this.disposed) return;
    this.setStatus("offline");
  };

  private readonly handleOnline = (): void => {
    if (this.disposed) return;
    this.retry = 0;
    const stale = this.socket;
    this.connect();
    stale?.close();
  };

  private listenForNetwork(): void {
    if (this.listening || typeof globalThis.addEventListener !== "function") return;
    this.listening = true;
    globalThis.addEventListener("offline", this.handleOffline);
    globalThis.addEventListener("online", this.handleOnline);
  }

  private stopNetworkListeners(): void {
    if (!this.listening) return;
    this.listening = false;
    if (typeof globalThis.removeEventListener === "function") {
      globalThis.removeEventListener("offline", this.handleOffline);
      globalThis.removeEventListener("online", this.handleOnline);
    }
  }

  private send(frame: ClientFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }
}

export type { ServerFrame };

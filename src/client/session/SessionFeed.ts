// Browser session socket (ADR-0003, ADR-0004).
//
// One socket observes one managed conversation. The server sends the current
// pi-durable view first and then the exact Chord operations of each commit;
// the client applies them with `applyImmutable`. A reconnect always acquires a
// fresh view, so no operation is ever replayed.

import { applyImmutable } from "@earendil-works/chord/delta";
import type { ConversationView, Cursor, EntryId, EntryRecord, SubmissionId } from "@earendil-works/pi-durable";
import { AppError } from "../../shared/domain";
import {
  decodeSessionServerFrame,
  encodeSessionFrame,
  type SessionClientFrame,
} from "../../shared/session-wire";

export type ConnectionStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "offline";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export class SessionFeed {
  private socket?: WebSocket;
  private conversationId?: string;
  private value?: ConversationView;
  private status: ConnectionStatus = "connecting";
  private disposed = false;
  private retry = 0;
  private selectionGeneration = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly valueListeners = new Set<(value: ConversationView) => void>();
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly noticeListeners = new Set<(notice: { code: string; message: string }) => void>();

  get current(): ConversationView | undefined {
    return this.value;
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  /** Synchronous selection generation, so a caller can pin a submission. */
  get generation(): number {
    return this.selectionGeneration;
  }

  /** Observe a conversation, or stop observing when `id` is undefined. */
  select(conversationId?: string): void {
    if (this.conversationId === conversationId) return;
    this.conversationId = conversationId;
    this.selectionGeneration += 1;
    this.value = undefined;
    this.failPending(new AppError("NOT_READY", "conversation selection changed", true));
    this.socket?.close();
    this.socket = undefined;
    if (conversationId) this.connect();
    else this.setStatus("connecting");
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopNetworkListeners();
    this.socket?.close();
    this.failPending(new AppError("NOT_READY", "session feed disposed", true));
  }

  /** Drop the current socket and acquire a fresh watch immediately. */
  reconnect(): void {
    if (this.disposed || !this.conversationId) return;
    this.socket?.close();
    this.socket = undefined;
    this.retry = 0;
    this.connect();
  }

  subscribe(listener: (value: ConversationView) => void): () => void {
    this.valueListeners.add(listener);
    if (this.value) listener(this.value);
    return () => this.valueListeners.delete(listener);
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  onNotice(listener: (notice: { code: string; message: string }) => void): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }

  /** Resolve when the socket is live; used to replay pending submissions. */
  whenLive(): Promise<void> {
    if (this.status === "live") return Promise.resolve();
    return new Promise((resolve) => {
      const unsubscribe = this.onStatus((status) => {
        if (status === "live") {
          unsubscribe();
          resolve();
        }
      });
    });
  }

  async submit(
    requestId: string,
    text: string,
    whenBusy: "followUp" | "steer",
    expected?: { conversationId?: string; generation: number },
  ): Promise<SubmissionId> {
    // Reject a submission pinned to a conversation or socket that is no longer
    // selected, so one conversation's pending text never reaches another.
    if (
      expected &&
      (this.selectionGeneration !== expected.generation ||
        this.conversationId !== expected.conversationId)
    ) {
      throw new AppError("NOT_READY", "conversation selection changed", true);
    }
    const result = (await this.request({
      type: "submit",
      requestId,
      text,
      whenBusy,
    })) as { submissionId: SubmissionId };
    return result.submissionId;
  }

  async withdraw(requestId: string, submissionId: SubmissionId): Promise<void> {
    await this.request({ type: "withdraw", requestId, submissionId });
  }

  async abort(requestId: string): Promise<void> {
    await this.request({ type: "abort", requestId });
  }

  async history(
    requestId: string,
    before: EntryId | undefined,
    cursor: Cursor | undefined,
    limit: number,
  ): Promise<{ entries: EntryRecord[]; next?: Cursor }> {
    return (await this.request({ type: "history", requestId, before, cursor, limit })) as {
      entries: EntryRecord[];
      next?: Cursor;
    };
  }

  // -------------------------------------------------------------------------

  private connect(): void {
    if (this.disposed || !this.conversationId) return;
    this.listenForNetwork();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.setStatus(this.retry === 0 ? "connecting" : "reconnecting");
    const url = new URL("/ws", globalThis.location?.origin ?? "http://localhost");
    url.searchParams.set("conversationId", this.conversationId);
    const socket = new WebSocket(url.toString());
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.retry = 0;
      this.setStatus("live");
    });
    socket.addEventListener("message", (event) => this.onMessage(socket, event.data));
    socket.addEventListener("close", () => this.onClose(socket));
    socket.addEventListener("error", () => this.onClose(socket));
  }

  private onMessage(socket: WebSocket, raw: unknown): void {
    if (this.socket !== socket) return;
    if (typeof raw !== "string") return;
    const frame = decodeSessionServerFrame(raw);
    if (!frame) return;
    switch (frame.type) {
      case "view":
        this.value = frame.value;
        this.emit(frame.value);
        return;
      case "ops":
        if (!this.value) return;
        this.value = applyImmutable(this.value, frame.ops);
        this.emit(this.value);
        return;
      case "submitted":
        this.resolve(frame.requestId, { submissionId: frame.submissionId });
        return;
      case "result":
        this.resolve(frame.requestId, frame.value);
        return;
      case "history":
        this.resolve(frame.requestId, { entries: frame.entries, next: frame.next });
        return;
      case "notice":
        this.emitNotice({ code: frame.code, message: frame.message });
        return;
      case "error":
        if (frame.requestId) {
          this.reject(frame.requestId, new AppError("INVALID_INPUT", frame.message));
        } else {
          this.emitNotice({ code: frame.code, message: frame.message });
        }
        return;
    }
  }

  private onClose(socket: WebSocket): void {
    if (this.disposed || this.socket !== socket) return;
    this.failPending(new AppError("NOT_READY", "session socket closed", true));
    // ADR-0004: socket closure, including close code 4401, follows ordinary
    // connection handling. mi does not acquire or renew credentials.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      this.setStatus("offline");
      return;
    }
    this.setStatus("reconnecting");
    const delay = Math.min(1000 * 2 ** this.retry, 15_000);
    this.retry += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private request(frame: SessionClientFrame): Promise<unknown> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new AppError("NOT_READY", "session socket is not connected", true));
    }
    if (this.pending.has(frame.requestId)) {
      return Promise.reject(new AppError("CONFLICT", "request is already in flight"));
    }
    return new Promise((resolve, reject) => {
      this.pending.set(frame.requestId, { resolve, reject });
      try {
        this.socket!.send(encodeSessionFrame(frame));
      } catch (error) {
        this.pending.delete(frame.requestId);
        reject(error);
      }
    });
  }

  private resolve(requestId: string, value: unknown): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    pending.resolve(value);
  }

  private reject(requestId: string, error: unknown): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    pending.reject(error);
  }

  private failPending(error: unknown): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) entry.reject(error);
  }

  private emit(value: ConversationView): void {
    for (const listener of this.valueListeners) listener(value);
  }

  private emitNotice(notice: { code: string; message: string }): void {
    for (const listener of this.noticeListeners) listener(notice);
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
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

  private listening = false;
}

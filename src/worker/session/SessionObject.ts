// One pi-durable session per managed mi conversation (ADR-0003).
//
// The session owns its transcript, submissions, tasks, retries, compaction,
// and live state over one SQLite-backed Durable Object storage. The Worker
// derives its address from the verified owner and the managed conversation id,
// so this object never decides ownership on its own.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel, MutableModels } from "@earendil-works/pi-ai";
import {
  Harness,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  UserEntry,
  createRegistry,
  type Conversation,
  type ConversationWatch,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { AppError } from "../../shared/domain";
import {
  decodeSessionClientFrame,
  encodeSessionFrame,
  type SessionClientFrame,
  type SessionServerFrame,
} from "../../shared/session-wire";
import { createGatewayModels, gatewayModelRef, registerGatewayProvider, resolveRouteById } from "../models";
import { CatalogStore } from "../owner/CatalogStore";

const HOST_MARKER = "mi.host";
const ADDRESS_SEPARATOR = "::";

interface HostMarker {
  ownerKey: string;
  conversationId: string;
  initializedAt: number;
}

interface SocketAttachment {
  authExpiresAt: number;
}

/** `ownerKey::conversationId`, the deterministic session address. */
export function sessionAddress(ownerKey: string, conversationId: string): string {
  return `${ownerKey}${ADDRESS_SEPARATOR}${conversationId}`;
}

function parseAddress(name: string | undefined): { ownerKey: string; conversationId: string } {
  if (!name) throw new AppError("INVALID_INPUT", "session address is missing");
  const index = name.lastIndexOf(ADDRESS_SEPARATOR);
  if (index <= 0) throw new AppError("INVALID_INPUT", "session address is malformed");
  return { ownerKey: name.slice(0, index), conversationId: name.slice(index + ADDRESS_SEPARATOR.length) };
}

/**
 * Durable Object class for one managed session. It deliberately avoids a
 * `cloudflare:workers` import so the Solid shell prerender can import the
 * built server bundle in Node.
 *
 * Lifecycle (provision, open, admit, delete) is serialized through one async
 * mutex; the deletion admission flag is set synchronously so queued ordinary
 * work cannot enter after a deletion is requested. Model execution and long
 * abort waits run outside the mutex.
 */
export class SessionObject {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  private ownerKey = "";
  private conversationId = "";
  private readonly instanceId = crypto.randomUUID();
  private readonly ready: Promise<void>;
  private readonly sockets = new Set<WebSocket>();

  private harness?: Harness;
  private root?: Conversation;
  private models?: MutableModels;
  private settingsKey?: string;
  private watch?: ConversationWatch;
  private watchTask?: Promise<ConversationWatch>;
  private initialized = false;
  private deleting = false;
  private deleted = false;
  private markerError?: AppError;
  private addressError?: AppError;
  private mutex: Promise<unknown> = Promise.resolve();
  private deleteTask?: Promise<void>;

  // Fixture-only hooks, honored only when the fixture model URL is configured.
  private fixtureOpenDelayMs = 0;
  private fixtureCloseFailure = false;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    try {
      const address = parseAddress(ctx.id.name);
      this.ownerKey = address.ownerKey;
      this.conversationId = address.conversationId;
    } catch (error) {
      // A named id is required; a malformed address must not silently fall
      // back to any owner.
      this.addressError =
        error instanceof AppError ? error : new AppError("INVALID_INPUT", "session address is malformed");
    }
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const marker = await ctx.storage.get<HostMarker>(HOST_MARKER);
      if (!marker) return;
      if (marker.ownerKey !== this.ownerKey || marker.conversationId !== this.conversationId) {
        this.markerError = new AppError("CONFLICT", "session storage does not match its address");
        return;
      }
      this.initialized = true;
    });
  }

  /** Serialize lifecycle transitions without holding a lock across execution. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(fn, fn);
    this.mutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);
    try {
      if (this.addressError) throw this.addressError;
      if (this.markerError) throw this.markerError;
      const auth = this.assertOwner(request);
      if (isFixtureMode(this.env)) {
        this.fixtureOpenDelayMs = readHeaderNumber(request, "x-mi-fixture-open-delay-ms");
        this.fixtureCloseFailure = request.headers.get("x-mi-fixture-close-failure") === "1";
      }
      switch (url.pathname) {
        case "/provision":
          if (request.method !== "POST") return methodNotAllowed();
          await this.provision();
          return Response.json({ ok: true });
        case "/delete":
          if (request.method !== "POST") return methodNotAllowed();
          await this.deleteSession();
          return Response.json({ ok: true });
        case "/ws":
          return await this.handleWebSocket(request, auth.authExpiresAt);
        case "/health":
          return Response.json({ ok: true, initialized: this.initialized });
        case "/__fixture/evict":
          return await this.handleFixtureEvict();
        case "/__fixture/state":
          return await this.handleFixtureState();
        case "/__fixture/seed":
          return await this.handleFixtureSeed(request);
        default:
          return new Response("not found", { status: 404 });
      }
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError("INVALID_INPUT", messageOf(error));
      return Response.json({ error: appError.toApiError() }, { status: statusFor(appError) });
    } finally {
      this.fixtureOpenDelayMs = 0;
      this.fixtureCloseFailure = false;
    }
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const attachment = readAttachment(socket);
    if (!attachment || attachment.authExpiresAt <= Date.now()) {
      closeSocket(socket, 4401, "authentication expired");
      this.sockets.delete(socket);
      return;
    }
    const frame = decodeSessionClientFrame(message);
    if (!frame) {
      this.send(socket, { type: "error", code: "INVALID_INPUT", message: "invalid session frame" });
      return;
    }
    try {
      await this.handleControl(socket, frame);
    } catch (error) {
      this.send(socket, {
        type: "error",
        requestId: frame.requestId,
        code: error instanceof AppError ? error.code : "INVALID_INPUT",
        message: messageOf(error),
      });
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    await this.detachSocket(socket);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.detachSocket(socket);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Explicit provisioning: the only path that may initialize empty storage. */
  private provision(): Promise<void> {
    return this.exclusive(async () => {
      if (this.deleted || this.deleting) throw new AppError("CONFLICT", "session is being deleted");
      // Recheck catalog eligibility on every request, including idempotent
      // returns, so a stale session cannot stay addressable after deletion.
      const row = await this.catalogRow();
      if (!row || row.lifecycle !== "active") {
        throw new AppError("CONFLICT", "conversation is not active");
      }
      if (this.initialized && this.harness && this.root) return;
      await this.doOpen(true);
      await this.ctx.storage.put<HostMarker>(HOST_MARKER, {
        ownerKey: this.ownerKey,
        conversationId: this.conversationId,
        initializedAt: Date.now(),
      });
      this.initialized = true;
    });
  }

  /**
   * Quiesce, dispose observation, stop execution, await closure, and erase the
   * session storage. Idempotent so the catalog's deletion sequence can resume.
   * A closure failure is never swallowed: storage is only erased once the
   * harness has closed.
   */
  private deleteSession(): Promise<void> {
    if (this.deleteTask) return this.deleteTask;
    // Synchronous admission gate: queued ordinary work must not enter.
    this.deleting = true;
    const closeFailure = this.fixtureCloseFailure;
    this.deleteTask = this.exclusive(async () => {
      if (this.deleted) return;
      this.initialized = false;
      this.closeSockets(1001, "conversation deleted");
      await this.stopWatch();
      if (closeFailure) {
        throw new Error("fixture: harness close failed");
      }
      if (this.harness) {
        // Keep the harness reference until close succeeds, so a retry resumes
        // rather than erasing storage under a live harness.
        await this.harness.close(BACKGROUND_CONTEXT);
        this.harness = undefined;
        this.root = undefined;
      }
      await this.ctx.storage.deleteAll();
      this.deleted = true;
    }).catch((error) => {
      this.deleteTask = undefined;
      throw error;
    });
    return this.deleteTask;
  }

  private async doOpen(forProvision: boolean): Promise<void> {
    if (this.harness && this.root) return;
    if (this.deleted || this.deleting) throw new AppError("CONFLICT", "session is being deleted");
    if (this.fixtureOpenDelayMs > 0) {
      await scheduler.wait(this.fixtureOpenDelayMs);
    }

    const settings = await new CatalogStore(this.env.DB).readSettings(this.ownerKey);
    const storage = await openDurableObjectSqliteStorage(this.ctx.storage);
    const models = createGatewayModels(this.env, { settings });
    let harness: Harness;
    try {
      harness = await Harness.open(
        storage,
        {
          models,
          registry: createRegistry(),
          settings: { stream: { maxRetries: 0 } },
        },
        BACKGROUND_CONTEXT,
      );
    } catch (error) {
      try {
        await storage.close(BACKGROUND_CONTEXT);
      } catch {
        // Best effort; the storage handle is discarded either way.
      }
      throw error;
    }

    try {
      let root = await harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
      if (!root) {
        // Ordinary reads, reconnects, and delayed requests cannot create a
        // missing session (ADR-0003).
        if (!forProvision) {
          await harness.close(BACKGROUND_CONTEXT);
          throw new AppError("NOT_READY", "session is not initialized", true);
        }
        root = await harness.root(BACKGROUND_CONTEXT, {
          agent: { model: gatewayModelRef(settings), thinkingLevel: thinkingLevel(settings) },
        });
      }
      // Reconcile the persisted agent with current settings before resuming,
      // so work recovered after a restart uses the configured model.
      await root.configure(
        { model: gatewayModelRef(settings), thinkingLevel: thinkingLevel(settings) ?? null },
        BACKGROUND_CONTEXT,
      );
      this.settingsKey = JSON.stringify(settings ?? null);
      harness.resume();
      this.harness = harness;
      this.root = root;
      this.models = models;
    } catch (error) {
      try {
        await harness.close(BACKGROUND_CONTEXT);
      } catch {
        // Best effort; a failed open is retried on the next request.
      }
      throw error;
    }
  }

  private async catalogRow(): Promise<{ lifecycle: string } | undefined> {
    const row = await this.env.DB.prepare(
      `SELECT lifecycle FROM conversations WHERE id = ? AND owner_key = ?`,
    )
      .bind(this.conversationId, this.ownerKey)
      .first<{ lifecycle: string }>();
    return row ?? undefined;
  }

  /**
   * Apply saved model settings at the next request boundary. Re-registering the
   * provider changes the resolved model metadata; `configure` updates the
   * conversation's agent. An in-flight request keeps the model it was prepared
   * with.
   */
  private async syncSettings(root: Conversation): Promise<void> {
    const settings = await new CatalogStore(this.env.DB).readSettings(this.ownerKey);
    const key = JSON.stringify(settings ?? null);
    if (key === this.settingsKey) return;
    if (this.models) registerGatewayProvider(this.models, this.env, { settings });
    await root.configure(
      { model: gatewayModelRef(settings), thinkingLevel: thinkingLevel(settings) ?? null },
      BACKGROUND_CONTEXT,
    );
    // Record only after the change is durably applied.
    this.settingsKey = key;
  }

  /** Open (or confirm) the harness. Must be called while holding the mutex. */
  private async requireOpenLocked(): Promise<{ harness: Harness; root: Conversation }> {
    if (this.deleted || this.deleting) throw new AppError("CONFLICT", "session is being deleted");
    if (!this.initialized) throw new AppError("NOT_READY", "session is not initialized", true);
    if (this.harness && this.root) return { harness: this.harness, root: this.root };
    // Enforce catalog eligibility when reopening, so an object restarted during
    // a pending deletion cannot resume work.
    const row = await this.catalogRow();
    if (!row || row.lifecycle !== "active") {
      throw new AppError("CONFLICT", "conversation is not active");
    }
    await this.doOpen(false);
    if (!this.harness || !this.root) throw new AppError("NOT_READY", "session is not initialized", true);
    return { harness: this.harness, root: this.root };
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  private async handleWebSocket(request: Request, authExpiresAt: number): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const watch = await this.exclusive(async () => {
      const { root } = await this.requireOpenLocked();
      if (this.deleting || this.deleted) throw new AppError("CONFLICT", "session is being deleted");
      return this.ensureWatchLocked(root);
    });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ authExpiresAt } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(server);
    this.sockets.add(server);
    this.send(server, { type: "view", value: watch.value });
    return new Response(null, { status: 101, webSocket: client });
  }

  private ensureWatchLocked(root: Conversation): Promise<ConversationWatch> {
    if (this.watch) return Promise.resolve(this.watch);
    if (this.watchTask) return this.watchTask;
    this.watchTask = (async () => {
      const watch = await root.watch(BACKGROUND_CONTEXT);
      this.watch = watch;
      watch.start(async (_value, ops) => {
        this.broadcast({ type: "ops", ops });
      });
      return watch;
    })().finally(() => {
      this.watchTask = undefined;
    });
    return this.watchTask;
  }

  /** Re-register hibernated sockets with a fresh view after a new generation. */
  private async attachHibernatedLocked(root: Conversation): Promise<void> {
    const existing = this.ctx.getWebSockets();
    if (existing.length === 0) return;
    const watch = await this.ensureWatchLocked(root);
    for (const socket of existing) {
      if (this.sockets.has(socket)) continue;
      this.sockets.add(socket);
      this.send(socket, { type: "view", value: watch.value });
    }
  }

  private async detachSocket(socket: WebSocket): Promise<void> {
    this.sockets.delete(socket);
    if (this.sockets.size === 0 && this.ctx.getWebSockets().length === 0) {
      await this.stopWatch();
    }
  }

  private async stopWatch(): Promise<void> {
    const watch = this.watch;
    this.watch = undefined;
    if (!watch) return;
    try {
      await watch.stop();
    } catch {
      // A stopped watch needs no further cleanup.
    }
  }

  private closeSockets(code: number, reason: string): void {
    for (const socket of this.ctx.getWebSockets()) closeSocket(socket, code, reason);
    for (const socket of this.sockets) closeSocket(socket, code, reason);
    this.sockets.clear();
  }

  // -------------------------------------------------------------------------
  // Control frames
  // -------------------------------------------------------------------------

  private async handleControl(socket: WebSocket, frame: SessionClientFrame): Promise<void> {
    // Admission and short durable operations stay inside the mutex; model
    // execution and long abort waits run outside it.
    const { harness, root } = await this.exclusive(async () => {
      const ready = await this.requireOpenLocked();
      await this.attachHibernatedLocked(ready.root);
      if (frame.type === "submit") await this.syncSettings(ready.root);
      return ready;
    });

    switch (frame.type) {
      case "submit": {
        if (typeof frame.text !== "string" || frame.text.length === 0) {
          throw new AppError("INVALID_INPUT", "submission text is required");
        }
        if (frame.whenBusy !== undefined && frame.whenBusy !== "followUp" && frame.whenBusy !== "steer") {
          throw new AppError("INVALID_INPUT", "unknown submission mode");
        }
        const submission = await this.exclusive(async () => {
          if (this.deleting || this.deleted) throw new AppError("CONFLICT", "session is being deleted");
          return root.submit(
            {
              type: "input",
              content: frame.text,
              requestId: frame.requestId,
              whenBusy: frame.whenBusy ?? "followUp",
            },
            BACKGROUND_CONTEXT,
          );
        });
        this.send(socket, { type: "submitted", requestId: frame.requestId, submissionId: submission.id });
        // Surface a terminal model failure instead of rendering nothing. A
        // withdrawn or cancelled input is not a model failure.
        void submission
          .wait(BACKGROUND_CONTEXT)
          .then((settled) => {
            if (settled.status === "unanswered" && settled.reason !== "aborted") {
              this.broadcast({
                type: "notice",
                code: "MODEL_ERROR",
                message: `The model could not answer: ${settled.reason}`,
              });
            }
          })
          .catch(() => {
            // The session closed or the wait was cancelled.
          });
        return;
      }
      case "withdraw": {
        if (typeof frame.submissionId !== "number") {
          throw new AppError("INVALID_INPUT", "submissionId is required");
        }
        await harness.abortSubmission(frame.submissionId, BACKGROUND_CONTEXT, ROOT_CONVERSATION_ID);
        this.send(socket, { type: "result", requestId: frame.requestId });
        return;
      }
      case "abort": {
        await root.abort(BACKGROUND_CONTEXT);
        this.send(socket, { type: "result", requestId: frame.requestId });
        return;
      }
      case "history": {
        const limit = clampLimit(frame.limit);
        const page = await root.entries(
          { order: "descending", maxEntryId: frame.before },
          limit,
          frame.cursor,
          BACKGROUND_CONTEXT,
        );
        this.send(socket, {
          type: "history",
          requestId: frame.requestId,
          entries: [...page.items],
          next: page.next,
        });
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Fixture-only routes
  // -------------------------------------------------------------------------

  private async handleFixtureEvict(): Promise<Response> {
    if (!isFixtureMode(this.env)) return new Response("not found", { status: 404 });
    if (!(await this.hasPendingRun())) {
      return new Response("no run in flight", { status: 409 });
    }
    this.ctx.abort("fixture eviction");
    return new Response(null, { status: 204 });
  }

  private async handleFixtureState(): Promise<Response> {
    if (!isFixtureMode(this.env)) return new Response("not found", { status: 404 });
    return Response.json({
      instanceId: this.instanceId,
      initialized: this.initialized,
      hasRun: await this.hasPendingRun(),
      alarm: await this.ctx.storage.getAlarm(),
    });
  }

  /** Seed committed history and optionally start a new active range. */
  private async handleFixtureSeed(request: Request): Promise<Response> {
    if (!isFixtureMode(this.env)) return new Response("not found", { status: 404 });
    const body = (await request.json().catch(() => ({}))) as { count?: number; reset?: boolean };
    const count = Math.min(Math.max(Math.trunc(body.count ?? 0), 0), 500);
    const { root } = await this.exclusive(async () => this.requireOpenLocked());
    if (count > 0) {
      await root.commit(async (tx) => {
        for (let i = 0; i < count; i++) {
          await tx.appendEntry(UserEntry, ROOT_CONVERSATION_ID, {
            model: [{ role: "user", content: `seeded ${i}`, timestamp: Date.now() }],
          });
        }
      }, BACKGROUND_CONTEXT);
    }
    if (body.reset) await root.reset(undefined, BACKGROUND_CONTEXT);
    return Response.json({ ok: true, count, reset: body.reset === true });
  }

  private async hasPendingRun(): Promise<boolean> {
    if (!this.harness || !this.root) return false;
    const live = await this.harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    return live?.run !== undefined;
  }

  // -------------------------------------------------------------------------
  // Transport helpers
  // -------------------------------------------------------------------------

  private assertOwner(request: Request): { authExpiresAt: number } {
    const header = request.headers.get("x-mi-owner");
    if (header !== this.ownerKey) {
      throw new AppError("UNAUTHENTICATED", "session ownership mismatch");
    }
    const expiresHeader = request.headers.get("x-mi-auth-exp");
    const expires = expiresHeader ? Number(expiresHeader) : Number.NaN;
    if (!Number.isFinite(expires) || expires <= Date.now()) {
      throw new AppError("UNAUTHENTICATED", "access assertion is missing or expired");
    }
    // Cross-check the forwarded conversation id against the object's own
    // address, so a misrouted request cannot operate on another session.
    const forwarded = request.headers.get("x-mi-conversation");
    if (forwarded !== null && forwarded !== this.conversationId) {
      throw new AppError("UNAUTHENTICATED", "session address does not match the conversation");
    }
    return { authExpiresAt: expires };
  }

  private broadcast(frame: SessionServerFrame): void {
    for (const socket of [...this.sockets]) this.send(socket, frame);
  }

  private send(socket: WebSocket, frame: SessionServerFrame): void {
    const attachment = readAttachment(socket);
    if (!attachment || attachment.authExpiresAt <= Date.now()) {
      closeSocket(socket, 4401, "authentication expired");
      this.sockets.delete(socket);
      return;
    }
    try {
      socket.send(encodeSessionFrame(frame));
    } catch {
      this.sockets.delete(socket);
    }
  }
}

function isFixtureMode(env: Env): boolean {
  const value = (env as unknown as Record<string, unknown>).MI_FIXTURE_MODEL_URL;
  return typeof value === "string" && value.length > 0;
}

function readHeaderNumber(request: Request, name: string): number {
  const value = request.headers.get(name);
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function readAttachment(socket: WebSocket): SocketAttachment | undefined {
  try {
    return (socket.deserializeAttachment() as SocketAttachment | null) ?? undefined;
  } catch {
    return undefined;
  }
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Already closed.
  }
}

function thinkingLevel(settings: { routeId: string; thinkingLevel?: string } | undefined): ModelThinkingLevel | undefined {
  if (!settings?.thinkingLevel) return undefined;
  const selection = resolveRouteById(settings.routeId);
  return selection.thinkingLevels.includes(settings.thinkingLevel as never)
    ? (settings.thinkingLevel as ModelThinkingLevel)
    : undefined;
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return 50;
  return Math.min(Math.max(Math.trunc(limit), 1), 200);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "internal error";
}

function statusFor(error: AppError): number {
  switch (error.code) {
    case "UNAUTHENTICATED":
      return 401;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "NOT_READY":
      return 503;
    case "NOT_CONFIGURED":
      return 503;
    default:
      return 400;
  }
}

function methodNotAllowed(): Response {
  return new Response("method not allowed", { status: 405 });
}

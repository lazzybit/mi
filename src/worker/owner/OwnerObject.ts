import { AppError, type OwnerIdentity, ownerKey } from "../../shared/domain";
import { decodeClientFrame } from "../../shared/wire";
import { createDefaultModelGateway } from "../models";
import { durableObjectAlarmStore } from "../runtime/WakeScheduler";
import type { SqlExecutor, StorageBackend } from "../storage/Sql";
import { OwnerRuntime } from "./OwnerRuntime";
import { DurableObjectBase } from "./DurableObjectBase";
import type { SyncSocket } from "../sync/SyncHub";

interface SocketAttachment {
  selection?: string;
  authExpiresAt?: number;
  ownerDigest?: string;
}

/**
 * OwnerObject is the single authoritative state owner for one verified owner
 * (PLAN.md -> Architecture -> One authoritative state owner).
 */
export class OwnerObject extends DurableObjectBase<Env> {
  private runtime?: OwnerRuntime;

  private getRuntime(): OwnerRuntime {
    if (this.runtime) return this.runtime;
    const backend: StorageBackend = {
      sql: this.ctx.storage.sql as unknown as SqlExecutor,
      transactionSync: (fn) => this.ctx.storage.transactionSync(fn),
    };
    const runtime = new OwnerRuntime({
      backend,
      alarms: durableObjectAlarmStore(this.ctx.storage),
      model: createDefaultModelGateway(this.env),
      oauthClientMetadataUrl: this.env.OAUTH_CLIENT_METADATA_URL,
      oauthCallbackUrl: this.oauthCallbackUrl(),
    });
    runtime.start();
    this.runtime = runtime;

    // Re-register surviving hibernatable sockets with a fresh stream.
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readAttachment(socket);
      runtime.attachSocket(
        socket,
        socketAdapter(socket),
        attachment?.selection,
        attachment?.authExpiresAt ?? Number.POSITIVE_INFINITY,
      );
    }
    return runtime;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      return this.handleWebSocket(request);
    }
    if (url.pathname === "/rpc") {
      return this.handleRpc(request);
    }
    if (url.pathname === "/api/mcp/oauth/callback") {
      return this.handleOAuthCallback(request);
    }
    if (url.pathname === "/health") {
      return Response.json({ ok: true, owner: this.ownerDigest() });
    }
    if (url.pathname === "/__fixture/evict") {
      return this.handleFixtureEvict();
    }
    if (url.pathname === "/__fixture/attempts") {
      return this.handleFixtureAttempts();
    }
    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.getRuntime().alarm();
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const frame = decodeClientFrame(message);
    if (!frame) return;
    const runtime = this.getRuntime();
    if (frame.type === "subscribe") {
      const attachment = readAttachment(socket) ?? {};
      attachment.selection = frame.conversationId;
      socket.serializeAttachment(attachment);
      runtime.sync.subscribe(socket, frame.conversationId);
    } else {
      runtime.resnapshot(socket);
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    this.getRuntime().detachSocket(socket);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    this.getRuntime().detachSocket(socket);
  }

  private handleWebSocket(request: Request): Response {
    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const url = new URL(request.url);
    const selection = url.searchParams.get("conversationId") ?? undefined;
    const authExpiresAt = Number(request.headers.get("x-mi-auth-exp") ?? "") || undefined;
    const ownerDigest = request.headers.get("x-mi-owner") ?? undefined;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: SocketAttachment = { selection, authExpiresAt, ownerDigest };
    server.serializeAttachment(attachment);
    this.persistAccessAssertion(request);
    this.ctx.acceptWebSocket(server);
    this.getRuntime().attachSocket(
      server,
      socketAdapter(server),
      selection,
      authExpiresAt ?? Number.POSITIVE_INFINITY,
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  private handleFixtureEvict(): Response {
    // Browser-acceptance only: force a new object generation while a tool call
    // is dispatched so the recovery matrix can be exercised. Without the
    // fixture configuration this route does not exist.
    const fixture = (this.env as unknown as Record<string, unknown>).MI_FIXTURE_MODEL_URL;
    if (typeof fixture !== "string" || fixture.length === 0) {
      return new Response("not found", { status: 404 });
    }
    if (!this.getRuntime().hasDispatchedAttempt()) {
      return new Response("no dispatched attempt", { status: 409 });
    }
    this.ctx.abort("fixture eviction");
    return new Response(null, { status: 204 });
  }

  private handleFixtureAttempts(): Response {
    const fixture = (this.env as unknown as Record<string, unknown>).MI_FIXTURE_MODEL_URL;
    if (typeof fixture !== "string" || fixture.length === 0) {
      return new Response("not found", { status: 404 });
    }
    if (!this.runtime) return Response.json({ note: "no runtime" });
    return Response.json(this.runtime.unsettledAttempts());
  }

  private async handleRpc(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    this.persistAccessAssertion(request);
    let body: { method?: unknown; args?: unknown };
    try {
      body = (await request.json()) as { method?: unknown; args?: unknown };
    } catch {
      return Response.json({ error: { code: "INVALID_INPUT", message: "invalid JSON body", retryable: false } }, { status: 400 });
    }
    if (typeof body.method !== "string" || !Array.isArray(body.args)) {
      return Response.json({ error: { code: "INVALID_INPUT", message: "method and args are required", retryable: false } }, { status: 400 });
    }
    try {
      const value = await this.getRuntime().dispatch(body.method, body.args);
      return Response.json({ value });
    } catch (error) {
      if (error instanceof AppError) {
        return Response.json({ error: error.toApiError() }, { status: statusFor(error.code) });
      }
      const message = error instanceof Error ? error.message : "internal error";
      return Response.json(
        { error: { code: "INVALID_INPUT", message, retryable: false } },
        { status: 500 },
      );
    }
  }

  private ownerDigest(): string {
    const key = this.ctx.id.name ?? "owner";
    return key;
  }

  private persistAccessAssertion(request: Request): void {
    const assertion = request.headers.get("x-mi-assertion");
    if (!assertion) return;
    const expiresAt = Number(request.headers.get("x-mi-auth-exp") ?? "");
    const owner = request.headers.get("x-mi-owner") ?? "owner";
    this.getRuntime().updateAccessAssertion(
      assertion,
      Number.isFinite(expiresAt) ? expiresAt : 0,
      owner,
    );
  }

  private handleOAuthCallback(request: Request): Response {
    const url = new URL(request.url);
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? undefined;
    const error = url.searchParams.get("error") ?? undefined;
    const runtime = this.getRuntime();
    // The callback completes asynchronously; the browser is redirected back to
    // the app, which observes the connector state through its subscription.
    const work = runtime.handleOAuthCallback({ state, code, error }).catch((failure: unknown) => {
      console.error("oauth callback failed", failure);
    });
    this.ctx.waitUntil(work);
    return Response.redirect(new URL("/?oauth=complete", url).toString(), 303);
  }

  private oauthCallbackUrl(): string {
    try {
      return `${new URL(this.env.OAUTH_CLIENT_METADATA_URL).origin}/api/mcp/oauth/callback`;
    } catch {
      return "";
    }
  }
}

function socketAdapter(socket: WebSocket): SyncSocket {
  return {
    send: (data: string) => socket.send(data),
    close: (code?: number, reason?: string) => socket.close(code, reason),
  };
}

function readAttachment(socket: WebSocket): SocketAttachment | undefined {
  try {
    return (socket.deserializeAttachment() as SocketAttachment | null) ?? undefined;
  } catch {
    return undefined;
  }
}

function statusFor(code: string): number {
  switch (code) {
    case "INVALID_INPUT":
      return 400;
    case "UNAUTHENTICATED":
    case "AUTH_REQUIRED":
      return 401;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
    case "REMOTE_OUTCOME_UNKNOWN":
      return 409;
    case "NOT_CONFIGURED":
    case "CONNECTOR_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

export type { OwnerIdentity };
export { ownerKey };

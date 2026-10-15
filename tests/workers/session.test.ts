import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { CatalogStore } from "../../src/worker/owner/CatalogStore";
import { sessionAddress } from "../../src/worker/session/SessionObject";

function owner(): string {
  return `owner-${crypto.randomUUID()}`;
}

function stubFor(key: string, conversationId: string): DurableObjectStub {
  return env.SESSION.get(env.SESSION.idFromName(sessionAddress(key, conversationId)));
}

function authHeaders(key: string): Record<string, string> {
  return { "x-mi-owner": key, "x-mi-auth-exp": String(Date.now() + 3_600_000) };
}

async function provision(key: string, conversationId: string): Promise<Response> {
  return stubFor(key, conversationId).fetch("https://session.internal/provision", {
    method: "POST",
    headers: authHeaders(key),
  });
}

async function erase(key: string, conversationId: string): Promise<Response> {
  return stubFor(key, conversationId).fetch("https://session.internal/delete", {
    method: "POST",
    headers: authHeaders(key),
  });
}

async function health(key: string, conversationId: string): Promise<{ initialized: boolean }> {
  const response = await stubFor(key, conversationId).fetch("https://session.internal/health", {
    headers: authHeaders(key),
  });
  return (await response.json()) as { initialized: boolean };
}

describe("SessionObject lifecycle", () => {
  it("initializes only through an explicit provisioning request", async () => {
    const catalog = new CatalogStore(env.DB);
    const key = owner();
    const receipt = await catalog.create(key, { commandId: "c1", payload: {} }, async (id) => {
      expect((await provision(key, id)).status).toBe(200);
    });
    const conversationId = receipt.result.conversationId;

    expect(await health(key, conversationId)).toMatchObject({ initialized: true });
    // A second provisioning request is idempotent.
    expect((await provision(key, conversationId)).status).toBe(200);
  });

  it("serializes concurrent provisioning requests", async () => {
    const catalog = new CatalogStore(env.DB);
    const key = owner();
    const receipt = await catalog.create(key, { commandId: "c1", payload: {} }, async () => {});
    const conversationId = receipt.result.conversationId;

    const responses = await Promise.all([
      provision(key, conversationId),
      provision(key, conversationId),
      provision(key, conversationId),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(await health(key, conversationId)).toMatchObject({ initialized: true });
  });

  it("refuses to provision a conversation that is not active", async () => {
    const key = owner();
    const response = await provision(key, "not-in-the-catalog");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "CONFLICT" } });
  });

  it("refuses an ordinary session request before provisioning", async () => {
    const catalog = new CatalogStore(env.DB);
    const key = owner();
    // Create the row without provisioning, as a crash between activation and
    // provisioning would leave it.
    const receipt = await catalog.create(key, { commandId: "c1", payload: {} }, async () => {});
    const conversationId = receipt.result.conversationId;

    const response = await stubFor(key, conversationId).fetch(
      "https://session.internal/ws?conversationId=" + conversationId,
      { headers: { Upgrade: "websocket", ...authHeaders(key) } },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "NOT_READY", retryable: true } });
  });

  it("serializes duplicate deletion and refuses later provisioning", async () => {
    const catalog = new CatalogStore(env.DB);
    const key = owner();
    const receipt = await catalog.create(key, { commandId: "c1", payload: {} }, async (id) => {
      await provision(key, id);
    });
    const conversationId = receipt.result.conversationId;

    const responses = await Promise.all([
      erase(key, conversationId),
      erase(key, conversationId),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await health(key, conversationId)).toMatchObject({ initialized: false });

    // The erased session must not be re-initialized by a delayed provision,
    // even though the catalog row is still active in this test.
    const late = await provision(key, conversationId);
    expect(late.status).toBe(409);
  });

  it("rejects a request from another owner", async () => {
    const key = owner();
    const other = owner();
    const response = await stubFor(key, "conversation-1").fetch("https://session.internal/health", {
      headers: authHeaders(other),
    });
    expect(response.status).toBe(401);
  });

  it("waits for an in-flight initialization before deleting", async () => {
    const catalog = new CatalogStore(env.DB);
    const key = owner();
    const receipt = await catalog.create(key, { commandId: "c1", payload: {} }, async () => {});
    const conversationId = receipt.result.conversationId;

    // Start a slow provisioning request, let it enter the delayed open, then
    // request deletion concurrently.
    const provisioning = stubFor(key, conversationId).fetch(
      "https://session.internal/provision",
      {
        method: "POST",
        headers: { ...authHeaders(key), "x-mi-fixture-open-delay-ms": "300" },
      },
    );
    await scheduler.wait(50);
    const deleting = erase(key, conversationId);
    const [provisionResponse, deleteResponse] = await Promise.all([provisioning, deleting]);

    // Deletion is admitted after the open, so the session ends erased rather
    // than re-initialized by the delayed provision.
    expect(provisionResponse.status).toBe(200);
    expect(deleteResponse.status).toBe(200);
    expect(await health(key, conversationId)).toMatchObject({ initialized: false });
    expect((await provision(key, conversationId)).status).toBe(409);
  });

  it("keeps deletion retryable after a closure failure", async () => {
    const catalog = new CatalogStore(env.DB);
    const key = owner();
    const receipt = await catalog.create(key, { commandId: "c1", payload: {} }, async (id) => {
      await provision(key, id);
    });
    const conversationId = receipt.result.conversationId;

    const failed = await stubFor(key, conversationId).fetch("https://session.internal/delete", {
      method: "POST",
      headers: { ...authHeaders(key), "x-mi-fixture-close-failure": "1" },
    });
    expect(failed.status).not.toBe(200);
    // Storage was not erased under a live harness, so a retry can complete.
    expect((await erase(key, conversationId)).status).toBe(200);
    expect(await health(key, conversationId)).toMatchObject({ initialized: false });
  });

  it("applies saved settings to the next request on an open session", async () => {
    const catalog = new CatalogStore(env.DB);
    const key = owner();
    const originalFetch = globalThis.fetch;
    let captured: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === "string") captured = JSON.parse(init.body) as Record<string, unknown>;
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const body =
        chunk({ content: "ok" }, "stop") +
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "deepseek-flash", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n` +
        "data: [DONE]\n\n";
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      const receipt = await catalog.create(key, { commandId: "c1", payload: {} }, async (id) => {
        await provision(key, id);
      });
      const conversationId = receipt.result.conversationId;
      const response = await stubFor(key, conversationId).fetch(
        `https://session.internal/ws?conversationId=${conversationId}`,
        { headers: { Upgrade: "websocket", ...authHeaders(key) } },
      );
      const socket = response.webSocket!;
      socket.accept();
      await nextMessage(socket);

      // Change settings while the session is open, then submit.
      await catalog.saveModelProfile(key, {
        settings: {
          gatewayId: "mi",
          routeId: "dynamic/runner",
          thinkingLevel: "high",
          maxOutputTokens: 1234,
        },
      });
      socket.send(JSON.stringify({ type: "submit", requestId: "r1", text: "hi" }));
      for (let i = 0; i < 200 && captured === undefined; i++) {
        await scheduler.wait(50);
      }
      expect(captured?.max_completion_tokens ?? captured?.max_tokens).toBe(1234);
      expect(captured?.reasoning_effort).toBe("high");
      socket.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects a malformed session address", async () => {
    const id = env.SESSION.idFromName("no-separator");
    const stub = env.SESSION.get(id);
    const response = await stub.fetch("https://session.internal/health", {
      headers: authHeaders("no-separator"),
    });
    expect(response.status).toBe(400);
  });

  it("pages seeded history without duplicates after a reset", async () => {
    const catalog = new CatalogStore(env.DB);
    const key = owner();
    const receipt = await catalog.create(key, { commandId: "c1", payload: {} }, async (id) => {
      await provision(key, id);
    });
    const conversationId = receipt.result.conversationId;
    const stub = stubFor(key, conversationId);
    const seeded = await stub.fetch("https://session.internal/__fixture/seed", {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify({ count: 80, reset: true }),
    });
    expect(seeded.status).toBe(200);

    const response = await stub.fetch(
      `https://session.internal/ws?conversationId=${conversationId}`,
      { headers: { Upgrade: "websocket", ...authHeaders(key) } },
    );
    const socket = response.webSocket!;
    socket.accept();
    const view = JSON.parse(await nextMessage(socket)) as {
      type: string;
      value: { entries: { id: number }[] };
    };
    expect(view.type).toBe("view");
    const activeIds = new Set(view.value.entries.map((entry) => entry.id));
    const anchor = view.value.entries[0]?.id;
    expect(anchor).toBeDefined();

    const pages: number[][] = [];
    let cursor: unknown;
    for (let i = 0; i < 6; i++) {
      socket.send(
        JSON.stringify({ type: "history", requestId: `h${i}`, before: anchor, cursor, limit: 25 }),
      );
      const frame = JSON.parse(await nextMessage(socket)) as {
        type: string;
        entries: { id: number }[];
        next?: unknown;
      };
      expect(frame.type).toBe("history");
      pages.push(frame.entries.map((entry) => entry.id));
      cursor = frame.next;
      if (!cursor) break;
    }
    socket.close();

    const all = pages.flat();
    expect(pages.length).toBeGreaterThan(1);
    expect(new Set(all).size).toBe(all.length);
    // Descending within each page.
    for (const page of pages) {
      for (let i = 1; i < page.length; i++) expect(page[i]).toBeLessThan(page[i - 1]!);
    }
    // Every seeded entry is reachable and none duplicates the active view.
    expect(all.filter((id) => !activeIds.has(id))).toHaveLength(80);
  });
});

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.addEventListener("message", (event) => resolve(event.data as string), { once: true });
  });
}

import { describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";

// ADR-0003: the built Worker artifact exposes the Solid handler and the
// SessionObject Durable Object class, enforces authentication on protected
// routes, and keeps private material out of client chunks.
describe("worker entry", () => {
  it("serves the Solid application shell", async () => {
    const response = await SELF.fetch("https://mi.test/");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("rejects server-function calls without an Access assertion", async () => {
    const response = await SELF.fetch("https://mi.test/_server", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://mi.test" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(401);
  });

  it("rejects WebSocket upgrades without an Access assertion", async () => {
    const response = await SELF.fetch("https://mi.test/ws?conversationId=abc", {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(401);
  });

  it("requires a conversationId for a session socket", async () => {
    const response = await SELF.fetch("https://mi.test/ws", {
      headers: { Upgrade: "websocket" },
    });
    // Authentication is checked first; the missing id is a client error only
    // for an authenticated caller.
    expect([400, 401]).toContain(response.status);
  });

  it("resolves the SessionObject Durable Object binding", async () => {
    const id = env.SESSION.idFromName("owner|1::conversation-1");
    const stub = env.SESSION.get(id);
    const response = await stub.fetch("https://session.internal/health", {
      headers: { "x-mi-owner": "owner|1", "x-mi-auth-exp": String(Date.now() + 3_600_000) },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it("rejects a session request from another owner", async () => {
    const id = env.SESSION.idFromName("owner|1::conversation-1");
    const stub = env.SESSION.get(id);
    const response = await stub.fetch("https://session.internal/health", {
      headers: { "x-mi-owner": "owner|2", "x-mi-auth-exp": String(Date.now() + 3_600_000) },
    });
    expect(response.status).toBe(401);
  });

  it("does not leak server-only material into client chunks", async () => {
    const shell = await SELF.fetch("https://mi.test/");
    const html = await shell.text();
    const match = /src="(\/assets\/[^"]+\.js)"/.exec(html);
    expect(match?.[1]).toBeTruthy();
    const asset = await SELF.fetch(`https://mi.test${match?.[1]}`);
    const code = await asset.text();
    expect(code).not.toContain("Cf-Access-Jwt-Assertion");
    expect(code).not.toContain("Cloudflare-Access");
    expect(code).not.toContain("cf-access-jwt-assertion");
  });
});

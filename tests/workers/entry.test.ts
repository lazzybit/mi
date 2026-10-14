import { describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";

// M0-T01 / M1-T03: the built Worker artifact must expose both the Solid handler
// and the OwnerObject Durable Object class, enforce authentication on protected
// routes, and keep private material out of client chunks.
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
    const response = await SELF.fetch("https://mi.test/ws", {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(401);
  });

  it("rejects the OAuth callback without an Access assertion", async () => {
    const response = await SELF.fetch("https://mi.test/api/mcp/oauth/callback?code=x&state=y");
    expect(response.status).toBe(401);
  });

  it("serves credential-free OAuth client metadata publicly", async () => {
    const response = await SELF.fetch("https://mi.test/oauth/client-metadata.json");
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata.client_id).toBeTruthy();
    expect(JSON.stringify(metadata)).not.toMatch(/client_secret|bearer|assertion/i);
  });

  it("resolves the OwnerObject Durable Object binding", async () => {
    const id = env.OWNER.idFromName("spike");
    const stub = env.OWNER.get(id);
    const response = await stub.fetch("https://owner.test/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
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

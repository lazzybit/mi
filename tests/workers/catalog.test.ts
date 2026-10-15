import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { CatalogStore } from "../../src/worker/owner/CatalogStore";

function owner(): string {
  return `owner-${crypto.randomUUID()}`;
}

describe("CatalogStore", () => {
  it("creates, renames, lists, and deletes a conversation", async () => {
    const catalog = new CatalogStore(env.DB);
    const key = owner();
    const provisioned: string[] = [];
    const erased: string[] = [];

    const receipt = await catalog.create(key, { commandId: "c1", payload: {} }, async (id) => {
      provisioned.push(id);
    });
    expect(receipt.result.conversationId).toBeTruthy();
    expect(provisioned).toEqual([receipt.result.conversationId]);

    // A repeated create returns the same conversation and resumes provisioning.
    const again = await catalog.create(key, { commandId: "c1", payload: {} }, async (id) => {
      provisioned.push(id);
    });
    expect(again.result.conversationId).toBe(receipt.result.conversationId);
    expect(provisioned).toHaveLength(2);
    expect(await catalog.list(key)).toHaveLength(1);

    await catalog.rename(key, {
      conversationId: receipt.result.conversationId,
      title: "  Renamed  ",
    });
    const list = await catalog.list(key);
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("Renamed");
    expect(list[0]?.lifecycle).toBe("active");

    await catalog.delete(key, { conversationId: receipt.result.conversationId }, async (id) => {
      erased.push(id);
    });
    expect(erased).toEqual([receipt.result.conversationId]);
    expect(await catalog.list(key)).toHaveLength(0);
  });

  it("adopts the winning receipt when two creates race on one command id", async () => {
    const catalog = new CatalogStore(env.DB);
    const key = owner();
    const provisioned: string[] = [];
    const provision = async (id: string) => {
      provisioned.push(id);
    };
    const [first, second] = await Promise.all([
      catalog.create(key, { commandId: "race", payload: {} }, provision),
      catalog.create(key, { commandId: "race", payload: {} }, provision),
    ]);
    expect(second.result.conversationId).toBe(first.result.conversationId);
    expect(await catalog.list(key)).toHaveLength(1);
  });

  it("resumes a create whose row is still creating", async () => {
    const catalog = new CatalogStore(env.DB);
    const key = owner();
    const receipt = await catalog.create(key, { commandId: "c1", payload: {} }, async () => {});
    // Simulate a crash between the creating insert and activation.
    await env.DB.prepare(`UPDATE conversations SET lifecycle = 'creating' WHERE id = ?`)
      .bind(receipt.result.conversationId)
      .run();

    const provisioned: string[] = [];
    await catalog.create(key, { commandId: "c1", payload: {} }, async (id) => {
      provisioned.push(id);
    });
    const row = await catalog.get(key, receipt.result.conversationId);
    expect(row?.lifecycle).toBe("active");
    expect(provisioned).toEqual([receipt.result.conversationId]);
  });

  it("treats a missing row as an already-completed deletion", async () => {
    const catalog = new CatalogStore(env.DB);
    await expect(
      catalog.delete(owner(), { conversationId: "missing" }, async () => {}),
    ).resolves.toBeUndefined();
  });

  it("isolates owners", async () => {
    const catalog = new CatalogStore(env.DB);
    const first = owner();
    const second = owner();
    await catalog.create(first, { commandId: "c1", payload: {} }, async () => {});
    expect(await catalog.list(second)).toHaveLength(0);
  });

  it("rejects a commandId reused with a different payload", async () => {
    const catalog = new CatalogStore(env.DB);
    const key = owner();
    await catalog.create(key, { commandId: "c1", payload: {} }, async () => {});
    await expect(
      catalog.create(key, { commandId: "c1", payload: { title: "Different" } }, async () => {}),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects renaming a missing conversation and an empty title", async () => {
    const catalog = new CatalogStore(env.DB);
    const key = owner();
    await expect(
      catalog.rename(key, { conversationId: "missing", title: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const receipt = await catalog.create(key, { commandId: "c1", payload: {} }, async () => {});
    await expect(
      catalog.rename(key, { conversationId: receipt.result.conversationId, title: "   " }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("validates and persists model settings", async () => {
    const catalog = new CatalogStore(env.DB);
    const key = owner();
    const saved = await catalog.saveModelProfile(key, {
      settings: { gatewayId: "mi", routeId: "dynamic/runner" },
    });
    expect(saved.routeId).toBe("dynamic/runner");
    const view = await catalog.view(key);
    expect(view.model?.routeId).toBe("dynamic/runner");
    expect(view.routes.length).toBeGreaterThan(0);

    await expect(
      catalog.saveModelProfile(key, {
        settings: { gatewayId: "mi", routeId: "unknown/route" },
      }),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });
});

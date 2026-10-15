import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { CatalogStore } from "../../src/worker/catalog/CatalogStore";
import { resetCatalog } from "./support/reset";

// ADR-0004: the catalog is application-wide. Storage isolation comes from the
// test pool (per file) plus an explicit reset between cases.
beforeEach(resetCatalog);

describe("CatalogStore", () => {
  it("creates, renames, lists, and deletes a conversation", async () => {
    const catalog = new CatalogStore(env.DB);
    const provisioned: string[] = [];
    const erased: string[] = [];

    const receipt = await catalog.create({ commandId: "c1", payload: {} }, async (id) => {
      provisioned.push(id);
    });
    expect(receipt.result.conversationId).toBeTruthy();
    expect(provisioned).toEqual([receipt.result.conversationId]);

    // A repeated create returns the same conversation and resumes provisioning.
    const again = await catalog.create({ commandId: "c1", payload: {} }, async (id) => {
      provisioned.push(id);
    });
    expect(again.result.conversationId).toBe(receipt.result.conversationId);
    expect(provisioned).toHaveLength(2);
    expect(await catalog.list()).toHaveLength(1);

    await catalog.rename({
      conversationId: receipt.result.conversationId,
      title: "  Renamed  ",
    });
    const list = await catalog.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("Renamed");
    expect(list[0]?.lifecycle).toBe("active");

    await catalog.delete({ conversationId: receipt.result.conversationId }, async (id) => {
      erased.push(id);
    });
    expect(erased).toEqual([receipt.result.conversationId]);
    expect(await catalog.list()).toHaveLength(0);
  });

  it("adopts the winning receipt when two creates race on one command id", async () => {
    const catalog = new CatalogStore(env.DB);
    const provisioned: string[] = [];
    const provision = async (id: string) => {
      provisioned.push(id);
    };
    const [first, second] = await Promise.all([
      catalog.create({ commandId: "race", payload: {} }, provision),
      catalog.create({ commandId: "race", payload: {} }, provision),
    ]);
    expect(second.result.conversationId).toBe(first.result.conversationId);
    expect(await catalog.list()).toHaveLength(1);
  });

  it("resumes a create whose row is still creating", async () => {
    const catalog = new CatalogStore(env.DB);
    const receipt = await catalog.create({ commandId: "c1", payload: {} }, async () => {});
    // Simulate a crash between the creating insert and activation.
    await env.DB.prepare(`UPDATE conversations SET lifecycle = 'creating' WHERE id = ?`)
      .bind(receipt.result.conversationId)
      .run();

    const provisioned: string[] = [];
    await catalog.create({ commandId: "c1", payload: {} }, async (id) => {
      provisioned.push(id);
    });
    const row = await catalog.get(receipt.result.conversationId);
    expect(row?.lifecycle).toBe("active");
    expect(provisioned).toEqual([receipt.result.conversationId]);
  });

  it("treats a missing row as an already-completed deletion", async () => {
    const catalog = new CatalogStore(env.DB);
    await expect(
      catalog.delete({ conversationId: "missing" }, async () => {}),
    ).resolves.toBeUndefined();
  });

  it("rejects a commandId reused with a different payload", async () => {
    const catalog = new CatalogStore(env.DB);
    await catalog.create({ commandId: "c1", payload: {} }, async () => {});
    await expect(
      catalog.create({ commandId: "c1", payload: { title: "Different" } }, async () => {}),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects renaming a missing conversation and an empty title", async () => {
    const catalog = new CatalogStore(env.DB);
    await expect(
      catalog.rename({ conversationId: "missing", title: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const receipt = await catalog.create({ commandId: "c1", payload: {} }, async () => {});
    await expect(
      catalog.rename({ conversationId: receipt.result.conversationId, title: "   " }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("validates and persists the singleton model settings", async () => {
    const catalog = new CatalogStore(env.DB);
    const saved = await catalog.saveModelProfile({
      settings: { gatewayId: "mi", routeId: "dynamic/runner" },
    });
    expect(saved.routeId).toBe("dynamic/runner");
    const view = await catalog.view();
    expect(view.model?.routeId).toBe("dynamic/runner");
    expect(view.routes.length).toBeGreaterThan(0);

    await expect(
      catalog.saveModelProfile({
        settings: { gatewayId: "mi", routeId: "unknown/route" },
      }),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });
});

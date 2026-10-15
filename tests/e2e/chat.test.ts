import { createConversation, openApp, saveModel, submit, expect, test } from "./fixture/app";

// ADR-0003: generation now runs on pi-durable through the pi-ai gateway
// provider. This exercises the whole path against the built Worker: session
// socket submission, harness generation, the fixture model, committed view
// operations, and client rendering.
test("submits input and renders the committed assistant reply", async ({ page, context }) => {
  await openApp(page);
  await saveModel(page);
  await createConversation(page);
  await submit(page, "hello there");

  await expect(page.locator(".user-message")).toHaveText("hello there");
  await expect(page.locator(".assistant-text")).toContainText("Reply: hello there", {
    timeout: 90_000,
  });
});

test("queues a follow-up while a run is active", async ({ page, context }) => {
  await openApp(page);
  await saveModel(page);
  await createConversation(page);

  await submit(page, "first [[slow:6000]]");
  await expect(page.locator(".run-status .run-state")).toBeVisible({ timeout: 60_000 });

  await submit(page, "second task");
  await expect(page.locator(".queue-panel")).toContainText("second task");

  await expect(page.locator(".assistant-text").last()).toContainText("Reply: second task", {
    timeout: 150_000,
  });
  await expect(page.locator(".queue-panel")).toHaveCount(0);
});

// ADR-0003: recovery is the next request or reconnect. Committed work survives
// an abrupt object restart and continues when the client reconnects; no alarm
// is scheduled.
test("resumes committed work after an object restart", async ({ page, context }) => {
  await openApp(page);
  await saveModel(page);
  await createConversation(page);

  const conversationId = await page.locator(".conversation-item").first().getAttribute("data-conversation-id");
  expect(conversationId).toBeTruthy();

  await submit(page, "held [[slow:8000]]");
  await expect(page.locator(".run-status .run-state")).toBeVisible({ timeout: 60_000 });

  // Prove the fixture route is wired and a run is actually pending.
  const before = await fixtureState(page, conversationId!);
  expect(before.hasRun).toBe(true);
  expect(before.alarm).toBeNull();

  // Force a new object generation while the run is in flight. The abort drops
  // the response (0 or 500), or the route returns 204; it must never fall
  // through to the SPA shell (200) or a missing route (404).
  const evictStatus = await evict(page, conversationId!);
  expect(evictStatus).not.toBe(200);
  expect(evictStatus).not.toBe(404);

  // The run resumes on the reconnect, without any host wake mechanism.
  await expect(page.locator(".assistant-text")).toContainText("Reply: held", { timeout: 120_000 });

  // The object generation changed, no alarm was scheduled, and the committed
  // input was not duplicated.
  const after = await fixtureState(page, conversationId!);
  expect(after.instanceId).not.toBe(before.instanceId);
  expect(after.alarm).toBeNull();
  await expect(page.locator(".user-message")).toHaveCount(1);
});

// ADR-0003: an unacknowledged submission is retained and resent with the same
// request id when the session socket reconnects.
test("resends an unacknowledged submission after reconnect", async ({ page, context }) => {
  await openApp(page);
  await saveModel(page);
  await createConversation(page);

  await context.setOffline(true);
  await expect(page.locator(".connection")).toHaveText("offline", { timeout: 30_000 });
  await submit(page, "queued while offline");

  await context.setOffline(false);
  await expect(page.locator(".connection")).toHaveText("live", { timeout: 60_000 });
  await expect(page.locator(".user-message")).toContainText("queued while offline", {
    timeout: 90_000,
  });
  await expect(page.locator(".user-message")).toHaveCount(1);
});

// ADR-0003: when the server accepted input but its acknowledgement was lost,
// the client resends the same request id and the harness deduplicates it.
test("recovers a lost submission acknowledgement", async ({ page, context }) => {
  let dropped = false;
  await page.routeWebSocket("**/ws**", (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (!dropped && typeof message === "string" && message.includes('"submitted"')) {
        dropped = true;
        ws.close();
        return;
      }
      ws.send(message);
    });
  });

  await openApp(page);
  await saveModel(page);
  await createConversation(page);
  await submit(page, "ack loss");

  await expect(page.locator(".connection")).toHaveText("live", { timeout: 60_000 });
  await expect(page.locator(".user-message")).toHaveText("ack loss", { timeout: 90_000 });
  await expect(page.locator(".assistant-text")).toContainText("Reply: ack loss", {
    timeout: 90_000,
  });
  // The committed input is not duplicated, and the pending entry was cleared by
  // the resent request's acknowledgement.
  await expect(page.locator(".user-message")).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("mi:pending-submissions")))
    .toBe("[]");
});

// ADR-0003: switching conversations discards and reacquires observation without
// clearing the committed transcript of the conversation switched back to.
test("preserves the transcript when switching conversations", async ({ page, context }) => {
  await openApp(page);
  await saveModel(page);
  await createConversation(page);
  // Give the first conversation a distinct title so the second is unambiguous.
  await page.getByRole("button", { name: "Rename New conversation" }).click();
  const input = page.getByLabel("Conversation title");
  await input.fill("One");
  await input.press("Enter");
  await expect(page.locator(".conversation-title")).toHaveText("One");
  await submit(page, "first conversation message");
  await expect(page.locator(".assistant-text")).toContainText("Reply: first", { timeout: 90_000 });

  // Create and select a second conversation, then switch back.
  await page.locator(".conversation-list > button.primary").click();
  await expect(page.locator(".conversation-item")).toHaveCount(2, { timeout: 60_000 });
  await page.locator(".conversation-item").filter({ hasText: "New conversation" }).first().click();
  await expect(page.locator(".transcript")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".user-message")).toHaveCount(0);

  await page.locator(".conversation-item").filter({ hasText: "One" }).click();
  await expect(page.locator(".user-message")).toContainText("first conversation message", {
    timeout: 60_000,
  });
});

async function fixtureState(
  page: import("@playwright/test").Page,
  conversationId: string,
): Promise<{ instanceId: string; hasRun: boolean; alarm: number | null }> {
  const response = await page.evaluate(async (id) => {
    const result = await fetch(`/__fixture/state?conversationId=${id}`, { method: "POST" });
    return { status: result.status, body: result.ok ? await result.json() : undefined };
  }, conversationId);
  expect(response.status).toBe(200);
  return response.body as { instanceId: string; hasRun: boolean; alarm: number | null };
}

async function evict(page: import("@playwright/test").Page, conversationId: string): Promise<number> {
  try {
    return await page.evaluate(async (id) => {
      const result = await fetch(`/__fixture/evict?conversationId=${id}`, { method: "POST" });
      return result.status;
    }, conversationId);
  } catch {
    return 0;
  }
}

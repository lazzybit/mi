import { expect, test, type WebSocketRoute } from "@playwright/test";
import { login } from "./fixture/access";
import { createConversation, openOwner, submit } from "./fixture/app";

// Connection states are distinct from execution state: going offline does not
// mean a run stopped, and coming back online reconnects.
test("reports offline while the network is down and recovers", async ({ page, context }, testInfo) => {
  await openOwner(page, context, `owner-${testInfo.testId}`);
  await createConversation(page);
  await expect(page.locator(".connection")).toHaveText("live", { timeout: 60_000 });

  await context.setOffline(true);
  await expect(page.locator(".connection")).toHaveText("offline", { timeout: 30_000 });

  await context.setOffline(false);
  await expect(page.locator(".connection")).toHaveText("live", { timeout: 60_000 });
});

test("returns to reconnecting when the socket drops while online", async ({ page, context }, testInfo) => {
  // Proxy the real observation socket so the test can drop one connection
  // without mocking the server or its frames.
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket("**/ws**", (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => ws.send(message));
    sockets.push(ws);
  });

  await openOwner(page, context, `owner-${testInfo.testId}`);
  await createConversation(page);
  await expect(page.locator(".connection")).toHaveText("live", { timeout: 60_000 });

  const first = sockets[0];
  expect(first).toBeDefined();
  first?.close();
  await expect(page.locator(".connection")).toHaveText("reconnecting", { timeout: 30_000 });
  await expect(page.locator(".connection")).toHaveText("live", { timeout: 60_000 });
});

test("requires authentication again when the socket assertion expires", async ({ browser }, testInfo) => {
  const subject = `owner-${testInfo.testId}`;
  const expiring = await browser.newContext();
  const expiringPage = await expiring.newPage();
  try {
    await login(expiring, subject, { ttlSeconds: 6 });
    await expiringPage.goto("/");
    await expect(expiringPage.locator(".conversation-list > button.primary")).toBeVisible({ timeout: 90_000 });
    await createConversation(expiringPage);
    await expect(expiringPage.locator(".connection")).toHaveText("live", { timeout: 60_000 });

    // Let the assertion expire, then send a control frame: an expired socket
    // must not be silently reauthorized.
    await expiringPage.waitForTimeout(7000);
    await submit(expiringPage, "after expiry");

    await expect(expiringPage.locator(".connection")).toHaveText("authentication_required", {
      timeout: 60_000,
    });
  } finally {
    await expiring.close();
  }
});

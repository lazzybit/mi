import type { WebSocketRoute } from "@playwright/test";
import { createConversation, openApp, expect, test } from "./fixture/app";

// Connection states are distinct from execution state: going offline does not
// mean a run stopped, and coming back online reconnects.
test("reports offline while the network is down and recovers", async ({ page, context }) => {
  await openApp(page);
  await createConversation(page);
  await expect(page.locator(".connection")).toHaveText("live", { timeout: 60_000 });

  await context.setOffline(true);
  await expect(page.locator(".connection")).toHaveText("offline", { timeout: 30_000 });

  await context.setOffline(false);
  await expect(page.locator(".connection")).toHaveText("live", { timeout: 60_000 });
});

test("returns to reconnecting when the socket drops while online", async ({ page }) => {
  // Proxy the real observation socket so the test can drop one connection
  // without mocking the server or its frames.
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket("**/ws**", (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => ws.send(message));
    sockets.push(ws);
  });

  await openApp(page);
  await createConversation(page);
  await expect(page.locator(".connection")).toHaveText("live", { timeout: 60_000 });

  const first = sockets[0];
  expect(first).toBeDefined();
  first?.close();
  await expect(page.locator(".connection")).toHaveText("reconnecting", { timeout: 30_000 });
  await expect(page.locator(".connection")).toHaveText("live", { timeout: 60_000 });
});

// ADR-0004: close code 4401 has no special client handling. An authentication
// closure follows ordinary reconnection, and the client never acquires or
// renews credentials.
test("reconnects after an authentication close code", async ({ page }) => {
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket("**/ws**", (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => ws.send(message));
    sockets.push(ws);
  });

  await openApp(page);
  await createConversation(page);
  await expect(page.locator(".connection")).toHaveText("live", { timeout: 60_000 });

  sockets[0]?.close({ code: 4401, reason: "authentication expired" });
  await expect(page.locator(".connection")).toHaveText("reconnecting", { timeout: 30_000 });
  await expect(page.locator(".connection")).toHaveText("live", { timeout: 60_000 });
});

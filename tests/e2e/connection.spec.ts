import { expect, test } from "@playwright/test";
import { createConversation, openOwner } from "./fixture/app";

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

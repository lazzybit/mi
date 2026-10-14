import { expect, test } from "@playwright/test";
import { createConversation, openOwner } from "./fixture/app";

test("a conversation persists across a reload", async ({ page, context }, testInfo) => {
  await openOwner(page, context, `owner-${testInfo.testId}`);
  await createConversation(page);

  await page.reload();
  await expect(page.locator(".conversation-item")).toHaveCount(1, { timeout: 90_000 });
});

test("a second device sees the same server state", async ({ browser }, testInfo) => {
  const subject = `owner-${testInfo.testId}`;
  const first = await browser.newContext();
  const second = await browser.newContext();
  const firstPage = await first.newPage();
  const secondPage = await second.newPage();
  try {
    await openOwner(firstPage, first, subject);
    await createConversation(firstPage);

    await openOwner(secondPage, second, subject);
    await expect(secondPage.locator(".conversation-item")).toHaveCount(1, { timeout: 90_000 });
  } finally {
    await first.close();
    await second.close();
  }
});

test("a lost acknowledgement is resent from the durable outbox after reload", async ({ page, context }, testInfo) => {
  await openOwner(page, context, `owner-${testInfo.testId}`);

  let dropped = false;
  let signalDropped: () => void = () => undefined;
  const droppedOnce = new Promise<void>((resolve) => {
    signalDropped = resolve;
  });
  await context.route("**/_server/**", async (route) => {
    if (!dropped && route.request().method() === "POST") {
      dropped = true;
      signalDropped();
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  await page.locator(".conversation-list > button.primary").click();
  await droppedOnce;
  // The acknowledgement was lost, so the command is pending, not accepted.
  await expect(page.locator(".conversation-item")).toHaveCount(0);

  // A new bundle flushes the durable outbox through the current references.
  await page.reload();
  await expect(page.locator(".conversation-item")).toHaveCount(1, { timeout: 90_000 });
});

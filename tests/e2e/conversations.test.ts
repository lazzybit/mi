import { createConversation, openApp, expect, test } from "./fixture/app";

test("a conversation persists across a reload", async ({ page }) => {
  await openApp(page);
  await createConversation(page);

  await page.reload();
  await expect(page.locator(".conversation-item")).toHaveCount(1, { timeout: 90_000 });
});

test("a second device sees the same server state", async ({ browser }) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  const firstPage = await first.newPage();
  const secondPage = await second.newPage();
  try {
    await openApp(firstPage);
    await createConversation(firstPage);

    await openApp(secondPage);
    await expect(secondPage.locator(".conversation-item")).toHaveCount(1, { timeout: 90_000 });
  } finally {
    await first.close();
    await second.close();
  }
});

test("renames a conversation inline and persists it across reload", async ({ page }) => {
  await openApp(page);
  await createConversation(page);

  await page.getByRole("button", { name: "Rename New conversation" }).click();
  const input = page.getByLabel("Conversation title");
  await input.fill("Renamed");
  await input.press("Enter");
  await expect(page.locator(".conversation-title")).toHaveText("Renamed");

  await page.reload();
  await expect(page.locator(".conversation-title")).toHaveText("Renamed", { timeout: 90_000 });
});

test("cancels a rename without saving", async ({ page }) => {
  await openApp(page);
  await createConversation(page);

  await page.getByRole("button", { name: "Rename New conversation" }).click();
  await page.getByLabel("Conversation title").fill("Discarded");
  await page.getByLabel("Conversation title").press("Escape");
  await expect(page.locator(".conversation-title")).toHaveText("New conversation");
});

test("deletes a conversation only after confirmation", async ({ page }) => {
  await openApp(page);
  await createConversation(page);

  await page.getByRole("button", { name: "Delete New conversation" }).click();
  await expect(page.locator(".delete-confirm")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".delete-confirm")).toHaveCount(0);
  await expect(page.locator(".conversation-item")).toHaveCount(1);

  await page.getByRole("button", { name: "Delete New conversation" }).click();
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await expect(page.locator(".conversation-item")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator(".empty")).toBeVisible();
});

test("a second device observes a deletion on refresh", async ({ browser }) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  const firstPage = await first.newPage();
  const secondPage = await second.newPage();
  try {
    await openApp(firstPage);
    await createConversation(firstPage);
    await openApp(secondPage);
    await expect(secondPage.locator(".conversation-item")).toHaveCount(1, { timeout: 90_000 });

    await firstPage.getByRole("button", { name: "Delete New conversation" }).click();
    await firstPage.getByRole("button", { name: "Delete permanently" }).click();
    await expect(firstPage.locator(".conversation-item")).toHaveCount(0, { timeout: 90_000 });

    // ADR-0003: the catalog has no live broadcast; another device converges on
    // refresh or focus.
    await secondPage.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(secondPage.locator(".conversation-item")).toHaveCount(0, { timeout: 90_000 });
  } finally {
    await first.close();
    await second.close();
  }
});

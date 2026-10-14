import { expect, test } from "@playwright/test";
import { addFixtureConnector, createConversation, openOwner, saveModel, submit } from "./fixture/app";

// Execution acceptance against the real Worker, Durable Object, scheduling, and
// synchronization. The model transport points at the fixture model service
// (see tests/e2e/start-dev.mjs); everything else is the production path.

test("submits input and renders the committed assistant reply", async ({ page, context }, testInfo) => {
  await openOwner(page, context, `owner-${testInfo.testId}`);
  await saveModel(page);
  await createConversation(page);
  await submit(page, "hello there");

  await expect(page.locator(".user-message")).toHaveText("hello there");
  await expect(page.locator(".assistant-text")).toContainText("Reply: hello there", { timeout: 90_000 });
});

test("runs a tool round and exposes the full tool result on demand", async ({ page, context }, testInfo) => {
  await openOwner(page, context, `owner-${testInfo.testId}`);
  await saveModel(page);
  await addFixtureConnector(page);
  await createConversation(page);
  await submit(page, "please [[tool]]");

  const result = page.locator(".tool-card").last();
  await expect(result.locator(".tool-preview")).toContainText("echo: hello from tool", { timeout: 120_000 });
  await expect(page.locator(".assistant-text").last()).toContainText("Tool said: echo: hello from tool", {
    timeout: 120_000,
  });

  await result.locator(".tool-summary").click();
  await expect(result.locator(".tool-full")).toContainText("echo: hello from tool");
});

test("queues a follow-up while a run is active", async ({ page, context }, testInfo) => {
  await openOwner(page, context, `owner-${testInfo.testId}`);
  await saveModel(page);
  await createConversation(page);

  await submit(page, "first [[slow:6000]]");
  await expect(page.locator(".run-status .run-state")).toBeVisible({ timeout: 60_000 });

  await submit(page, "second task");
  await expect(page.locator(".queue-panel")).toContainText("second task");

  await expect(page.locator(".assistant-text").last()).toContainText("Reply: second task", { timeout: 150_000 });
  await expect(page.locator(".queue-panel")).toHaveCount(0);
});

test("cancels a run without committing a reply", async ({ page, context }, testInfo) => {
  await openOwner(page, context, `owner-${testInfo.testId}`);
  await saveModel(page);
  await createConversation(page);

  await submit(page, "long [[slow:12000]]");
  await expect(page.locator(".run-status .run-state")).toBeVisible({ timeout: 60_000 });

  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".run-status .run-state")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator(".assistant-text")).toHaveCount(0);
});

test("a second device observes an active run without waiting for the model", async ({ browser }, testInfo) => {
  const subject = `owner-${testInfo.testId}`;
  const first = await browser.newContext();
  const second = await browser.newContext();
  const firstPage = await first.newPage();
  const secondPage = await second.newPage();
  try {
    await openOwner(firstPage, first, subject);
    await saveModel(firstPage);
    await createConversation(firstPage);
    await submit(firstPage, "held [[slow:20000]]");
    await expect(firstPage.locator(".run-status .run-state")).toBeVisible({ timeout: 60_000 });

    // The second device must see the run immediately, not after the model
    // finishes.
    await openOwner(secondPage, second, subject);
    await secondPage.locator(".conversation-item").first().click();
    await expect(secondPage.locator(".run-status .run-state")).toBeVisible({ timeout: 30_000 });

    await expect(firstPage.locator(".assistant-text")).toContainText("Reply:", { timeout: 60_000 });
    await expect(secondPage.locator(".assistant-text")).toContainText("Reply:", { timeout: 60_000 });
  } finally {
    await first.close();
    await second.close();
  }
});

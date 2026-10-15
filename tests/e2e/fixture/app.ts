// Shared browser helpers for the acceptance suite. They drive the real UI and
// real server functions; nothing here stubs RPC or WebSocket results.
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { login } from "./access";

export async function openOwner(page: Page, context: BrowserContext, subject: string): Promise<void> {
  await login(context, subject);
  await page.goto("/");
  // The create button only renders once an authenticated catalog has arrived.
  await expect(page.locator(".conversation-list > button.primary")).toBeVisible({ timeout: 90_000 });
}

export async function saveModel(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).click();
  // ADR-0002: the form only selects the configured route; metadata is resolved
  // server-side. The initial route is selected by default.
  await page.getByRole("button", { name: "Save model settings" }).click();
  await expect(page.locator(".saved")).toHaveText("Saved");
  await page.getByRole("button", { name: "Chat" }).click();
}

export async function createConversation(page: Page): Promise<void> {
  await page.locator(".conversation-list > button.primary").click();
  await expect(page.locator(".conversation-item")).toHaveCount(1, { timeout: 60_000 });
  await page.locator(".conversation-item").first().click();
  await expect(page.locator(".composer-input")).toBeVisible();
}

export async function submit(
  page: Page,
  text: string,
  mode: "queue" | "steer" = "queue",
): Promise<void> {
  await page.locator(".composer-input").fill(text);
  await page
    .getByRole("button", { name: mode === "queue" ? "Queue" : "Steer", exact: true })
    .click();
}

export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

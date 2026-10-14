// Shared browser helpers for the acceptance suite. They drive the real UI and
// real server functions; nothing here stubs RPC or WebSocket results.
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { login } from "./access";

export const MCP_ENDPOINT = "http://127.0.0.1:8897/mcp";

export async function openOwner(page: Page, context: BrowserContext, subject: string): Promise<void> {
  await login(context, subject);
  await page.goto("/");
  // The create button only renders once an authenticated snapshot has arrived.
  // (Conversation items use the default title "New conversation", so a role
  // query would be ambiguous.)
  await expect(page.locator(".conversation-list > button.primary")).toBeVisible({ timeout: 90_000 });
}

export async function saveModel(page: Page, model = "fixture-model"): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Model", { exact: true }).fill(model);
  await page.getByRole("button", { name: "Save model settings" }).click();
  await expect(page.locator(".saved")).toHaveText("Saved");
  await page.getByRole("button", { name: "Chat" }).click();
}

export async function addFixtureConnector(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Connectors" }).click();
  await page.getByRole("button", { name: "Add connector" }).click();
  await page.getByLabel("Name").fill("Fixture");
  await page.getByLabel("Endpoint").fill(MCP_ENDPOINT);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const item = page.locator(".connector-item").filter({ hasText: "Fixture" });
  await expect(item).toBeVisible({ timeout: 60_000 });
  await item.getByRole("button", { name: "Connect" }).click();
  await expect(item.locator(".connector-state")).toHaveText("ready", { timeout: 60_000 });
  await page.getByRole("button", { name: "Chat" }).click();
}

export async function createConversation(page: Page): Promise<void> {
  await page.locator(".conversation-list > button.primary").click();
  await expect(page.locator(".conversation-item")).toHaveCount(1, { timeout: 60_000 });
  await page.locator(".conversation-item").first().click();
  await expect(page.locator(".composer-input")).toBeVisible();
}

export async function submit(page: Page, text: string, mode: "queue" | "steer" = "queue"): Promise<void> {
  await page.locator(".composer-input").fill(text);
  await page
    .getByRole("button", { name: mode === "queue" ? "Queue" : "Steer", exact: true })
    .click();
}

export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

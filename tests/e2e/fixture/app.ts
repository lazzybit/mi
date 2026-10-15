// Shared browser helpers for the acceptance suite. They drive the real UI and
// real server functions; nothing here stubs RPC or WebSocket results.
//
// ADR-0004: mi is single-user, so every browser test shares one application
// state and runs in development mode without Access credentials. The extended
// `test` resets that state before each case through the normal deletion and
// settings controls, which is the suite's only isolation mechanism.
import { expect, test as base, type Page } from "@playwright/test";

export const test = base.extend<{ resetApplication: void }>({
  resetApplication: [
    async ({ page }, use) => {
      await resetApplication(page);
      await use();
    },
    { auto: true },
  ],
});

export { expect };

/** Open the application and wait for the catalog to arrive. */
export async function openApp(page: Page): Promise<void> {
  await page.goto("/");
  // The create button only renders once the catalog has arrived.
  await expect(page.locator(".conversation-list > button.primary")).toBeVisible({ timeout: 90_000 });
}

/** Remove every conversation and restore the default model settings. */
export async function resetApplication(page: Page): Promise<void> {
  await openApp(page);
  for (let guard = 0; guard < 100; guard++) {
    const items = page.locator(".conversation-item");
    const count = await items.count();
    if (count === 0) break;
    await page.locator(".conversation-controls button[aria-label^='Delete ']").first().click();
    await page.getByRole("button", { name: "Delete permanently" }).click();
    await expect(items).toHaveCount(count - 1, { timeout: 60_000 });
  }
  // ADR-0002: restore the default route selection through the existing form.
  await page.getByRole("button", { name: "Settings" }).click();
  const route = page.getByLabel("Model route");
  const firstOption = await route.locator("option").first().getAttribute("value");
  if (firstOption) await route.selectOption(firstOption);
  await page.getByLabel("Gateway id").fill("mi");
  await page.getByRole("button", { name: "Save model settings" }).click();
  await expect(page.locator(".saved")).toHaveText("Saved");
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

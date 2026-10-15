import { createConversation, horizontalOverflow, openApp, expect, test } from "./fixture/app";

// ADR-0004: development access needs no Access credential. Production
// authentication rejection is covered by the Worker suite instead.
test("development access serves application state without credentials", async ({ page }) => {
  await openApp(page);
  await expect(page.getByRole("button", { name: "New conversation" })).toBeVisible();
  await createConversation(page);
  await expect(page.locator(".composer-input")).toBeVisible();
});

test("narrow shell uses touch-sized controls without horizontal overflow", async ({ page }) => {
  await openApp(page);
  const button = page.getByRole("button", { name: "New conversation" });
  const box = await button.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
});

test("orientation change keeps the composer reachable", async ({ page }) => {
  await openApp(page);
  await createConversation(page);

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator(".composer-input")).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".composer-input")).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
});

import { expect, test } from "@playwright/test";
import { createConversation, horizontalOverflow, openOwner } from "./fixture/app";

// The application shell is served without a token (Access protects it at the
// edge); application data and the composer require a verified assertion.
test("unauthenticated shell exposes no application state", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("mi");
  await expect(page.locator(".loading")).toBeVisible();
  await expect(page.locator(".composer-input")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New conversation" })).toHaveCount(0);
});

test("narrow shell uses touch-sized controls without horizontal overflow", async ({ page, context }, testInfo) => {
  await openOwner(page, context, `owner-${testInfo.testId}`);
  const button = page.getByRole("button", { name: "New conversation" });
  const box = await button.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
});

test("orientation change keeps the composer reachable", async ({ page, context }, testInfo) => {
  await openOwner(page, context, `owner-${testInfo.testId}`);
  await createConversation(page);

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator(".composer-input")).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".composer-input")).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
});

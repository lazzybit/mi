import { expect, test } from "@playwright/test";

// The application shell is served without a token (Access protects it at the
// edge); the observation socket requires a verified assertion. These checks
// cover the responsive shell and the composer. Full authenticated reconnect
// flows require fixture authentication and are recorded as pending in
// docs/mvp/TASK.md.
test("renders the shell with a touch-sized composer", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("mi");
  const composer = page.locator(".composer-input");
  await expect(composer).toBeVisible();
});

test("fits a narrow viewport without horizontal scrolling", async ({ page }) => {
  await page.goto("/");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

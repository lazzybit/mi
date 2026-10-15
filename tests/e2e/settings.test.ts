import { expect, test } from "@playwright/test";
import { openOwner, saveModel } from "./fixture/app";

test("model settings survive a reload", async ({ page, context }, testInfo) => {
  await openOwner(page, context, `owner-${testInfo.testId}`);
  await saveModel(page);

  await page.reload();
  await expect(page.getByRole("button", { name: "New conversation" })).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Settings" }).click();
  // ADR-0002: the configured route selection persists across reloads.
  await expect(page.getByLabel("Model route")).toHaveValue("dynamic/runner");
  await expect(page.getByLabel("Gateway id")).toHaveValue("mi");
});

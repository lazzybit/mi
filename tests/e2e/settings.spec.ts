import { expect, test } from "@playwright/test";
import { addFixtureConnector, openOwner, saveModel } from "./fixture/app";

test("model settings survive a reload", async ({ page, context }, testInfo) => {
  await openOwner(page, context, `owner-${testInfo.testId}`);
  await saveModel(page, "fixture-model");

  await page.reload();
  await expect(page.getByRole("button", { name: "New conversation" })).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("fixture-model");
});

test("a connector is discovered, connected, and persisted", async ({ page, context }, testInfo) => {
  await openOwner(page, context, `owner-${testInfo.testId}`);
  await addFixtureConnector(page);

  await page.reload();
  await expect(page.getByRole("button", { name: "New conversation" })).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Connectors" }).click();
  const item = page.locator(".connector-item").filter({ hasText: "Fixture" });
  await expect(item.locator(".connector-state")).toHaveText("ready", { timeout: 60_000 });
  await expect(item.locator(".connector-tools")).toHaveText("2 tools");
});

test("a skill is created, versioned, and persisted", async ({ page, context }, testInfo) => {
  await openOwner(page, context, `owner-${testInfo.testId}`);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Skills" }).click();
  await page.getByRole("button", { name: "New skill" }).click();
  await page.getByLabel("Name").fill("Reviewer");
  await page.getByLabel("Description").fill("Reviews changes");
  await page.getByLabel("Instructions").fill("Read the diff and report risks.");
  await page.getByRole("button", { name: "Save version" }).click();

  const item = page.locator(".skill-item").filter({ hasText: "Reviewer" });
  await expect(item.locator(".skill-version")).toHaveText("v1", { timeout: 60_000 });

  await item.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Description").fill("Reviews changes carefully");
  await page.getByRole("button", { name: "Save version" }).click();
  await expect(item.locator(".skill-version")).toHaveText("v2", { timeout: 60_000 });

  await page.reload();
  await expect(page.getByRole("button", { name: "New conversation" })).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Skills" }).click();
  await expect(page.locator(".skill-item").filter({ hasText: "Reviewer" })).toContainText("v2");
});

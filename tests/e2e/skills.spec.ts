import { expect, test } from "@playwright/test";
import { createConversation, openOwner } from "./fixture/app";

// Per-conversation skill selection through the wired ConversationSkillPicker.
test("selects a skill for a conversation and persists the selection", async ({ page, context }, testInfo) => {
  await openOwner(page, context, `owner-${testInfo.testId}`);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Skills" }).click();
  await page.getByRole("button", { name: "New skill" }).click();
  await page.getByLabel("Name").fill("Reviewer");
  await page.getByLabel("Description").fill("Reviews changes");
  await page.getByLabel("Instructions").fill("Read the diff and report risks.");
  await page.getByRole("button", { name: "Save version" }).click();
  await expect(page.locator(".skill-item").filter({ hasText: "Reviewer" })).toBeVisible();
  await page.getByRole("button", { name: "Chat" }).click();

  await createConversation(page);
  await page.locator(".conversation-skills summary").click();
  const checkbox = page.locator(".skill-picker").getByLabel("Reviewer");
  await checkbox.check();
  await expect(checkbox).toBeChecked();

  // The selection is durable, not only local view state.
  await page.reload();
  await expect(page.locator(".conversation-item")).toHaveCount(1, { timeout: 90_000 });
  await page.locator(".conversation-item").first().click();
  await page.locator(".conversation-skills summary").click();
  await expect(page.locator(".skill-picker").getByLabel("Reviewer")).toBeChecked();
});

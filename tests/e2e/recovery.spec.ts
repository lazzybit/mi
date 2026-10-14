import { expect, test } from "@playwright/test";
import { addFixtureConnector, createConversation, openOwner, saveModel, submit } from "./fixture/app";

// Recovery matrix (PLAN.md -> Behavior -> Remote tool interruption): a call
// dispatched before a new object generation must never be replayed and must be
// surfaced as an unresolved outcome, not as a definite success or failure.
test("surfaces an unresolved remote outcome after the object restarts", async ({ page, context }, testInfo) => {
  await openOwner(page, context, `owner-${testInfo.testId}`);
  await saveModel(page);
  await addFixtureConnector(page);
  await createConversation(page);
  await submit(page, "danger [[hang]]");

  // The fixture tool never answers, so the attempt stays dispatched.
  await expect(page.locator(".run-tool")).toBeVisible({ timeout: 120_000 });

  // Force a new object generation while the call is dispatched. The fixture
  // endpoint answers 409 until the dispatch intent is durable, and the abort
  // can drop the connection before its 204 arrives.
  await expect
    .poll(
      async () => {
        try {
          return await page.evaluate(async () => {
            const response = await fetch("/__fixture/evict", { method: "POST" });
            return response.status;
          });
        } catch {
          return 204;
        }
      },
      { timeout: 60_000 },
    )
    .toBe(204);

  // Recovery marks the attempt unknown and the run needs attention.
  const panel = page.locator(".recovery-panel");
  await expect(panel).toBeVisible({ timeout: 120_000 });
  await expect(panel).toContainText("could not be determined");
  await expect(panel).toContainText("has not been replayed");

  // The owner can resolve it; the panel is not a permanent dead end.
  await page.getByRole("button", { name: "Abandon run" }).click();
  await expect(panel).toHaveCount(0, { timeout: 60_000 });
});

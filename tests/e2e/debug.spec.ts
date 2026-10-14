import { expect, test } from "@playwright/test";
import { addFixtureConnector, createConversation, openOwner, saveModel, submit } from "./fixture/app";

test("debug recovery states", async ({ page, context }, testInfo) => {
  await openOwner(page, context, `owner-${testInfo.testId}`);
  await saveModel(page);
  await addFixtureConnector(page);
  await createConversation(page);
  await submit(page, "danger [[hang]]");
  await expect(page.locator(".run-tool")).toBeVisible({ timeout: 120_000 });
  for (let index = 0; index < 8; index += 1) {
    const info = await page
      .evaluate(async () => {
        const attempts = await (await fetch("/__fixture/attempts")).json();
        const evict = await fetch("/__fixture/evict", { method: "POST" });
        return { attempts, evict: evict.status };
      })
      .catch((error) => ({ error: String(error) }));
    console.log("DEBUG", JSON.stringify(info));
    await page.waitForTimeout(1000);
  }
});

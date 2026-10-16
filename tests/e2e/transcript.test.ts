import { expect, test as base } from "@playwright/test";
import { createConversation, horizontalOverflow, resetApplication } from "./fixture/app";
import { TranscriptFixture } from "./fixture/transcript";

// ADR-0005: the real client renderer is exercised with deterministic session
// frames so thinking and tool disclosures can be verified without a live model.
const test = base.extend<{ transcript: TranscriptFixture }>({
  transcript: async ({ page }, use) => {
    const transcript = new TranscriptFixture();
    await transcript.install(page);
    await resetApplication(page);
    // resetApplication leaves the app on Settings; return to Chat before
    // creating the conversation the transcript observes.
    await page.getByRole("button", { name: "Chat" }).click();
    await createConversation(page);
    await use(transcript);
  },
});

export { expect };

function assistantMessage(
  content: unknown[],
  options: { stopReason?: string; errorMessage?: string; timestamp?: number } = {},
): unknown {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "gateway",
    model: "dynamic/runner",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: options.stopReason ?? "stop",
    ...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
    timestamp: options.timestamp ?? 1,
  };
}

function assistantEntry(id: number, content: unknown[], options: Parameters<typeof assistantMessage>[1] = {}): unknown {
  return { id, kind: "pi.assistant", model: [assistantMessage(content, options)] };
}

function toolResultEntry(
  id: number,
  options: { callId: string; toolName: string; text: string; isError?: boolean; durationMs?: number },
): unknown {
  return {
    id,
    kind: "pi.tool-result",
    model: [
      {
        role: "toolResult",
        toolCallId: options.callId,
        toolName: options.toolName,
        content: [{ type: "text", text: options.text }],
        isError: options.isError ?? false,
        ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
        timestamp: 1,
      },
    ],
  };
}

function liveDoc(content: unknown[], timestamp = 1): unknown {
  return { generation: { attempt: 1, message: assistantMessage(content, { timestamp }) } };
}

test("shows answers directly and keeps thinking and tool details hidden", async ({ page, transcript }) => {
  transcript.setView([
    assistantEntry(1, [
      { type: "thinking", thinking: "internal reasoning" },
      { type: "text", text: "the answer" },
      { type: "toolCall", id: "call-1", name: "Bash", arguments: { command: "ls" } },
    ]),
    toolResultEntry(2, { callId: "call-1", toolName: "Bash", text: "output text", durationMs: 10000 }),
  ]);

  await expect(page.locator(".assistant-text")).toHaveText("the answer");

  const thinking = page.locator(".thinking-block .disclosure-summary");
  await expect(thinking).toHaveText("Thinking ...");
  await expect(page.locator(".thinking-text")).toBeHidden();

  const tool = page.locator(".tool-card .disclosure-summary");
  await expect(tool).toHaveText("Bash\uFF0E10s");
  await expect(page.locator(".tool-arguments")).toBeHidden();
  await expect(page.locator(".tool-result")).toBeHidden();

  await thinking.click();
  await expect(page.locator(".thinking-text")).toBeVisible();
  await expect(page.locator(".thinking-text")).toHaveText("internal reasoning");

  await tool.click();
  await expect(page.locator(".tool-arguments")).toContainText("command");
  await expect(page.locator(".tool-result")).toHaveText("output text");
});

test("activates a disclosure with the keyboard", async ({ page, transcript }) => {
  transcript.setView([
    assistantEntry(1, [
      { type: "thinking", thinking: "reasoning" },
      { type: "text", text: "answer" },
    ]),
  ]);

  const summary = page.locator(".thinking-block .disclosure-summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".thinking-text")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator(".thinking-text")).toBeHidden();
});

test("keeps a closed tool row free of previews and error badges", async ({ page, transcript }) => {
  transcript.setView([
    assistantEntry(1, [{ type: "toolCall", id: "call-1", name: "Fail", arguments: {} }]),
    toolResultEntry(2, { callId: "call-1", toolName: "Fail", text: "boom", isError: true, durationMs: 500 }),
  ]);

  const tool = page.locator(".tool-card");
  await expect(tool.locator(".disclosure-summary")).toHaveText("Fail\uFF0E1s");
  await expect(tool.locator(".tool-result")).toBeHidden();
  await expect(page.locator(".tool-state")).toHaveCount(0);
});

test("does not reset an open disclosure during streaming", async ({ page, transcript }) => {
  transcript.setView([], liveDoc([{ type: "thinking", thinking: "a" }], 1));
  const summary = page.locator(".thinking-block .disclosure-summary");
  await summary.click();
  await expect(page.locator(".thinking-text")).toHaveText("a");

  transcript.setLive(liveDoc([{ type: "thinking", thinking: "ab" }], 1));
  await expect(page.locator(".thinking-text")).toHaveText("ab");
  await expect(page.locator(".thinking-text")).toBeVisible();
});

test("committing the live message does not duplicate rows or reset expansion", async ({ page, transcript }) => {
  transcript.setView([], liveDoc([
    { type: "thinking", thinking: "reasoning" },
    { type: "text", text: "answer" },
  ], 1));
  await page.locator(".thinking-block .disclosure-summary").click();
  await expect(page.locator(".thinking-text")).toBeVisible();

  transcript.setView([
    assistantEntry(1, [
      { type: "thinking", thinking: "reasoning" },
      { type: "text", text: "answer" },
    ]),
  ]);

  await expect(page.locator(".thinking-block")).toHaveCount(1);
  await expect(page.locator(".assistant-text")).toHaveText("answer");
  await expect(page.locator(".thinking-text")).toBeVisible();
});

test("preserves call order when results arrive in reverse order", async ({ page, transcript }) => {
  transcript.setView([
    assistantEntry(1, [
      { type: "toolCall", id: "a", name: "Bash", arguments: {} },
      { type: "toolCall", id: "b", name: "Read", arguments: {} },
    ]),
    toolResultEntry(2, { callId: "b", toolName: "Read", text: "file", durationMs: 2000 }),
    toolResultEntry(3, { callId: "a", toolName: "Bash", text: "out", durationMs: 10000 }),
  ]);

  const labels = page.locator(".tool-card .disclosure-summary");
  await expect(labels).toHaveCount(2);
  await expect(labels.nth(0)).toHaveText("Bash\uFF0E10s");
  await expect(labels.nth(1)).toHaveText("Read\uFF0E2s");
});

test("pairs a split call and result when older history loads", async ({ page, transcript }) => {
  transcript.setView([
    toolResultEntry(2, { callId: "call-1", toolName: "Bash", text: "out", durationMs: 10000 }),
  ]);
  const summary = page.locator(".tool-card .disclosure-summary");
  await expect(summary).toHaveText("Bash\uFF0E10s");
  await summary.click();
  await expect(page.locator(".tool-result")).toBeVisible();

  transcript.pushHistory([
    assistantEntry(1, [{ type: "toolCall", id: "call-1", name: "Bash", arguments: { command: "ls" } }]),
  ]);
  await page.getByRole("button", { name: "Load older messages" }).click();

  await expect(page.locator(".tool-card")).toHaveCount(1);
  await expect(page.locator(".tool-card .disclosure-summary")).toHaveText("Bash\uFF0E10s");
  await expect(page.locator(".tool-result")).toBeVisible();
  await expect(page.locator(".tool-arguments")).toContainText("command");
});

test("keeps long tool labels usable on a narrow screen", async ({ page, transcript }) => {
  const name = "a-very-long-tool-name-that-should-wrap";
  transcript.setView([
    assistantEntry(1, [{ type: "toolCall", id: "call-1", name, arguments: {} }]),
    toolResultEntry(2, { callId: "call-1", toolName: name, text: "out", durationMs: 10000 }),
  ]);
  await expect(page.locator(".tool-card .disclosure-summary")).toHaveText(`${name}\uFF0E10s`);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

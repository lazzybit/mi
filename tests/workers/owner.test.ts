import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

async function rpc(
  stub: DurableObjectStub,
  method: string,
  args: unknown[],
  headers: Record<string, string> = {},
): Promise<{ status: number; body: { value?: unknown; error?: { code: string } } }> {
  const response = await stub.fetch("https://owner.internal/rpc", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ method, args }),
  });
  return { status: response.status, body: (await response.json()) as { value?: unknown; error?: { code: string } } };
}

function ownerStub(name: string, owner = name): DurableObjectStub {
  const id = env.OWNER.idFromName(name);
  void owner;
  return env.OWNER.get(id);
}

describe("OwnerObject RPC", () => {
  it("accepts a command and returns a receipt", async () => {
    const stub = ownerStub("owner-a");
    const result = await rpc(stub, "createConversation", [
      { commandId: "c1", payload: { title: "Hello" } },
    ]);
    expect(result.status).toBe(200);
    expect(result.body.value).toMatchObject({ result: { conversationId: expect.any(String) } });
  });

  it("returns the original receipt for a repeated command and conflicts on a changed payload", async () => {
    const stub = ownerStub("owner-b");
    const first = await rpc(stub, "createConversation", [
      { commandId: "dup", payload: { title: "One" } },
    ]);
    const second = await rpc(stub, "createConversation", [
      { commandId: "dup", payload: { title: "One" } },
    ]);
    expect(second.body.value).toEqual(first.body.value);

    const conflict = await rpc(stub, "createConversation", [
      { commandId: "dup", payload: { title: "Two" } },
    ]);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error?.code).toBe("CONFLICT");
  });

  it("isolates state between owners", async () => {
    const first = ownerStub("owner-c");
    const second = ownerStub("owner-d");
    await rpc(first, "createConversation", [{ commandId: "c1", payload: { title: "Mine" } }]);
    const snapshot = (await rpc(second, "snapshot", [])).body.value as { conversations: unknown[] };
    expect(snapshot.conversations).toHaveLength(0);
  });

  it("rejects invalid arguments before any domain call", async () => {
    const stub = ownerStub("owner-e");
    const response = await stub.fetch("https://owner.internal/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "createConversation" }),
    });
    expect(response.status).toBe(400);
  });

  it("persists a submission across a fresh request to the same object", async () => {
    const stub = ownerStub("owner-f");
    const created = (await rpc(stub, "createConversation", [
      { commandId: "c1", payload: { title: "Work" } },
    ])).body.value as { result: { conversationId: string } };
    await rpc(stub, "saveModelProfile", [
      {
        commandId: "m1",
        payload: {
          profile: {
            gatewayId: "g",
            provider: "p",
            model: "m",
            protocol: "openai-chat-completions",
            contextWindow: 1000,
            maxOutputTokens: 100,
          },
        },
      },
    ]);
    const submitted = await rpc(stub, "submit", [
      {
        commandId: "s1",
        payload: { conversationId: created.result.conversationId, text: "hi", mode: "queue" },
      },
    ]);
    expect(submitted.status).toBe(200);
    const snapshot = (await rpc(stub, "snapshot", [created.result.conversationId])).body.value as {
      selectedConversation: { entries: { text?: string }[] };
    };
    // The accepted input is durable immediately, regardless of whether the
    // alarm has started executing it yet.
    expect(snapshot.selectedConversation.entries.some((entry) => entry.text === "hi")).toBe(true);
  });
});

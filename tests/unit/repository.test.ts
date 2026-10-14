import { describe, expect, it } from "vitest";
import { SqlStore } from "../../src/worker/storage/SqlStore";
import { NodeSqlBackend } from "../helpers/nodeSql";
import { FixedClock, SequentialIdGenerator } from "../../src/worker/runtime/Clock";
import { RepositoryContextService } from "../../src/worker/context/RepositoryContextService";
import { ContextAssembler } from "../../src/worker/context/ContextAssembler";
import { ContextBudget, CompactionPlanner } from "../../src/worker/context/ContextBudget";
import { SkillTools } from "../../src/worker/skills/SkillTools";
import { createMcpStack } from "../../src/worker/mcp/stack";
import type { ToolInvocation } from "../../src/worker/mcp/types";
import type { RunRecord } from "../../src/worker/storage/records";

function newStore() {
  const backend = new NodeSqlBackend();
  const store = new SqlStore(backend);
  store.migrate();
  return store;
}

function setup(options: { workspaceRoot?: string } = {}) {
  const store = newStore();
  const clock = new FixedClock(1_000);
  const ids = new SequentialIdGenerator();
  const reads: string[] = [];
  const files = new Map<string, string>([
    ["AGENTS.md", "root instructions"],
    ["src/AGENTS.md", "src instructions"],
  ]);
  const service = new RepositoryContextService({
    store,
    clock,
    ids,
    workspaceRoot: () => options.workspaceRoot ?? "/workspace",
    readFile: async (path) => {
      reads.push(path);
      const content = files.get(path);
      if (content === undefined) throw new Error("not found");
      return content;
    },
  });
  return { store, service, reads, files };
}

describe("RepositoryContextService", () => {
  it("fetches missing instructions once and commits them", async () => {
    const { service, reads, store } = setup();
    const first = await service.loadForPath("src/index.ts");
    expect(first.map((item) => item.path)).toEqual(["AGENTS.md", "src/AGENTS.md"]);
    expect(first.map((item) => item.content)).toEqual(["root instructions", "src instructions"]);
    expect(reads).toEqual(["AGENTS.md", "CLAUDE.md", "src/AGENTS.md", "src/CLAUDE.md"]);
    const records = store.read((tx) => tx.repositoryInstructions.list("/workspace"));
    expect(records.filter((record) => record.present)).toHaveLength(2);
    expect(records.filter((record) => !record.present)).toHaveLength(2);

    // A second load reads committed records without fetching again.
    reads.length = 0;
    const second = await service.loadForPath("src/index.ts");
    expect(second).toHaveLength(2);
    expect(reads).toHaveLength(0);
  });

  it("reads committed records without remote I/O via applicable()", async () => {
    const { service, reads } = setup();
    await service.loadForPath("src/index.ts");
    reads.length = 0;
    const applicable = service.applicable("src/index.ts");
    expect(applicable.map((item) => item.path)).toEqual(["AGENTS.md", "src/AGENTS.md"]);
    expect(reads).toHaveLength(0);
  });

  it("rejects path traversal", async () => {
    const { service } = setup();
    await expect(service.loadForPath("../secrets")).rejects.toThrow(/traversal/);
  });

  it("requires a configured workspace", async () => {
    const store = newStore();
    const service = new RepositoryContextService({
      store,
      clock: new FixedClock(1_000),
      ids: new SequentialIdGenerator(),
      workspaceRoot: () => undefined,
      readFile: async () => "",
    });
    await expect(service.loadForPath("src/index.ts")).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(service.applicable("src/index.ts")).toEqual([]);
  });
});

describe("read_repository_instructions application tool", () => {
  const invocation: ToolInvocation = {
    runId: "r",
    conversationId: "c",
    toolCallId: "t",
    alias: "app__read_repository_instructions",
    arguments: {},
  };

  it("returns the applicable instructions through the container connector", async () => {
    const { service } = setup();
    const tools = new SkillTools(newStore(), service);
    const result = await tools.execute("app__read_repository_instructions", { path: "src/index.ts" }, invocation);
    expect(result.isError).toBe(false);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("root instructions");
    expect(text).toContain("src instructions");
  });

  it("reports a missing workspace as not configured", async () => {
    const store = newStore();
    const service = new RepositoryContextService({
      store,
      clock: new FixedClock(1_000),
      ids: new SequentialIdGenerator(),
      workspaceRoot: () => undefined,
      readFile: async () => "",
    });
    const tools = new SkillTools(store, service);
    await expect(
      tools.execute("app__read_repository_instructions", { path: "src/index.ts" }, invocation),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });
});

describe("repository instructions through the container connector", () => {
  function containerFetch(files: Record<string, string>): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = JSON.parse(await request.text()) as { id?: number; method: string; params?: unknown };
      const respond = (result: unknown) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
          headers: { "content-type": "application/json" },
        });
      if (body.method === "initialize") return respond({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") return respond({ tools: [{ name: "read", inputSchema: { type: "object" } }] });
      if (body.method === "tools/call") {
        const params = body.params as { name: string; arguments: { path?: string } };
        const content = params.arguments.path ? files[params.arguments.path] : undefined;
        if (content === undefined) return respond({ isError: true, content: [{ type: "text", text: "not found" }] });
        return respond({ content: [{ type: "text", text: content }], isError: false });
      }
      return respond({});
    }) as typeof fetch;
  }

  it("reads applicable instructions via the configured container connector", async () => {
    const store = newStore();
    store.transaction((tx) => {
      tx.settings.writeWorkspaceRoot("/workspace");
      tx.mcpServers.upsert({
        id: "container_1",
        name: "container",
        endpoint: "https://container.test/mcp",
        configurationVersion: 1,
        authenticationMode: "none",
        role: "container",
        state: "ready",
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const stack = createMcpStack({
      store,
      clock: new FixedClock(1_000),
      ids: new SequentialIdGenerator(),
      clientMetadataUrl: "",
      callbackUrl: "",
      fetchImpl: containerFetch({ "AGENTS.md": "root instructions", "src/AGENTS.md": "src instructions" }),
    });
    const prepared = await stack.router.prepare({
      runId: "r",
      conversationId: "c",
      toolCallId: "t",
      alias: "app__read_repository_instructions",
      arguments: { path: "src/index.ts" },
    });
    const outcome = await stack.router.execute(prepared, new AbortController().signal);
    const text = outcome.content[0]?.type === "text" ? outcome.content[0].text : "";
    expect(text).toContain("root instructions");
    expect(text).toContain("src instructions");
    expect(
      store.read((tx) => tx.repositoryInstructions.list("/workspace")).filter((record) => record.present),
    ).toHaveLength(2);
  });
});

describe("context assembly", () => {
  it("includes committed repository instructions without remote I/O", async () => {
    const { store, service } = setup();
    await service.loadForPath("src/index.ts");
    store.transaction((tx) => tx.settings.writeWorkspaceRoot("/workspace"));

    const assembler = new ContextAssembler({
      clock: new FixedClock(1_000),
      ids: new SequentialIdGenerator(),
      budget: new ContextBudget(),
      compaction: new CompactionPlanner(),
      listTools: () => [],
    });
    const run: RunRecord = {
      id: "run_1",
      conversationId: "conv_1",
      state: "running",
      phase: "prepare_context",
      checkpoint: { phase: "prepare_context", turnNumber: 0, pendingToolCalls: [], nextToolIndex: 0 },
      generation: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    store.transaction((tx) => {
      tx.settings.writeModelProfile(
        JSON.stringify({
          gatewayId: "g",
          provider: "p",
          model: "m",
          protocol: "openai-chat-completions",
          contextWindow: 100_000,
          maxOutputTokens: 1_000,
        }),
      );
      tx.conversations.create({ id: "conv_1", title: "T", createdAt: 1, updatedAt: 1 });
    });

    const commit = store.transaction((tx) => assembler.prepare(tx, run));
    const preparation = commit.value;
    expect(preparation.kind).toBe("ready");
    if (preparation.kind !== "ready") return;
    const snapshot = store.read((tx) => tx.contextSnapshots.get(preparation.snapshotId));
    expect(snapshot?.systemSectionsJson).toContain("root instructions");
    expect(snapshot?.systemSectionsJson).toContain("src instructions");
  });
});

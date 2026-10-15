import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import { AppError } from "../../src/shared/domain";
import type { ReplayPolicy } from "../../src/shared/domain";
import type {
  ModelEvent,
  ModelGateway,
  ModelRequest,
  PersistedModelToolCall,
} from "../../src/worker/models/types";
import type {
  DiscoveredTool,
  NormalizedToolResult,
  PreparedToolCall,
  ToolDescriptor,
  ToolExecutionOutcome,
  ToolExecutor,
  ToolInvocation,
} from "../../src/worker/mcp/types";
import type { AlarmStore } from "../../src/worker/runtime/WakeScheduler";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../../src/worker/runtime/limits";
import { FixedClock, SequentialIdGenerator } from "../../src/worker/runtime/Clock";
import { OwnerRuntime } from "../../src/worker/owner/OwnerRuntime";
import { NodeSqlBackend } from "./nodeSql";

export class FakeAlarmStore implements AlarmStore {
  alarm: number | null = null;
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(timestamp: number): Promise<void> {
    this.alarm = timestamp;
  }
  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

export type ModelScript = ModelEvent[] | ((request: ModelRequest) => ModelEvent[] | Promise<ModelEvent[]>);

/** ADR-0002: canonical pi-ai assistant message fixture for tests. */
export function assistantFixture(options: {
  text?: string;
  stopReason?: StopReason;
  toolCalls?: PersistedModelToolCall[];
  errorMessage?: string;
  thinking?: string;
}): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (options.thinking) content.push({ type: "thinking", thinking: options.thinking });
  if (options.text) content.push({ type: "text", text: options.text });
  for (const call of options.toolCalls ?? []) {
    content.push({
      type: "toolCall",
      id: call.toolCallId,
      name: call.name,
      arguments: (call.arguments ?? {}) as Record<string, never>,
    });
  }
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "fixture",
    model: "fixture-model",
    usage: {
      input: 12,
      output: 8,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: options.stopReason ?? (options.toolCalls?.length ? "toolUse" : "stop"),
    errorMessage: options.errorMessage,
    timestamp: 0,
  };
}

export class FakeModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  readonly scripts: ModelScript[] = [];
  defaultScript: ModelScript = [
    { type: "completed", message: assistantFixture({ text: "done" }) },
  ];

  push(script: ModelScript): void {
    this.scripts.push(script);
  }

  pushText(text: string, tools: PersistedModelToolCall[] = []): void {
    this.scripts.push([
      { type: "text_delta", text },
      { type: "completed", message: assistantFixture({ text, toolCalls: tools }) },
    ]);
  }

  /** Push a scripted terminal assistant message (any stop reason). */
  pushAssistant(message: AssistantMessage): void {
    this.scripts.push([{ type: "completed", message }]);
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const script = this.scripts.shift() ?? this.defaultScript;
    const events = typeof script === "function" ? await script(request) : script;
    for (const event of events) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      yield event;
    }
  }
}

export interface FakeTool {
  remoteName: string;
  role?: "container" | "web-research";
  replayPolicy: ReplayPolicy;
  result?: ToolExecutionOutcome;
  handler?: (arguments_: unknown, signal: AbortSignal) => Promise<ToolExecutionOutcome> | ToolExecutionOutcome;
}

export class FakeToolExecutor implements ToolExecutor {
  readonly registered = new Map<string, FakeTool>();
  readonly calls: { alias: string; arguments: unknown }[] = [];
  private catalogVersion = 1;

  register(alias: string, tool: FakeTool): void {
    this.registered.set(alias, tool);
  }

  descriptor(alias: string): ToolDescriptor {
    const tool = this.registered.get(alias);
    if (!tool) throw new AppError("NOT_FOUND", `unknown tool ${alias}`);
    return {
      alias,
      connectorId: `connector_${tool.role ?? "fake"}`,
      connectorVersion: 1,
      catalogVersion: this.catalogVersion,
      remoteName: tool.remoteName,
      description: `fake ${alias}`,
      inputSchema: { type: "object" },
    };
  }

  async prepare(invocation: ToolInvocation): Promise<PreparedToolCall> {
    const tool = this.registered.get(invocation.alias);
    if (!tool) throw new AppError("CONNECTOR_UNAVAILABLE", `no connector for ${invocation.alias}`);
    return {
      toolCallId: invocation.toolCallId,
      descriptor: this.descriptor(invocation.alias),
      connector: {
        id: `connector_${tool.role ?? "fake"}`,
        version: 1,
        name: "fake",
        endpoint: "https://fake.test/mcp",
        auth: { mode: "none" },
        role: tool.role,
      },
      remoteName: tool.remoteName,
      arguments: invocation.arguments,
      replayPolicy: tool.replayPolicy,
    };
  }

  async execute(call: PreparedToolCall, signal: AbortSignal): Promise<ToolExecutionOutcome> {
    this.calls.push({ alias: call.descriptor.alias, arguments: call.arguments });
    const tool = this.registered.get(call.descriptor.alias);
    if (!tool) throw new AppError("CONNECTOR_UNAVAILABLE", "unknown tool");
    if (tool.handler) return tool.handler(call.arguments, signal);
    return tool.result ?? { isError: false, content: [{ type: "text", text: "ok" }] };
  }
}

export interface TestRuntimeOptions<M extends ModelGateway = FakeModelGateway> {
  model?: M;
  tools?: FakeToolExecutor;
  limits?: Partial<RuntimeLimits>;
  baseInstructions?: string;
}

export function createTestRuntime<M extends ModelGateway = FakeModelGateway>(
  options: TestRuntimeOptions<M> = {},
) {
  const backend = new NodeSqlBackend();
  const result = createRuntimeOnBackend<M>(backend, options);
  return { ...result, backend };
}

export function createRuntimeOnBackend<M extends ModelGateway = FakeModelGateway>(
  backend: NodeSqlBackend,
  options: TestRuntimeOptions<M> = {},
) {
  const alarms = new FakeAlarmStore();
  const clock = new FixedClock(1_000);
  const ids = new SequentialIdGenerator();
  const model = (options.model ?? new FakeModelGateway()) as M;
  const tools = options.tools ?? new FakeToolExecutor();
  const runtime = new OwnerRuntime({
    backend,
    alarms,
    model,
    tools,
    clock,
    ids,
    limits: { ...DEFAULT_RUNTIME_LIMITS, ...options.limits },
    baseInstructions: options.baseInstructions,
  });
  runtime.start();
  return { runtime, alarms, clock, ids, model, tools };
}

let commandCounter = 0;
export function envelope<T>(payload: T): { commandId: string; payload: T } {
  commandCounter += 1;
  return { commandId: `cmd_${commandCounter}`, payload };
}

/** Historical concrete profile shape (pre-ADR-0002), used by legacy tests. */
export const TEST_MODEL_PROFILE = {
  gatewayId: "test-gateway",
  provider: "test-provider",
  model: "test-model",
  protocol: "openai-chat-completions" as const,
  contextWindow: 128_000,
  maxOutputTokens: 4_096,
};

export async function bootstrapConversation(
  runtime: OwnerRuntime,
): Promise<{ conversationId: string }> {
  await runtime.dispatch("saveModelProfile", [
    envelope({ settings: { gatewayId: "test-gateway", routeId: "dynamic/runner" } }),
  ]);
  const receipt = (await runtime.dispatch("createConversation", [
    envelope({ title: "Test" }),
  ])) as { result: { conversationId: string } };
  return receipt.result;
}

export function descriptorFixture(alias: string): DiscoveredTool {
  return { name: alias, description: alias, inputSchema: { type: "object" } };
}

export type { NormalizedToolResult };

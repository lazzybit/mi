import { describe, expect, it } from "vitest";
import { RunMachine, type RuntimeEvent } from "../../src/worker/runtime/RunMachine";
import type { RunCheckpoint, RunRecord } from "../../src/worker/storage/records";

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const checkpoint: RunCheckpoint = {
    phase: "prepare_context",
    turnNumber: 0,
    pendingToolCalls: [],
    nextToolIndex: 0,
    ...overrides.checkpoint,
  };
  return {
    id: "run_1",
    conversationId: "conv_1",
    state: "queued",
    phase: checkpoint.phase,
    checkpoint,
    generation: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

interface Case {
  name: string;
  run: RunRecord;
  event: RuntimeEvent;
  expectState?: RunRecord["state"];
  expectPhase?: RunCheckpoint["phase"];
  throws?: boolean;
}

const tools = [{ toolCallId: "call_1", alias: "read", arguments: {} }];

const cases: Case[] = [
  {
    name: "queued + start",
    run: makeRun(),
    event: { type: "start" },
    expectState: "running",
    expectPhase: "prepare_context",
  },
  {
    name: "prepare_context + context_ready",
    run: makeRun({ state: "running", phase: "prepare_context" }),
    event: { type: "context_ready", snapshotId: "ctx_1" },
    expectState: "running",
    expectPhase: "request_model",
  },
  {
    name: "prepare_context + compaction_required",
    run: makeRun({ state: "running", phase: "prepare_context" }),
    event: { type: "compaction_required" },
    expectState: "running",
    expectPhase: "compact_context",
  },
  {
    name: "compact_context + context_ready",
    run: makeRun({ state: "running", phase: "compact_context" }),
    event: { type: "context_ready", snapshotId: "ctx_2" },
    expectState: "running",
    expectPhase: "request_model",
  },
  {
    name: "request_model + model_finished without tools completes",
    run: makeRun({ state: "running", phase: "request_model" }),
    event: { type: "model_finished", entryId: "entry_1", tools: [] },
    expectState: "completed",
    expectPhase: "finish_turn",
  },
  {
    name: "request_model + model_finished with tools executes them",
    run: makeRun({ state: "running", phase: "request_model" }),
    event: { type: "model_finished", entryId: "entry_1", tools },
    expectState: "running",
    expectPhase: "execute_tools",
  },
  {
    name: "execute_tools + tool_finished with more tools stays",
    run: makeRun({
      state: "running",
      phase: "execute_tools",
      checkpoint: { phase: "execute_tools", turnNumber: 0, pendingToolCalls: [...tools, ...tools], nextToolIndex: 0 },
    }),
    event: { type: "tool_finished", attemptId: "attempt_1" },
    expectState: "running",
    expectPhase: "execute_tools",
  },
  {
    name: "execute_tools + tool_finished on last tool returns to context",
    run: makeRun({
      state: "running",
      phase: "execute_tools",
      checkpoint: { phase: "execute_tools", turnNumber: 0, pendingToolCalls: tools, nextToolIndex: 0 },
    }),
    event: { type: "tool_finished", attemptId: "attempt_1" },
    expectState: "running",
    expectPhase: "prepare_context",
  },
  {
    name: "running + authentication_required pauses",
    run: makeRun({
      state: "running",
      phase: "request_model",
      checkpoint: { phase: "request_model", turnNumber: 0, pendingToolCalls: [], nextToolIndex: 0 },
    }),
    event: { type: "authentication_required", connectorId: "conn_1" },
    expectState: "waiting_for_auth",
    expectPhase: "request_model",
  },
  {
    name: "running + remote_outcome_unknown needs attention",
    run: makeRun({
      state: "running",
      phase: "execute_tools",
      checkpoint: { phase: "execute_tools", turnNumber: 0, pendingToolCalls: [], nextToolIndex: 0 },
    }),
    event: { type: "remote_outcome_unknown", attemptId: "attempt_1" },
    expectState: "needs_attention",
    expectPhase: "execute_tools",
  },
  {
    name: "running + cancel_requested cancels",
    run: makeRun({ state: "running", phase: "request_model" }),
    event: { type: "cancel_requested" },
    expectState: "cancelled",
    expectPhase: "finish_turn",
  },
  {
    name: "running + definite_failure fails",
    run: makeRun({ state: "running", phase: "request_model" }),
    event: { type: "definite_failure", code: "X" },
    expectState: "failed",
    expectPhase: "finish_turn",
  },
  {
    name: "completed + start is rejected",
    run: makeRun({ state: "completed", phase: "finish_turn" }),
    event: { type: "start" },
    throws: true,
  },
  {
    name: "queued + model_finished is rejected",
    run: makeRun(),
    event: { type: "model_finished", entryId: "e", tools: [] },
    throws: true,
  },
  {
    name: "request_model + context_ready is rejected",
    run: makeRun({ state: "running", phase: "request_model" }),
    event: { type: "context_ready", snapshotId: "ctx" },
    throws: true,
  },
  {
    name: "cancelled + cancel_requested is rejected",
    run: makeRun({ state: "cancelled", phase: "finish_turn" }),
    event: { type: "cancel_requested" },
    throws: true,
  },
];

describe("RunMachine", () => {
  const machine = new RunMachine();
  for (const testCase of cases) {
    it(testCase.name, () => {
      if (testCase.throws) {
        expect(() => machine.transition(testCase.run, testCase.event)).toThrow();
        return;
      }
      const transition = machine.transition(testCase.run, testCase.event);
      expect(transition.nextState).toBe(testCase.expectState);
      expect(transition.nextCheckpoint.phase).toBe(testCase.expectPhase);
    });
  }
});

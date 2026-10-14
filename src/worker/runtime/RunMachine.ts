// Pure run transition function (PLAN.md -> Execution engine). Performs no I/O
// and writes no SQL; the driver coordinates effects.

import type { AttemptId, ConnectorId, RunState } from "../../shared/domain";
import type { PersistedToolCall, RunCheckpoint, RunRecord } from "../storage/records";

export type RuntimeEvent =
  | { type: "start"; contextSnapshotId?: string }
  | { type: "context_ready"; snapshotId: string }
  | { type: "compaction_required" }
  | { type: "model_finished"; entryId: string; tools: PersistedToolCall[] }
  | { type: "tool_finished"; attemptId: AttemptId }
  | { type: "authentication_required"; connectorId: ConnectorId }
  | { type: "remote_outcome_unknown"; attemptId: AttemptId }
  | { type: "cancel_requested" }
  | { type: "definite_failure"; code: string };

export type RuntimeEffect =
  | { type: "assemble_context" }
  | { type: "compact_context" }
  | { type: "request_model" }
  | { type: "execute_tools" }
  | { type: "finish" }
  | { type: "pause_for_auth"; connectorId: ConnectorId }
  | { type: "attention"; attemptId: AttemptId };

export interface RunTransition {
  nextState: RunState;
  nextCheckpoint: RunCheckpoint;
  effects: RuntimeEffect[];
}

export class InvalidTransitionError extends Error {
  constructor(run: RunRecord, event: RuntimeEvent) {
    super(`invalid run transition: state=${run.state} phase=${run.phase} event=${event.type}`);
    this.name = "InvalidTransitionError";
  }
}

export class RunMachine {
  transition(run: RunRecord, event: RuntimeEvent): RunTransition {
    const checkpoint: RunCheckpoint = {
      ...run.checkpoint,
      pendingToolCalls: [...run.checkpoint.pendingToolCalls],
    };

    switch (event.type) {
      case "start": {
        if (run.state !== "queued") throw new InvalidTransitionError(run, event);
        if (event.contextSnapshotId) checkpoint.contextSnapshotId = event.contextSnapshotId;
        return {
          nextState: "running",
          nextCheckpoint: checkpoint,
          effects: [{ type: "assemble_context" }],
        };
      }

      case "context_ready": {
        if (run.state !== "running") throw new InvalidTransitionError(run, event);
        if (run.phase !== "prepare_context" && run.phase !== "compact_context") {
          throw new InvalidTransitionError(run, event);
        }
        checkpoint.contextSnapshotId = event.snapshotId;
        checkpoint.phase = "request_model";
        return {
          nextState: "running",
          nextCheckpoint: checkpoint,
          effects: [{ type: "request_model" }],
        };
      }

      case "compaction_required": {
        if (run.state !== "running" || run.phase !== "prepare_context") {
          throw new InvalidTransitionError(run, event);
        }
        checkpoint.phase = "compact_context";
        return {
          nextState: "running",
          nextCheckpoint: checkpoint,
          effects: [{ type: "compact_context" }],
        };
      }

      case "model_finished": {
        if (run.state !== "running" || run.phase !== "request_model") {
          throw new InvalidTransitionError(run, event);
        }
        checkpoint.assistantEntryId = event.entryId;
        if (event.tools.length > 0) {
          checkpoint.pendingToolCalls = event.tools;
          checkpoint.nextToolIndex = 0;
          checkpoint.phase = "execute_tools";
          return {
            nextState: "running",
            nextCheckpoint: checkpoint,
            effects: [{ type: "execute_tools" }],
          };
        }
        checkpoint.pendingToolCalls = [];
        checkpoint.nextToolIndex = 0;
        checkpoint.phase = "finish_turn";
        return {
          nextState: "completed",
          nextCheckpoint: checkpoint,
          effects: [{ type: "finish" }],
        };
      }

      case "tool_finished": {
        if (run.state !== "running" || run.phase !== "execute_tools") {
          throw new InvalidTransitionError(run, event);
        }
        const nextIndex = checkpoint.nextToolIndex + 1;
        if (nextIndex < checkpoint.pendingToolCalls.length) {
          checkpoint.nextToolIndex = nextIndex;
          return {
            nextState: "running",
            nextCheckpoint: checkpoint,
            effects: [{ type: "execute_tools" }],
          };
        }
        checkpoint.pendingToolCalls = [];
        checkpoint.nextToolIndex = 0;
        checkpoint.turnNumber += 1;
        checkpoint.phase = "prepare_context";
        return {
          nextState: "running",
          nextCheckpoint: checkpoint,
          effects: [{ type: "assemble_context" }],
        };
      }

      case "authentication_required": {
        if (run.state !== "running" && run.state !== "queued") {
          throw new InvalidTransitionError(run, event);
        }
        return {
          nextState: "waiting_for_auth",
          nextCheckpoint: checkpoint,
          effects: [{ type: "pause_for_auth", connectorId: event.connectorId }],
        };
      }

      case "remote_outcome_unknown": {
        if (run.state !== "running") throw new InvalidTransitionError(run, event);
        return {
          nextState: "needs_attention",
          nextCheckpoint: checkpoint,
          effects: [{ type: "attention", attemptId: event.attemptId }],
        };
      }

      case "cancel_requested": {
        if (run.state === "completed" || run.state === "cancelled" || run.state === "failed") {
          throw new InvalidTransitionError(run, event);
        }
        checkpoint.phase = "finish_turn";
        return {
          nextState: "cancelled",
          nextCheckpoint: checkpoint,
          effects: [{ type: "finish" }],
        };
      }

      case "definite_failure": {
        if (run.state === "completed" || run.state === "cancelled" || run.state === "failed") {
          throw new InvalidTransitionError(run, event);
        }
        checkpoint.phase = "finish_turn";
        return {
          nextState: "failed",
          nextCheckpoint: checkpoint,
          effects: [{ type: "finish" }],
        };
      }

      default: {
        const exhaustive: never = event;
        throw new Error(`unhandled runtime event: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
}

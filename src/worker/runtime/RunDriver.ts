// Alarm-backed server-side driver (PLAN.md -> Execution engine). The driver
// coordinates effects; `RunMachine` owns the pure transitions.

import { AppError, type AttemptId, type RunId } from "../../shared/domain";
import type { ViewChange } from "../../shared/wire";
import type { Commit, SqlStore, StoreTransaction } from "../storage/SqlStore";
import type { AttemptRecord, EntryRecord, PersistedToolCall, RunRecord } from "../storage/records";
import { projectAttempt, projectEntry, projectRun, projectSubmission } from "../storage/projections";
import type { ContextAssembler } from "../context/ContextAssembler";
import { buildHistory } from "../context/ContextAssembler";
import type { ToolExecutor, PreparedToolCall } from "../mcp/types";
import type { ModelAttemptResult, ModelRequest } from "../models/types";
import type { Clock, IdGenerator } from "./Clock";
import { AttemptAbortedError, AttemptExecutor } from "./AttemptExecutor";
import { OutputCommitter } from "./OutputCommitter";
import { RunMachine, type RuntimeEvent } from "./RunMachine";
import { WakeScheduler } from "./WakeScheduler";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "./limits";

export interface RunDriverDeps {
  store: SqlStore;
  clock: Clock;
  ids: IdGenerator;
  machine: RunMachine;
  context: ContextAssembler;
  executor: AttemptExecutor;
  tools: ToolExecutor;
  committer: OutputCommitter;
  wake: WakeScheduler;
  limits?: RuntimeLimits;
  publish(commit: Commit<unknown>): void;
}

type StepStatus = "continue" | "paused" | "terminal" | "budget";

export class RunDriver {
  private readonly limits: RuntimeLimits;
  private readonly activeControllers = new Map<RunId, AbortController>();
  private driving = false;

  constructor(private readonly deps: RunDriverDeps) {
    this.limits = deps.limits ?? DEFAULT_RUNTIME_LIMITS;
  }

  signalCancellation(runId: RunId): void {
    this.activeControllers.get(runId)?.abort("cancelled");
  }

  async driveSlice(): Promise<void> {
    if (this.driving) return;
    this.driving = true;
    try {
      const deadline = this.deps.clock.now() + this.limits.sliceBudgetMs;
      for (;;) {
        if (this.deps.clock.now() >= deadline) break;
        const didWork = await this.driveNextRun(deadline);
        if (!didWork) break;
      }
      await this.reconcileWake();
    } finally {
      this.driving = false;
    }
  }

  /** Called by the alarm handler before selecting work. */
  private async reconcileWake(): Promise<void> {
    const next = this.deps.store.read((tx) => {
      const active = tx.runs.activeRuns();
      const runnable = active.find((run) => run.state === "running" || run.state === "queued");
      if (!runnable) return null;
      return this.deps.clock.now();
    });
    await this.deps.wake.reconcile(next);
  }

  private async driveNextRun(deadline: number): Promise<boolean> {
    const selected = this.deps.store.read((tx) => {
      const active = tx.runs.activeRuns();
      const running = active.find((run) => run.state === "running");
      if (running) return running;
      const blocked = active.find(
        (run) => run.state === "waiting_for_auth" || run.state === "needs_attention",
      );
      if (blocked) return undefined;
      return active.find((run) => run.state === "queued");
    });
    if (!selected) return false;

    let run = selected;
    if (run.state === "queued") {
      run = this.applyTransition(run, { type: "start" });
    }
    await this.runLoop(run, deadline);
    return true;
  }

  private async runLoop(initial: RunRecord, deadline: number): Promise<void> {
    let run = initial;
    for (;;) {
      run = this.reload(run.id) ?? run;
      if (run.state === "completed" || run.state === "cancelled" || run.state === "failed") return;
      if (run.state === "waiting_for_auth" || run.state === "needs_attention") return;
      if (run.cancelRequestedAt !== undefined && run.phase !== "finish_turn") {
        run = this.applyTransition(run, { type: "cancel_requested" });
        return;
      }
      if (this.deps.clock.now() >= deadline) return;

      let status: StepStatus;
      switch (run.phase) {
        case "prepare_context":
          status = await this.stepPrepareContext(run);
          break;
        case "compact_context":
          status = await this.stepCompactContext(run);
          break;
        case "request_model":
          status = await this.stepRequestModel(run);
          break;
        case "execute_tools":
          status = await this.stepExecuteTools(run);
          break;
        case "finish_turn":
          return;
        default:
          return;
      }
      if (status === "paused" || status === "terminal" || status === "budget") return;
    }
  }

  /** Mark the queued submissions that started this run as accepted. */
  private claimQueuedInput(run: RunRecord): void {
    const queued = this.deps.store
      .read((tx) => tx.submissions.listQueuedForConversation(run.conversationId))
      .filter((submission) => submission.runId === run.id);
    if (queued.length === 0) return;
    const commit = this.deps.store.transaction((tx) => {
      for (const submission of queued) tx.submissions.setState(submission.id, "accepted");
      tx.changes.push({
        kind: "inbox.replace",
        conversationId: run.conversationId,
        values: tx.submissions.listQueuedForConversation(run.conversationId).map(projectSubmission),
      });
    });
    this.deps.publish(commit);
  }

  /** Append steering input at the tool-round boundary. */
  private consumeSteering(run: RunRecord): void {
    const steering = this.deps.store.read((tx) => tx.submissions.listSteeringForRun(run.id));
    if (steering.length === 0) return;
    const commit = this.deps.store.transaction((tx) => {
      for (const submission of steering) {
        tx.submissions.setState(submission.id, "accepted");
        const entry = this.newEntry(tx, run, "user", submission.content, undefined);
        tx.changes.push({
          kind: "entry.append",
          conversationId: run.conversationId,
          value: projectEntry(entry),
        });
      }
      tx.changes.push({
        kind: "inbox.replace",
        conversationId: run.conversationId,
        values: tx.submissions.listQueuedForConversation(run.conversationId).map(projectSubmission),
      });
    });
    this.deps.publish(commit);
  }

  private reload(runId: RunId): RunRecord | undefined {
    return this.deps.store.read((tx) => tx.runs.get(runId));
  }

  private applyTransition(
    run: RunRecord,
    event: RuntimeEvent,
    mutate?: (tx: StoreTransaction, transition: ReturnType<RunMachine["transition"]>) => void,
  ): RunRecord {
    const transition = this.deps.machine.transition(run, event);
    const updated: RunRecord = {
      ...run,
      state: transition.nextState,
      phase: transition.nextCheckpoint.phase,
      checkpoint: transition.nextCheckpoint,
      updatedAt: this.deps.clock.now(),
    };
    const commit = this.deps.store.transaction((tx) => {
      tx.runs.update(updated);
      mutate?.(tx, transition);
      tx.changes.push({
        kind: "run.update",
        conversationId: run.conversationId,
        value: projectRun(updated),
      });
    });
    this.deps.publish(commit);
    return updated;
  }

  private async stepPrepareContext(run: RunRecord): Promise<StepStatus> {
    this.claimQueuedInput(run);
    this.consumeSteering(run);
    const commit = this.deps.store.transaction((tx) => this.deps.context.prepare(tx, run));
    this.deps.publish(commit);
    const value = commit.value;
    if (value.kind === "ready") {
      this.applyTransition(run, { type: "context_ready", snapshotId: value.snapshotId });
      return "continue";
    }
    this.applyTransition(run, {
      type: "compaction_required",
      requestArtifactId: value.requestArtifactId,
    });
    return "continue";
  }

  private async stepCompactContext(run: RunRecord): Promise<StepStatus> {
    const outcome = await this.executeModelAttempt(run, "compaction");
    if (outcome.status !== "succeeded") return outcome.status;
    // The summary entry was persisted by the compaction attempt; summaries
    // coexist with the original entries. Return to preparation.
    const next: RunRecord = {
      ...run,
      phase: "prepare_context",
      checkpoint: { ...run.checkpoint, phase: "prepare_context" },
    };
    this.deps.store.transaction((tx) => tx.runs.update(next));
    return "continue";
  }

  private async stepRequestModel(run: RunRecord): Promise<StepStatus> {
    const outcome = await this.executeModelAttempt(run, "model");
    if (outcome.status !== "succeeded") return outcome.status;
    const tools = outcome.toolCalls;
    const updated = this.applyTransition(run, {
      type: "model_finished",
      entryId: outcome.entryId,
      tools,
    });
    return updated.state === "completed" ? "terminal" : "continue";
  }

  private async stepExecuteTools(run: RunRecord): Promise<StepStatus> {
    const checkpoint = run.checkpoint;
    const tool = checkpoint.pendingToolCalls[checkpoint.nextToolIndex];
    if (!tool) {
      this.applyTransition(run, { type: "tool_finished", attemptId: "none" });
      return "continue";
    }
    const status = await this.executeToolAttempt(run, tool);
    if (status !== "continue") return status;
    const updated = this.applyTransition(run, { type: "tool_finished", attemptId: tool.toolCallId });
    return updated.phase === "request_model" ? "continue" : "continue";
  }

  // -------------------------------------------------------------------------
  // Model attempts
  // -------------------------------------------------------------------------

  private async executeModelAttempt(
    run: RunRecord,
    kind: "model" | "compaction",
  ): Promise<
    | { status: "succeeded"; text: string; toolCalls: PersistedToolCall[]; entryId: string }
    | { status: "paused" | "terminal" | "budget" }
  > {
    const attemptId = this.deps.ids.next("attempt");
    let modelRequest: ModelRequest;
    if (kind === "compaction") {
      const profile = this.deps.store.read((tx) => this.deps.context.requireProfile(tx));
      const entries = this.deps.store.read((tx) => tx.entries.listRecent(run.conversationId, 200));
      modelRequest = {
        attemptId,
        profile,
        system:
          "Summarize the conversation so far. Preserve the objective, corrections, accepted decisions, files and commits, completed verification, outstanding work, and any unresolved remote-operation outcomes. Do not claim uncertain outcomes succeeded.",
        history: buildHistory(entries),
        tools: [],
      };
    } else {
      const snapshotId = run.checkpoint.contextSnapshotId;
      if (!snapshotId) {
        this.applyTransition(run, { type: "definite_failure", code: "NO_CONTEXT" });
        return { status: "terminal" };
      }
      const request = this.deps.store.read((tx) => this.deps.context.materialize(tx, snapshotId));
      modelRequest = { ...request, attemptId };
    }

    const now = this.deps.clock.now();
    const attempt: AttemptRecord = {
      id: attemptId,
      runId: run.id,
      conversationId: run.conversationId,
      kind,
      state: "prepared",
      generation: run.generation,
      replayPolicy: "safe",
      createdAt: now,
      updatedAt: now,
    };
    const requestArtifactId = this.storeArtifact(
      JSON.stringify(modelRequest),
      "application/json",
    );
    attempt.requestArtifactId = requestArtifactId;
    this.insertAttempt(run, attempt);

    attempt.state = "dispatched";
    attempt.updatedAt = this.deps.clock.now();
    this.updateAttempt(run, attempt);
    await this.deps.wake.ensureWakeBy(this.deps.clock.now() + this.limits.recoveryWakeIntervalMs);

    const outcome = await this.runModelAttempt(run, attempt, modelRequest);

    if (!outcome.ok) {
      if (outcome.reason === "failed") return { status: "terminal" };
      this.settleModelInterruption(run, attempt, outcome.reason);
      return { status: outcome.reason === "deadline" ? "budget" : "paused" };
    }

    const result = outcome.value;
    const committed = this.deps.committer.close(attemptId);
    const text = result.text || committed;

    let entryId = "";
    const tools: PersistedToolCall[] = result.toolCalls.map((call) => ({
      toolCallId: call.toolCallId,
      alias: call.name,
      arguments: call.arguments,
    }));

    const commit = this.deps.store.transaction((tx) => {
      const metadata: Record<string, unknown> = {};
      if (result.toolCalls.length > 0) metadata.toolCalls = result.toolCalls;
      if (result.native !== undefined) metadata.native = result.native;
      if (result.usage !== undefined) metadata.usage = result.usage;
      const entry = this.newEntry(tx, run, kind === "compaction" ? "summary" : "assistant", text, attemptId, metadata);
      entryId = entry.id;
      tx.liveOutput.clear(attemptId);
      attempt.state = "succeeded";
      attempt.updatedAt = this.deps.clock.now();
      tx.attempts.update(attempt);
      tx.changes.push({
        kind: "entry.append",
        conversationId: run.conversationId,
        value: projectEntry(entry),
      });
      tx.changes.push({
        kind: "attempt.update",
        conversationId: run.conversationId,
        value: projectAttempt(attempt),
      });
      // Display cards for tool calls (the assistant metadata carries the model
      // representation).
      for (const call of result.toolCalls) {
        const callEntry = this.newEntry(
          tx,
          run,
          "tool_call",
          undefined,
          attemptId,
          { arguments: call.arguments, alias: call.name },
          call.toolCallId,
          call.name,
        );
        tx.changes.push({
          kind: "entry.append",
          conversationId: run.conversationId,
          value: projectEntry(callEntry),
        });
      }
    });
    this.deps.publish(commit);
    return { status: "succeeded", text, toolCalls: tools, entryId };
  }

  private async runModelAttempt(
    run: RunRecord,
    attempt: AttemptRecord,
    request: ModelRequest,
  ): Promise<
    | { ok: true; value: ModelAttemptResult }
    | { ok: false; reason: "cancelled" | "deadline" | "failed" }
  > {
    try {
      return await this.withExternalBudget(run.id, (signal) =>
        this.deps.executor.executeModel(attempt.id, request, signal),
      );
    } catch (error) {
      // A gateway/transport failure is a definite failure, not an interruption.
      this.settleModelFailure(run, attempt, error);
      return { ok: false, reason: "failed" };
    }
  }

  private settleModelFailure(run: RunRecord, attempt: AttemptRecord, error: unknown): void {
    attempt.state = "failed";
    attempt.errorCode = error instanceof AppError ? error.code : "MODEL_ERROR";
    attempt.errorMessage = error instanceof Error ? error.message : "model request failed";
    attempt.updatedAt = this.deps.clock.now();
    const commit = this.deps.store.transaction((tx) => {
      tx.attempts.update(attempt);
      tx.changes.push({
        kind: "attempt.update",
        conversationId: run.conversationId,
        value: projectAttempt(attempt),
      });
    });
    this.deps.publish(commit);
    this.applyTransition(run, { type: "definite_failure", code: attempt.errorCode ?? "MODEL_ERROR" });
  }

  private settleModelInterruption(
    run: RunRecord,
    attempt: AttemptRecord,
    reason: "cancelled" | "deadline",
  ): void {
    const count = this.deps.store.read((tx) => tx.attempts.countForRunKind(run.id, attempt.kind));
    const canRetry = reason === "deadline" && count < this.limits.maxModelAttempts;
    attempt.state = canRetry ? "interrupted" : "failed";
    attempt.errorCode = reason === "deadline" ? "MODEL_INTERRUPTED" : "MODEL_CANCELLED";
    attempt.errorMessage = reason === "deadline" ? "model attempt exceeded its budget" : "cancelled";
    attempt.updatedAt = this.deps.clock.now();

    const commit = this.deps.store.transaction((tx) => {
      // Retain committed partial output as an interrupted assistant entry so a
      // regenerated answer is never appended onto it as one stream.
      const live = tx.liveOutput.get(attempt.id);
      if (live && live.content.length > 0) {
        const entry = this.newEntry(tx, run, "assistant", live.content, attempt.id, {
          interrupted: true,
        });
        tx.changes.push({
          kind: "entry.append",
          conversationId: run.conversationId,
          value: projectEntry(entry),
        });
        tx.liveOutput.clear(attempt.id);
      }
      tx.attempts.update(attempt);
      tx.changes.push({
        kind: "attempt.update",
        conversationId: run.conversationId,
        value: projectAttempt(attempt),
      });
    });
    this.deps.publish(commit);

    if (canRetry) {
      // Replacement attempt from the same valid context boundary.
      const retry = {
        ...attempt,
        id: this.deps.ids.next("attempt"),
        state: "prepared" as const,
        parentAttemptId: attempt.id,
        resultArtifactId: undefined,
        uncertaintyJson: undefined,
        errorCode: undefined,
        errorMessage: undefined,
        createdAt: this.deps.clock.now(),
        updatedAt: this.deps.clock.now(),
      };
      this.insertAttempt(run, retry);
      return;
    }
    if (reason === "cancelled") {
      this.applyTransition(run, { type: "cancel_requested" });
    } else {
      this.applyTransition(run, { type: "definite_failure", code: "MODEL_FAILED" });
    }
  }

  // -------------------------------------------------------------------------
  // Tool attempts
  // -------------------------------------------------------------------------

  private async executeToolAttempt(run: RunRecord, tool: PersistedToolCall): Promise<StepStatus> {
    let prepared: PreparedToolCall;
    try {
      prepared = await this.deps.tools.prepare({
        runId: run.id,
        conversationId: run.conversationId,
        toolCallId: tool.toolCallId,
        alias: tool.alias,
        arguments: tool.arguments,
      });
    } catch (error) {
      if (error instanceof AppError && error.code === "AUTH_REQUIRED") {
        const connectorId = tool.connectorId ?? "unknown";
        this.applyTransition(run, { type: "authentication_required", connectorId });
        return "paused";
      }
      this.recordToolError(run, tool, error);
      return "continue";
    }

    let retries = 0;
    for (;;) {
      const attemptId = this.deps.ids.next("attempt");
      const now = this.deps.clock.now();
      const attempt: AttemptRecord = {
        id: attemptId,
        runId: run.id,
        conversationId: run.conversationId,
        kind: "tool",
        state: "prepared",
        generation: run.generation,
        replayPolicy: prepared.replayPolicy,
        connectorId: prepared.descriptor?.connectorId,
        connectorVersion: prepared.descriptor?.connectorVersion,
        catalogVersion: prepared.descriptor?.catalogVersion,
        toolName: prepared.descriptor?.alias,
        remoteName: prepared.remoteName,
        toolCallId: tool.toolCallId,
        createdAt: now,
        updatedAt: now,
      };
      attempt.requestArtifactId = this.storeArtifact(JSON.stringify(prepared.arguments), "application/json");
      this.insertAttempt(run, attempt);

      attempt.state = "dispatched";
      attempt.updatedAt = this.deps.clock.now();
      this.updateAttempt(run, attempt);
      await this.deps.wake.ensureWakeBy(this.deps.clock.now() + this.limits.recoveryWakeIntervalMs);

      const outcome = await this.withExternalBudget(run.id, (signal) =>
        this.deps.executor.executeTool(prepared, signal),
      );

      if (outcome.ok) {
        const artifactId = this.storeArtifact(
          JSON.stringify(outcome.value),
          "application/json",
        );
        const resultText = renderToolResult(outcome.value);
        const commit = this.deps.store.transaction((tx) => {
          const entry = this.newEntry(
            tx,
            run,
            "tool_result",
            resultText,
            attemptId,
            { structured: outcome.value.structuredContent },
            tool.toolCallId,
            tool.alias,
            outcome.value.isError,
          );
          tx.changes.push({
            kind: "entry.append",
            conversationId: run.conversationId,
            value: projectEntry(entry),
          });
          attempt.state = "succeeded";
          attempt.resultArtifactId = artifactId;
          attempt.updatedAt = this.deps.clock.now();
          tx.attempts.update(attempt);
          tx.changes.push({
            kind: "attempt.update",
            conversationId: run.conversationId,
            value: projectAttempt(attempt),
          });
        });
        this.deps.publish(commit);
        return "continue";
      }

      // Interrupted after dispatch intent was persisted.
      const replaySafe = prepared.replayPolicy === "safe" && retries < this.limits.maxSafeToolRetries;
      if (outcome.reason === "deadline" && replaySafe) {
        attempt.state = "interrupted";
        attempt.errorCode = "TOOL_INTERRUPTED";
        attempt.updatedAt = this.deps.clock.now();
        this.updateAttempt(run, attempt);
        retries += 1;
        continue;
      }
      this.markUnknown(run, attempt, tool, outcome.reason);
      return "paused";
    }
  }

  private markUnknown(
    run: RunRecord,
    attempt: AttemptRecord,
    tool: PersistedToolCall,
    reason: "cancelled" | "deadline",
  ): void {
    attempt.state = "unknown";
    attempt.errorCode = "REMOTE_OUTCOME_UNKNOWN";
    attempt.errorMessage =
      "the remote outcome could not be determined; the call was not replayed";
    attempt.uncertaintyJson = JSON.stringify({
      reason,
      arguments: tool.arguments,
      session: attempt.connectorId ?? null,
      knownOutput: null,
    });
    attempt.updatedAt = this.deps.clock.now();
    const commit = this.deps.store.transaction((tx) => {
      tx.attempts.update(attempt);
      tx.changes.push({
        kind: "attempt.update",
        conversationId: run.conversationId,
        value: projectAttempt(attempt),
      });
    });
    this.deps.publish(commit);
    this.applyTransition(run, { type: "remote_outcome_unknown", attemptId: attempt.id });
  }

  private recordToolError(run: RunRecord, tool: PersistedToolCall, error: unknown): void {
    const message = error instanceof Error ? error.message : "tool failed";
    const commit = this.deps.store.transaction((tx) => {
      const entry = this.newEntry(
        tx,
        run,
        "tool_result",
        `Error: ${message}`,
        undefined,
        undefined,
        tool.toolCallId,
        tool.alias,
        true,
      );
      tx.changes.push({
        kind: "entry.append",
        conversationId: run.conversationId,
        value: projectEntry(entry),
      });
    });
    this.deps.publish(commit);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private insertAttempt(run: RunRecord, attempt: AttemptRecord): void {
    const commit = this.deps.store.transaction((tx) => {
      tx.attempts.insert(attempt);
      tx.changes.push({
        kind: "attempt.update",
        conversationId: run.conversationId,
        value: projectAttempt(attempt),
      });
    });
    this.deps.publish(commit);
  }

  private updateAttempt(run: RunRecord, attempt: AttemptRecord): void {
    const commit = this.deps.store.transaction((tx) => {
      tx.attempts.update(attempt);
      tx.changes.push({
        kind: "attempt.update",
        conversationId: run.conversationId,
        value: projectAttempt(attempt),
      });
    });
    this.deps.publish(commit);
  }

  private newEntry(
    tx: StoreTransaction,
    run: RunRecord,
    kind: EntryRecord["kind"],
    text: string | undefined,
    attemptId: AttemptId | undefined,
    metadata?: Record<string, unknown>,
    toolCallId?: string,
    toolName?: string,
    isError = false,
  ): EntryRecord {
    const sequence = tx.conversations.nextEntrySequence(run.conversationId);
    const entry: EntryRecord = {
      id: this.deps.ids.next("entry"),
      conversationId: run.conversationId,
      sequence,
      kind,
      isError,
      createdAt: this.deps.clock.now(),
    };
    if (attemptId !== undefined) entry.attemptId = attemptId;
    if (text !== undefined) entry.text = text;
    if (metadata !== undefined) entry.metadataJson = JSON.stringify(metadata);
    if (toolCallId !== undefined) entry.toolCallId = toolCallId;
    if (toolName !== undefined) entry.toolName = toolName;
    tx.entries.insert(entry);
    tx.conversations.touch(run.conversationId, this.deps.clock.now());
    return entry;
  }

  private storeArtifact(content: string, mimeType: string): string {
    const id = this.deps.ids.next("artifact");
    const commit = this.deps.store.transaction((tx) => {
      tx.artifacts.create({
        id,
        mimeType,
        encoding: "utf8",
        byteCount: 0,
        complete: false,
        createdAt: this.deps.clock.now(),
      });
      tx.artifacts.appendChunk(id, 0, content, content.length);
      tx.artifacts.complete(id, `${content.length}`);
    });
    this.deps.publish(commit);
    return id;
  }

  private async withExternalBudget<T>(
    runId: RunId,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: "cancelled" | "deadline" }> {
    const controller = new AbortController();
    this.activeControllers.set(runId, controller);
    const timer = setTimeout(() => controller.abort("deadline"), this.limits.externalAttemptBudgetMs);
    try {
      const value = await fn(controller.signal);
      return { ok: true, value };
    } catch (error) {
      if (controller.signal.aborted) {
        return {
          ok: false,
          reason: controller.signal.reason === "deadline" ? "deadline" : "cancelled",
        };
      }
      if (error instanceof AttemptAbortedError) {
        return { ok: false, reason: error.reason };
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.activeControllers.delete(runId);
    }
  }
}

function renderToolResult(outcome: { content: { type: string; text?: string }[]; isError: boolean }): string {
  const text = outcome.content
    .map((item) => (item.type === "text" ? (item.text ?? "") : `[${item.type}]`))
    .join("\n");
  return text.length > 0 ? text : outcome.isError ? "Tool reported an error" : "(empty result)";
}

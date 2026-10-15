// Alarm-backed server-side driver (ADR-0002). The driver coordinates effects;
// `RunMachine` owns the pure transitions. pi-ai owns provider semantics and
// error classification; the driver owns durable attempts, dispatch, retries,
// and their bookkeeping.

import { isRetryableAssistantError, retryDelayMs } from "@earendil-works/pi-ai";
import { AppError, type AttemptId, type RunId } from "../../shared/domain";
import type { ViewChange } from "../../shared/wire";
import type { Commit, SqlStore, StoreTransaction } from "../storage/SqlStore";
import type {
  ActiveAttemptPointer,
  AttemptRecord,
  EntryRecord,
  PersistedToolCall,
  RunCheckpoint,
  RunRecord,
} from "../storage/records";
import { projectAttempt, projectEntry, projectRun, projectSubmission } from "../storage/projections";
import type { ContextAssembler } from "../context/ContextAssembler";
import { compactionRequest } from "../context/ContextAssembler";
import type { ContextBudget } from "../context/ContextBudget";
import type { ToolExecutor, PreparedToolCall } from "../mcp/types";
import type {
  CanonicalModelRequest,
  ModelAttemptResult,
  ModelRequest,
  PersistedModelToolCall,
} from "../models/types";
import type { Clock, IdGenerator } from "./Clock";
import { AttemptAbortedError, AttemptExecutor, failedAssistantMessage } from "./AttemptExecutor";
import { OutputCommitter } from "./OutputCommitter";
import { RunMachine, type RuntimeEvent } from "./RunMachine";
import { countInvocationChain, createRetryChild } from "./RetryBookkeeping";
import { WakeScheduler } from "./WakeScheduler";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "./limits";

export interface RunDriverDeps {
  store: SqlStore;
  clock: Clock;
  ids: IdGenerator;
  machine: RunMachine;
  context: ContextAssembler;
  budget: ContextBudget;
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
      // ADR-0002: runs that made no progress this slice (for example a
      // prepared retry waiting on persisted backoff) are skipped so other
      // work still runs; the scan ends when every active run is stalled.
      const stalled = new Set<RunId>();
      for (;;) {
        if (this.deps.clock.now() >= deadline) break;
        const outcome = await this.driveNextRun(deadline, stalled);
        if (outcome === "none") break;
      }
      await this.reconcileWake();
    } finally {
      this.driving = false;
    }
  }

  /**
   * ADR-0002: alarm reconciliation honors retry backoff instead of busy
   * polling. The wake is the earliest persisted retry eligibility among active
   * invocations; immediately actionable work wakes now.
   */
  private async reconcileWake(): Promise<void> {
    const next = this.deps.store.read((tx) => {
      const active = tx.runs.activeRuns();
      const runnable = active.some(
        (run) =>
          run.state === "running" ||
          run.state === "queued" ||
          run.cancelRequestedAt !== undefined,
      );
      if (!runnable) return null;
      const now = this.deps.clock.now();
      let earliestBackoff: number | undefined;
      for (const run of active) {
        if (run.cancelRequestedAt !== undefined) return now;
        if (run.state === "queued") return now;
        const pointer = run.checkpoint.activeAttempt;
        const attempt = pointer ? tx.attempts.get(pointer.attemptId) : undefined;
        if (!attempt || attempt.state !== "prepared" || attempt.retryEligibleAt === undefined) {
          return now;
        }
        earliestBackoff =
          earliestBackoff === undefined
            ? attempt.retryEligibleAt
            : Math.min(earliestBackoff, attempt.retryEligibleAt);
      }
      return earliestBackoff !== undefined ? Math.max(now, earliestBackoff) : now;
    });
    await this.deps.wake.reconcile(next);
  }

  private async driveNextRun(
    deadline: number,
    stalled: Set<RunId>,
  ): Promise<"progress" | "stall" | "none"> {
    const selected = this.deps.store.read((tx) => {
      const active = tx.runs.activeRuns();
      const selectable = (run: RunRecord) => !stalled.has(run.id);
      const running = active.find((run) => run.state === "running" && selectable(run));
      if (running) return running;
      // ADR-0001: a paused run with a persisted cancellation request must be
      // selectable so cancellation can reach a terminal state.
      const cancellable = active.find((run) => run.cancelRequestedAt !== undefined && selectable(run));
      if (cancellable) return cancellable;
      const blocked = active.find(
        (run) =>
          (run.state === "waiting_for_auth" || run.state === "needs_attention") &&
          selectable(run),
      );
      if (blocked) return undefined;
      return active.find((run) => run.state === "queued" && selectable(run));
    });
    if (!selected) return "none";

    let run = selected;
    if (run.state === "queued") {
      run = this.applyTransition(run, { type: "start" });
    }
    await this.runLoop(run, deadline);
    // A slice that wrote nothing for this run marks it stalled instead of
    // spinning on it (ADR-0002 backoff waits).
    const after = this.reload(selected.id);
    const progressed =
      after !== undefined &&
      (after.state !== selected.state ||
        after.phase !== selected.phase ||
        after.updatedAt !== selected.updatedAt ||
        JSON.stringify(after.checkpoint) !== JSON.stringify(selected.checkpoint));
    if (progressed) {
      return "progress";
    }
    stalled.add(selected.id);
    return "stall";
  }

  private async runLoop(initial: RunRecord, deadline: number): Promise<void> {
    let run = initial;
    for (;;) {
      // ADR-0001: a run that no longer exists (for example after deletion)
      // stops the driver instead of continuing from stale state.
      const reloaded = this.reload(run.id);
      if (!reloaded) return;
      run = reloaded;
      if (run.state === "completed" || run.state === "cancelled" || run.state === "failed") return;
      // Cancellation is processed before paused work blocks driver selection,
      // and takes priority over scheduled retry backoff (ADR-0002).
      if (run.cancelRequestedAt !== undefined) {
        this.applyTransition(run, { type: "cancel_requested" });
        return;
      }
      if (run.state === "waiting_for_auth" || run.state === "needs_attention") return;
      if (this.deps.clock.now() >= deadline) return;

      // ADR-0002: a prepared retry waiting on persisted backoff performs no
      // work in this slice; the alarm is scheduled at its eligibility time.
      const waiting = this.backoffWait(run);
      if (waiting !== undefined) {
        await this.deps.wake.ensureWakeBy(waiting);
        return;
      }

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

  /** Wake time for a run whose active attempt is waiting on backoff. */
  private backoffWait(run: RunRecord): number | undefined {
    const pointer = run.checkpoint.activeAttempt;
    if (!pointer) return undefined;
    if (run.phase !== "request_model" && run.phase !== "compact_context") return undefined;
    const attempt = this.deps.store.read((tx) => tx.attempts.get(pointer.attemptId));
    if (!attempt || attempt.state !== "prepared") return undefined;
    if (attempt.retryEligibleAt === undefined) return undefined;
    const now = this.deps.clock.now();
    return attempt.retryEligibleAt > now ? attempt.retryEligibleAt : undefined;
  }

  /** Mark the queued submissions that started this run as accepted. */
  private claimQueuedInput(run: RunRecord): void {
    const queued = this.deps.store
      .read((tx) => tx.submissions.listQueuedForConversation(run.conversationId))
      .filter((submission) => submission.runId === run.id);
    if (queued.length === 0) return;
    const commit = this.deps.store.transaction((tx) => {
      if (!this.executionCurrent(tx, run)) return;
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
      if (!this.executionCurrent(tx, run)) return;
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
      // ADR-0001: do not publish a transition for a run that was deleted or
      // whose generation was superseded.
      if (!this.executionCurrent(tx, run)) return;
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
    if (value.kind === "over_budget") {
      // ADR-0002: over-budget input without a safe compaction path fails
      // explicitly instead of dispatching a request that cannot fit.
      this.applyTransition(run, { type: "definite_failure", code: "CONTEXT_OVER_BUDGET" });
      return "terminal";
    }
    // ADR-0002: the selected compaction range is persisted with the
    // transition so the compaction attempt consumes exactly that range.
    this.applyTransition(run, {
      type: "compaction_required",
      plan: {
        firstSequence: value.plan.firstSequence,
        lastSequence: value.plan.lastSequence,
        digest: value.plan.digest,
      },
    });
    return "continue";
  }

  private async stepCompactContext(run: RunRecord): Promise<StepStatus> {
    const outcome = await this.executeModelAttempt(run, "compaction");
    if (outcome.status !== "succeeded") return outcome.status;
    // The summary entry was persisted by the compaction attempt; summaries
    // coexist with the original entries. Return to preparation.
    const fresh = this.reload(run.id);
    if (!fresh) return "terminal";
    const next: RunRecord = {
      ...fresh,
      phase: "prepare_context",
      checkpoint: { ...fresh.checkpoint, phase: "prepare_context", compactionPlan: undefined },
    };
    this.deps.store.transaction((tx) => {
      if (!this.executionCurrent(tx, fresh)) return;
      tx.runs.update(next);
    });
    return "continue";
  }

  private async stepRequestModel(run: RunRecord): Promise<StepStatus> {
    const outcome = await this.executeModelAttempt(run, "model");
    if (outcome.status !== "succeeded") return outcome.status;
    // Reload so the transition sees the settlement's checkpoint bookkeeping.
    const fresh = this.reload(run.id) ?? run;
    const updated = this.applyTransition(fresh, {
      type: "model_finished",
      entryId: outcome.entryId,
      tools: outcome.toolCalls,
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
    return "continue";
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
    // ADR-0002: resume the prepared retry recorded for this invocation
    // instead of creating another root attempt.
    const pointer = run.checkpoint.activeAttempt;
    const prepared = pointer ? this.loadActiveAttempt(run, pointer, kind) : undefined;
    if (prepared === "conflict") {
      this.applyTransition(run, { type: "definite_failure", code: "MODEL_STATE_CONFLICT" });
      return { status: "terminal" };
    }

    let attempt: AttemptRecord;
    if (prepared) {
      attempt = prepared;
      this.markAttemptState(run, attempt, "dispatched");
    } else {
      const created = this.prepareNewModelAttempt(run, kind);
      if (!created.ok) return { status: created.status };
      attempt = created.attempt;
    }

    await this.deps.wake.ensureWakeBy(this.deps.clock.now() + this.limits.recoveryWakeIntervalMs);
    const request = this.loadRequest(attempt);
    if (!request) {
      this.settleModelFailure(run, attempt, "MODEL_ERROR", "model request artifact is missing");
      return { status: "terminal" };
    }

    const outcome = await this.runModelAttempt(run, attempt, request);
    if (!outcome.ok) {
      if (outcome.reason === "failed") return { status: "terminal" };
      if (outcome.reason === "cancelled") {
        this.settleLocalCancellation(run, attempt);
        return { status: "paused" };
      }
      this.scheduleRetry(run, attempt, "deadline");
      return { status: "budget" };
    }
    return this.settleModelResult(run, attempt, outcome.value);
  }

  /**
   * Load the active attempt referenced by the checkpoint pointer.
   * Returns `"conflict"` for bookkeeping that must fail visibly (ADR-0002).
   */
  private loadActiveAttempt(
    run: RunRecord,
    pointer: ActiveAttemptPointer,
    kind: "model" | "compaction",
  ): AttemptRecord | "conflict" | undefined {
    return this.deps.store.read((tx) => {
      const attempt = tx.attempts.get(pointer.attemptId);
      if (!attempt || attempt.runId !== run.id) return undefined;
      if (attempt.kind !== kind) return "conflict";
      if (attempt.state === "prepared") return attempt;
      // A dispatched attempt under an active pointer within the same
      // generation means re-entry into a live dispatch.
      if (attempt.state === "dispatched") return "conflict";
      return undefined;
    });
  }

  /**
   * Create a new root attempt for one invocation, freezing the request in its
   * artifact inside the attempt's insert transaction (ADR-0001, ADR-0002).
   */
  private prepareNewModelAttempt(
    run: RunRecord,
    kind: "model" | "compaction",
  ): { ok: true; attempt: AttemptRecord } | { ok: false; status: "terminal" | "budget" } {
    const attemptId = this.deps.ids.next("attempt");
    let modelRequest: CanonicalModelRequest;
    if (kind === "compaction") {
      const frozen = this.deps.store.read((tx) => this.deps.context.requireFrozenProfile(tx));
      const plan = run.checkpoint.compactionPlan;
      const entries = this.deps.store.read((tx) =>
        plan
          ? tx.entries.listRange(run.conversationId, plan.firstSequence, plan.lastSequence)
          : // Legacy pending compaction has no persisted range; keep the
            // historical whole-recent behavior for that state only.
            tx.entries.listRecent(run.conversationId, 200),
      );
      modelRequest = compactionRequest(attemptId, frozen, entries);
      // ADR-0002: compaction requests are budget-validated before dispatch.
      if (this.deps.budget.assess(modelRequest.context, modelRequest.profile).overBudget) {
        this.applyTransition(run, { type: "definite_failure", code: "CONTEXT_OVER_BUDGET" });
        return { ok: false, status: "terminal" };
      }
    } else {
      const snapshotId = run.checkpoint.contextSnapshotId;
      if (!snapshotId) {
        this.applyTransition(run, { type: "definite_failure", code: "NO_CONTEXT" });
        return { ok: false, status: "terminal" };
      }
      modelRequest = this.deps.store.read((tx) =>
        this.deps.context.materialize(tx, snapshotId, attemptId),
      );
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
    // ADR-0001: the request artifact and its attempt are persisted together;
    // ADR-0002: the active-attempt pointer joins the same transaction so a
    // restart either sees both or neither.
    const pointer: ActiveAttemptPointer = { attemptId: attempt.id, kind };
    const commit = this.deps.store.transaction((tx) => {
      if (!this.executionCurrent(tx, run)) return;
      attempt.requestArtifactId = this.createArtifact(tx, JSON.stringify(modelRequest));
      tx.attempts.insert(attempt);
      const current = tx.runs.get(run.id);
      if (current) {
        const updated: RunRecord = {
          ...current,
          checkpoint: { ...current.checkpoint, activeAttempt: pointer },
          updatedAt: this.deps.clock.now(),
        };
        tx.runs.update(updated);
        tx.changes.push({
          kind: "run.update",
          conversationId: run.conversationId,
          value: projectRun(updated),
        });
      }
      tx.changes.push({
        kind: "attempt.update",
        conversationId: run.conversationId,
        value: projectAttempt(attempt),
      });
    });
    this.deps.publish(commit);
    attempt.state = "dispatched";
    attempt.updatedAt = this.deps.clock.now();
    this.updateAttempt(run, attempt);
    return { ok: true, attempt };
  }

  /** Parse the frozen request artifact for dispatch (ADR-0002). */
  private loadRequest(attempt: AttemptRecord): ModelRequest | undefined {
    const artifactId = attempt.requestArtifactId;
    if (!artifactId) return undefined;
    const json = this.deps.store.read((tx) =>
      tx.artifacts
        .readChunks(artifactId)
        .map((chunk) => chunk.data)
        .join(""),
    );
    if (!json) return undefined;
    try {
      const parsed = JSON.parse(json) as ModelRequest;
      if (parsed && typeof parsed === "object" && (parsed as CanonicalModelRequest).version === 2) {
        // Retries reuse the frozen artifact; only the local executing attempt
        // identity changes.
        return { ...(parsed as CanonicalModelRequest), attemptId: attempt.id };
      }
      return parsed;
    } catch {
      return undefined;
    }
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
      this.settleModelFailure(
        run,
        attempt,
        error instanceof AppError ? error.code : "MODEL_ERROR",
        error instanceof Error ? error.message : "model request failed",
      );
      return { ok: false, reason: "failed" };
    }
  }

  /**
   * ADR-0002: settle one terminal model result according to its stop reason.
   * Only fully completed tool-use responses may dispatch tools.
   */
  private settleModelResult(
    run: RunRecord,
    attempt: AttemptRecord,
    result: ModelAttemptResult,
  ):
    | { status: "succeeded"; text: string; toolCalls: PersistedToolCall[]; entryId: string }
    | { status: "paused" | "terminal" | "budget" } {
    const message = result.message;
    switch (message.stopReason) {
      case "stop":
      case "toolUse":
        return this.settleModelSuccess(run, attempt, result);
      case "length":
        return this.settleOutputLimit(run, attempt, result);
      case "error":
        return this.settleModelError(run, attempt, result);
      case "aborted":
        return this.settleUnexplainedAbort(run, attempt, result);
      default:
        // `pending` terminals and unsolicited `deferred` results are protocol
        // violations, not successes.
        this.settleModelFailure(
          run,
          attempt,
          "MODEL_ERROR",
          `unacceptable model stop reason: ${message.stopReason}`,
        );
        return { status: "terminal" };
    }
  }

  private settleModelSuccess(
    run: RunRecord,
    attempt: AttemptRecord,
    result: ModelAttemptResult,
  ):
    | { status: "succeeded"; text: string; toolCalls: PersistedToolCall[]; entryId: string }
    | { status: "terminal" } {
    const message = result.message;
    const toolCalls = toolCallsOf(message);
    // ADR-0002: a "stop" turn carrying tool calls is a protocol
    // inconsistency, not permission to execute them.
    if (message.stopReason === "stop" && toolCalls.length > 0) {
      this.settleModelFailure(
        run,
        attempt,
        "MODEL_ERROR",
        "model returned tool calls with a stop reason",
      );
      return { status: "terminal" };
    }
    const committed = this.deps.committer.close(attempt.id);
    const text = textOf(message) || committed;
    const kind = attempt.kind;
    let entryId: string | undefined;
    const commit = this.deps.store.transaction((tx) => {
      // ADR-0001: never persist or publish results for a run that no longer
      // exists or whose execution generation was superseded.
      const current = this.fenceRun(tx, run, attempt);
      if (!current) return;
      // ADR-0002: the terminal result is linked to its attempt in the same
      // transaction that settles the attempt, appends the entry, and clears
      // the active-attempt pointer.
      const artifactId = this.createArtifact(
        tx,
        JSON.stringify({ version: 1, message } satisfies PersistedModelResult),
      );
      const metadata: Record<string, unknown> = {
        modelMessage: { version: 1, message },
      };
      const entry = this.newEntry(
        tx,
        run,
        kind === "compaction" ? "summary" : "assistant",
        text,
        attempt.id,
        metadata,
      );
      entryId = entry.id;
      tx.liveOutput.clear(attempt.id);
      attempt.state = "succeeded";
      attempt.resultArtifactId = artifactId;
      attempt.updatedAt = this.deps.clock.now();
      tx.attempts.update(attempt);
      const updated: RunRecord = {
        ...current,
        checkpoint: { ...current.checkpoint, activeAttempt: undefined },
        updatedAt: this.deps.clock.now(),
      };
      tx.runs.update(updated);
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
      tx.changes.push({
        kind: "run.update",
        conversationId: run.conversationId,
        value: projectRun(updated),
      });
      // Display cards for tool calls (the model message carries the
      // authoritative representation).
      for (const call of toolCalls) {
        const callEntry = this.newEntry(
          tx,
          run,
          "tool_call",
          undefined,
          attempt.id,
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
    if (entryId === undefined) return { status: "terminal" };
    const tools: PersistedToolCall[] = toolCalls.map((call) => ({
      toolCallId: call.toolCallId,
      alias: call.name,
      arguments: call.arguments,
    }));
    return { status: "succeeded", text, toolCalls: tools, entryId };
  }

  /** ADR-0002: `length` preserves the truncated response and never retries. */
  private settleOutputLimit(
    run: RunRecord,
    attempt: AttemptRecord,
    result: ModelAttemptResult,
  ): { status: "terminal" } {
    const committed = this.deps.committer.close(attempt.id);
    const text = textOf(result.message) || committed;
    const commit = this.deps.store.transaction((tx) => {
      const current = this.fenceRun(tx, run, attempt);
      if (!current) return;
      const artifactId = this.createArtifact(
        tx,
        JSON.stringify({ version: 1, message: result.message } satisfies PersistedModelResult),
      );
      const entry = this.newEntry(tx, run, "assistant", text, attempt.id, {
        modelMessage: { version: 1, message: result.message },
        truncated: true,
      });
      tx.liveOutput.clear(attempt.id);
      attempt.state = "failed";
      attempt.errorCode = "MODEL_OUTPUT_LIMIT";
      attempt.errorMessage = "the model response hit its output limit";
      attempt.resultArtifactId = artifactId;
      attempt.updatedAt = this.deps.clock.now();
      tx.attempts.update(attempt);
      const updated: RunRecord = {
        ...current,
        checkpoint: { ...current.checkpoint, activeAttempt: undefined },
        updatedAt: this.deps.clock.now(),
      };
      tx.runs.update(updated);
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
      tx.changes.push({
        kind: "run.update",
        conversationId: run.conversationId,
        value: projectRun(updated),
      });
    });
    this.deps.publish(commit);
    this.applyTransition(run, { type: "definite_failure", code: "MODEL_OUTPUT_LIMIT" });
    return { status: "terminal" };
  }

  /** ADR-0002: provider errors retry only when pi-ai classifies them as transient. */
  private settleModelError(
    run: RunRecord,
    attempt: AttemptRecord,
    result: ModelAttemptResult,
  ): { status: "terminal" | "budget" } {
    if (isRetryableAssistantError(result.message)) {
      this.scheduleRetry(run, attempt, "error", result.message.errorMessage);
      return { status: "budget" };
    }
    this.settleFailureEvidence(run, attempt, result.message, "MODEL_ERROR");
    return { status: "terminal" };
  }

  /** An unexplained provider abort is not success (ADR-0002). */
  private settleUnexplainedAbort(
    run: RunRecord,
    attempt: AttemptRecord,
    result: ModelAttemptResult,
  ): { status: "terminal" } {
    if (run.cancelRequestedAt !== undefined) {
      this.applyTransition(run, { type: "cancel_requested" });
      return { status: "terminal" };
    }
    this.settleFailureEvidence(run, attempt, result.message, "MODEL_ABORTED");
    return { status: "terminal" };
  }

  /**
   * Persist failure evidence: the frozen terminal message, the committed
   * partial text, and the failed attempt, atomically (ADR-0002).
   */
  private settleFailureEvidence(
    run: RunRecord,
    attempt: AttemptRecord,
    message: ModelAttemptResult["message"],
    errorCode: string,
  ): void {
    const committed = this.deps.committer.close(attempt.id);
    const text = textOf(message) || committed;
    const commit = this.deps.store.transaction((tx) => {
      const current = this.fenceRun(tx, run, attempt);
      if (!current) return;
      const artifactId = this.createArtifact(
        tx,
        JSON.stringify({ version: 1, message } satisfies PersistedModelResult),
      );
      attempt.state = "failed";
      attempt.errorCode = errorCode;
      attempt.errorMessage = message.errorMessage ?? "model request failed";
      attempt.resultArtifactId = artifactId;
      attempt.updatedAt = this.deps.clock.now();
      tx.attempts.update(attempt);
      if (text.length > 0) {
        const entry = this.newEntry(tx, run, "assistant", text, attempt.id, {
          modelMessage: { version: 1, message },
          failed: true,
        });
        tx.changes.push({
          kind: "entry.append",
          conversationId: run.conversationId,
          value: projectEntry(entry),
        });
      }
      tx.liveOutput.clear(attempt.id);
      const updated: RunRecord = {
        ...current,
        checkpoint: { ...current.checkpoint, activeAttempt: undefined },
        updatedAt: this.deps.clock.now(),
      };
      tx.runs.update(updated);
      tx.changes.push({
        kind: "attempt.update",
        conversationId: run.conversationId,
        value: projectAttempt(attempt),
      });
      tx.changes.push({
        kind: "run.update",
        conversationId: run.conversationId,
        value: projectRun(updated),
      });
    });
    this.deps.publish(commit);
    this.applyTransition(run, { type: "definite_failure", code: errorCode });
  }

  /**
   * ADR-0002: schedule a durable retry child with persisted backoff. The
   * parent settlement, child insert, and active-pointer update are atomic.
   * The invocation chain length is the retry budget.
   */
  private scheduleRetry(
    run: RunRecord,
    attempt: AttemptRecord,
    reason: "error" | "deadline",
    errorMessage?: string,
  ): void {
    const now = this.deps.clock.now();
    let exhausted = false;
    const commit = this.deps.store.transaction((tx): AttemptRecord | "exhausted" | undefined => {
      const current = this.fenceRun(tx, run, attempt);
      if (!current) return undefined;
      // Retain committed partial output as an interrupted assistant entry so
      // a regenerated answer is never appended onto it as one stream.
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
      const chain = countInvocationChain(tx, attempt);
      if (chain >= this.limits.maxModelAttempts) {
        attempt.state = "failed";
        attempt.errorCode = reason === "deadline" ? "MODEL_INTERRUPTED" : "MODEL_ERROR";
        attempt.errorMessage =
          reason === "deadline" ? "model attempt budget exhausted" : (errorMessage ?? "model request failed");
        attempt.updatedAt = now;
        tx.attempts.update(attempt);
        const updated: RunRecord = {
          ...current,
          checkpoint: { ...current.checkpoint, activeAttempt: undefined },
          updatedAt: now,
        };
        tx.runs.update(updated);
        tx.changes.push({
          kind: "attempt.update",
          conversationId: run.conversationId,
          value: projectAttempt(attempt),
        });
        tx.changes.push({
          kind: "run.update",
          conversationId: run.conversationId,
          value: projectRun(updated),
        });
        exhausted = true;
        return "exhausted";
      }
      // ADR-0002: backoff comes from pi-ai's policy helper with explicit
      // runtime limits; the computed eligibility is persisted once.
      const delayMs =
        reason === "deadline"
          ? 0
          : retryDelayMs(
              {
                baseDelayMs: this.limits.retryBaseDelayMs,
                maxAgentDelayMs: this.limits.retryMaxDelayMs,
              },
              chain,
            );
      const child = createRetryChild(tx, this.deps.ids, this.deps.clock.now(), {
        parent: attempt,
        run: current,
        retryEligibleAt: now + delayMs,
        errorCode: reason === "deadline" ? "MODEL_INTERRUPTED" : "MODEL_ERROR",
        errorMessage:
          reason === "deadline" ? "model attempt exceeded its budget" : (errorMessage ?? "model request failed"),
      });
      const updated: RunRecord = {
        ...current,
        checkpoint: {
          ...current.checkpoint,
          activeAttempt: { attemptId: child.id, kind: attempt.kind },
        },
        updatedAt: now,
      };
      tx.runs.update(updated);
      tx.changes.push({
        kind: "attempt.update",
        conversationId: run.conversationId,
        value: projectAttempt(attempt),
      });
      tx.changes.push({
        kind: "attempt.update",
        conversationId: run.conversationId,
        value: projectAttempt(child),
      });
      tx.changes.push({
        kind: "run.update",
        conversationId: run.conversationId,
        value: projectRun(updated),
      });
      return child;
    });
    this.deps.publish(commit);
    if (exhausted) {
      this.applyTransition(run, {
        type: "definite_failure",
        code: reason === "deadline" ? "MODEL_INTERRUPTED" : "MODEL_ERROR",
      });
    }
  }

  /** Local cancellation of a dispatched attempt (ADR-0002). */
  private settleLocalCancellation(run: RunRecord, attempt: AttemptRecord): void {
    const commit = this.deps.store.transaction((tx) => {
      const current = this.fenceRun(tx, run, attempt);
      if (!current) return;
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
      attempt.state = "failed";
      attempt.errorCode = "MODEL_CANCELLED";
      attempt.errorMessage = "cancelled";
      attempt.updatedAt = this.deps.clock.now();
      tx.attempts.update(attempt);
      const updated: RunRecord = {
        ...current,
        checkpoint: { ...current.checkpoint, activeAttempt: undefined },
        updatedAt: this.deps.clock.now(),
      };
      tx.runs.update(updated);
      tx.changes.push({
        kind: "attempt.update",
        conversationId: run.conversationId,
        value: projectAttempt(attempt),
      });
      tx.changes.push({
        kind: "run.update",
        conversationId: run.conversationId,
        value: projectRun(updated),
      });
    });
    this.deps.publish(commit);
    this.applyTransition(run, { type: "cancel_requested" });
  }

  private settleModelFailure(
    run: RunRecord,
    attempt: AttemptRecord,
    errorCode: string,
    errorMessage: string,
  ): void {
    attempt.state = "failed";
    attempt.errorCode = errorCode;
    attempt.errorMessage = errorMessage;
    attempt.updatedAt = this.deps.clock.now();
    const commit = this.deps.store.transaction((tx) => {
      const current = this.fenceRun(tx, run, attempt);
      if (!current) return;
      tx.attempts.update(attempt);
      const updated: RunRecord = {
        ...current,
        checkpoint: { ...current.checkpoint, activeAttempt: undefined },
        updatedAt: this.deps.clock.now(),
      };
      tx.runs.update(updated);
      tx.changes.push({
        kind: "attempt.update",
        conversationId: run.conversationId,
        value: projectAttempt(attempt),
      });
      tx.changes.push({
        kind: "run.update",
        conversationId: run.conversationId,
        value: projectRun(updated),
      });
    });
    this.deps.publish(commit);
    this.applyTransition(run, { type: "definite_failure", code: errorCode });
  }

  private markAttemptState(
    run: RunRecord,
    attempt: AttemptRecord,
    state: AttemptRecord["state"],
  ): void {
    attempt.state = state;
    attempt.updatedAt = this.deps.clock.now();
    this.updateAttempt(run, attempt);
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
      // ADR-0001: request artifact and attempt insert share one transaction.
      this.insertAttemptWithRequest(run, attempt, JSON.stringify(prepared.arguments));
      attempt.state = "dispatched";
      attempt.updatedAt = this.deps.clock.now();
      this.updateAttempt(run, attempt);
      await this.deps.wake.ensureWakeBy(this.deps.clock.now() + this.limits.recoveryWakeIntervalMs);

      const outcome = await this.withExternalBudget(run.id, (signal) =>
        this.deps.executor.executeTool(prepared, signal),
      );

      if (outcome.ok) {
        const resultJson = JSON.stringify(outcome.value);
        const resultText = renderToolResult(outcome.value);
        // ADR-0001: the result artifact and its attempt link commit together.
        const commit = this.deps.store.transaction((tx) => {
          if (!this.executionCurrent(tx, run, attempt)) return;
          const artifactId = this.createArtifact(tx, resultJson);
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
      if (!this.executionCurrent(tx, run, attempt)) return;
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
      if (!this.executionCurrent(tx, run)) return;
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

  /**
   * ADR-0001: create the request artifact and insert its attempt in one
   * transaction so an interrupted execution cannot leave an unlinked payload.
   */
  private insertAttemptWithRequest(
    run: RunRecord,
    attempt: AttemptRecord,
    requestJson: string,
  ): void {
    const commit = this.deps.store.transaction((tx) => {
      if (!this.executionCurrent(tx, run)) return;
      attempt.requestArtifactId = this.createArtifact(tx, requestJson);
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
      if (!this.executionCurrent(tx, run, attempt)) return;
      tx.attempts.update(attempt);
      tx.changes.push({
        kind: "attempt.update",
        conversationId: run.conversationId,
        value: projectAttempt(attempt),
      });
    });
    this.deps.publish(commit);
  }

  /**
   * ADR-0001: a persistence boundary may only write while the conversation,
   * run, attempt, and execution generation still exist as expected.
   * ADR-0002: returns the current run record so checkpoint patches apply to
   * the latest persisted state instead of a stale in-memory copy.
   */
  private fenceRun(
    tx: StoreTransaction,
    run: RunRecord,
    attempt?: AttemptRecord,
  ): RunRecord | undefined {
    if (!tx.conversations.get(run.conversationId)) return undefined;
    const currentRun = tx.runs.get(run.id);
    if (!currentRun || currentRun.generation !== run.generation) return undefined;
    if (attempt && !tx.attempts.get(attempt.id)) return undefined;
    return currentRun;
  }

  private executionCurrent(tx: StoreTransaction, run: RunRecord, attempt?: AttemptRecord): boolean {
    return this.fenceRun(tx, run, attempt) !== undefined;
  }

  /** ADR-0001: discard in-memory execution state for a deleted run. */
  discardRun(runId: RunId): void {
    const controller = this.activeControllers.get(runId);
    if (controller) {
      controller.abort("deleted");
      this.activeControllers.delete(runId);
    }
  }

  /** ADR-0001: drop buffered output for a deleted attempt without writing it. */
  discardAttempt(attemptId: AttemptId): void {
    this.deps.committer.discard(attemptId);
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

  private createArtifact(tx: StoreTransaction, content: string): string {
    const id = this.deps.ids.next("artifact");
    tx.artifacts.create({
      id,
      mimeType: "application/json",
      encoding: "utf8",
      byteCount: 0,
      complete: false,
      createdAt: this.deps.clock.now(),
    });
    tx.artifacts.appendChunk(id, 0, content, content.length);
    tx.artifacts.complete(id, `${content.length}`);
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

/** The terminal model result payload linked to an attempt (ADR-0002). */
export interface PersistedModelResult {
  version: 1;
  message: ModelAttemptResult["message"];
}

function textOf(message: ModelAttemptResult["message"]): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function toolCallsOf(message: ModelAttemptResult["message"]): PersistedModelToolCall[] {
  const calls: PersistedModelToolCall[] = [];
  for (const block of message.content) {
    if (block.type === "toolCall") {
      calls.push({ toolCallId: block.id, name: block.name, arguments: block.arguments });
    }
  }
  return calls;
}

function renderToolResult(outcome: { content: { type: string; text?: string }[]; isError: boolean }): string {
  const text = outcome.content
    .map((item) => (item.type === "text" ? (item.text ?? "") : `[${item.type}]`))
    .join("\n");
  return text.length > 0 ? text : outcome.isError ? "Tool reported an error" : "(empty result)";
}

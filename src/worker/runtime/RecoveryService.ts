// Recovery of work interrupted by a new object generation
// (PLAN.md -> Execution engine -> Recovery matrix).

import type { ViewChange } from "../../shared/wire";
import type { Commit, SqlStore } from "../storage/SqlStore";
import type { AttemptRecord, RunRecord } from "../storage/records";
import { projectAttempt, projectRun } from "../storage/projections";
import type { Clock, IdGenerator } from "./Clock";
import type { RuntimeLimits } from "./limits";

export interface RecoverySummary {
  recovered: number;
  retried: number;
  unknown: number;
  cancelled: number;
}

export interface RecoveryDeps {
  store: SqlStore;
  clock: Clock;
  ids: IdGenerator;
  limits: RuntimeLimits;
  publish(commit: Commit<unknown>): void;
}

export class RecoveryService {
  constructor(private readonly deps: RecoveryDeps) {}

  /**
   * Runs once per new object generation. Attempts created by the current live
   * driver carry the current generation and are never reclassified here.
   */
  recoverPreviousGeneration(currentGeneration: number): RecoverySummary {
    const summary: RecoverySummary = { recovered: 0, retried: 0, unknown: 0, cancelled: 0 };
    const stale = this.deps.store.read((tx) =>
      tx.attempts.listByState(["prepared", "dispatched"]),
    );

    for (const attempt of stale) {
      if (attempt.generation >= currentGeneration) continue;
      if (attempt.state === "prepared") {
        // Dispatch may proceed; network I/O is forbidden before `dispatched`
        // is committed, so nothing was sent.
        summary.recovered += 1;
        continue;
      }
      const run = this.deps.store.read((tx) => tx.runs.get(attempt.runId));
      if (!run) continue;
      if (attempt.kind === "model" || attempt.kind === "compaction") {
        this.recoverModel(run, attempt, summary);
      } else {
        this.recoverTool(run, attempt, summary);
      }
    }

    // Continue cancellation handling for runs that requested it.
    const active = this.deps.store.read((tx) => tx.runs.activeRuns());
    for (const run of active) {
      if (run.cancelRequestedAt !== undefined) {
        this.forceCancel(run);
        summary.cancelled += 1;
      }
    }
    return summary;
  }

  private recoverModel(run: RunRecord, attempt: AttemptRecord, summary: RecoverySummary): void {
    const now = this.deps.clock.now();
    const changes: ViewChange[] = [];
    const attemptsInRun = this.deps.store.read((tx) => tx.attempts.listForRun(run.id));
    const modelCount = attemptsInRun.filter((a) => a.kind === attempt.kind).length;
    const canRetry = modelCount < this.deps.limits.maxModelAttempts;
    const commit = this.deps.store.transaction((tx) => {
      attempt.state = canRetry ? "interrupted" : "failed";
      attempt.errorCode = "MODEL_INTERRUPTED";
      attempt.errorMessage = "interrupted by a new object generation";
      attempt.updatedAt = now;
      const live = tx.liveOutput.get(attempt.id);
      if (live && live.content.length > 0) {
        const sequence = tx.conversations.nextEntrySequence(run.conversationId);
        tx.entries.insert({
          id: this.deps.ids.next("entry"),
          conversationId: run.conversationId,
          sequence,
          kind: "assistant",
          attemptId: attempt.id,
          text: live.content,
          isError: false,
          metadataJson: JSON.stringify({ interrupted: true }),
          createdAt: now,
        });
        tx.liveOutput.clear(attempt.id);
      }
      tx.attempts.update(attempt);
      changes.push({ kind: "attempt.update", conversationId: run.conversationId, value: projectAttempt(attempt) });

      if (canRetry) {
        const retry: AttemptRecord = {
          ...attempt,
          id: this.deps.ids.next("attempt"),
          state: "prepared",
          errorCode: undefined,
          errorMessage: undefined,
          resultArtifactId: undefined,
          parentAttemptId: attempt.id,
          generation: attempt.generation,
          createdAt: now,
          updatedAt: now,
        };
        tx.attempts.insert(retry);
        changes.push({ kind: "attempt.update", conversationId: run.conversationId, value: projectAttempt(retry) });
      } else {
        run.state = "failed";
        run.phase = "finish_turn";
        run.updatedAt = now;
        tx.runs.update(run);
        changes.push({ kind: "run.update", conversationId: run.conversationId, value: projectRun(run) });
      }
    });
    this.deps.publish(commit);
    if (canRetry) summary.retried += 1;
    else summary.recovered += 1;
  }

  private recoverTool(run: RunRecord, attempt: AttemptRecord, summary: RecoverySummary): void {
    const now = this.deps.clock.now();
    const changes: ViewChange[] = [];
    const commit = this.deps.store.transaction((tx) => {
      if (attempt.replayPolicy === "safe") {
        attempt.state = "interrupted";
        attempt.errorCode = "TOOL_INTERRUPTED";
        attempt.errorMessage = "interrupted by a new object generation";
        attempt.updatedAt = now;
        tx.attempts.update(attempt);
        const retry: AttemptRecord = {
          ...attempt,
          id: this.deps.ids.next("attempt"),
          state: "prepared",
          errorCode: undefined,
          errorMessage: undefined,
          resultArtifactId: undefined,
          parentAttemptId: attempt.id,
          createdAt: now,
          updatedAt: now,
        };
        tx.attempts.insert(retry);
        changes.push({ kind: "attempt.update", conversationId: run.conversationId, value: projectAttempt(attempt) });
        changes.push({ kind: "attempt.update", conversationId: run.conversationId, value: projectAttempt(retry) });
        summary.retried += 1;
      } else {
        // Unsafe: the remote outcome is unknown and must not be replayed.
        attempt.state = "unknown";
        attempt.errorCode = "REMOTE_OUTCOME_UNKNOWN";
        attempt.errorMessage =
          "the remote outcome could not be determined after reconstruction; the call was not replayed";
        attempt.uncertaintyJson = JSON.stringify({
          reason: "generation_restart",
          arguments: null,
          session: attempt.connectorId ?? null,
          knownOutput: null,
        });
        attempt.updatedAt = now;
        tx.attempts.update(attempt);
        changes.push({ kind: "attempt.update", conversationId: run.conversationId, value: projectAttempt(attempt) });
        if (run.state !== "completed" && run.state !== "cancelled" && run.state !== "failed") {
          run.state = "needs_attention";
          run.updatedAt = now;
          tx.runs.update(run);
          changes.push({ kind: "run.update", conversationId: run.conversationId, value: projectRun(run) });
        }
        summary.unknown += 1;
      }
    });
    this.deps.publish(commit);
  }

  private forceCancel(run: RunRecord): void {
    const now = this.deps.clock.now();
    const commit = this.deps.store.transaction((tx) => {
      const updated: RunRecord = { ...run, state: "cancelled", phase: "finish_turn", updatedAt: now };
      tx.runs.update(updated);
      tx.changes.push({ kind: "run.update", conversationId: run.conversationId, value: projectRun(updated) });
    });
    this.deps.publish(commit);
  }
}

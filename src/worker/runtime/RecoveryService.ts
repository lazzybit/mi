// Recovery of work interrupted by a new object generation
// (ADR-0002). Model retry bookkeeping follows the same invocation-chain
// budget as the driver; prepared retries retain their persisted eligibility,
// and ambiguous historical bookkeeping fails visibly instead of dispatching
// duplicate roots.

import type { Commit, SqlStore } from "../storage/SqlStore";
import type { AttemptRecord, RunRecord } from "../storage/records";
import { projectAttempt, projectRun } from "../storage/projections";
import type { Clock, IdGenerator } from "./Clock";
import { countInvocationChain, createRetryChild } from "./RetryBookkeeping";
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
        // is committed, so nothing was sent. ADR-0002: prepared retries
        // retain their persisted eligibility and become the run's active
        // attempt so the driver dispatches them instead of new roots.
        this.adoptPrepared(attempt, summary);
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

    this.reconcileLegacyBookkeeping(summary);

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

  /**
   * ADR-0002: point the run's active-attempt bookkeeping at a surviving
   * prepared attempt. Missing pointers (legacy stores) are adopted when
   * unambiguous; conflicting pointers fail visibly.
   */
  private adoptPrepared(attempt: AttemptRecord, summary: RecoverySummary): void {
    if (attempt.kind !== "model" && attempt.kind !== "compaction") return;
    const run = this.deps.store.read((tx) => tx.runs.get(attempt.runId));
    if (!run) return;
    if (
      run.phase !== "request_model" &&
      run.phase !== "compact_context" &&
      run.checkpoint.activeAttempt === undefined
    ) {
      summary.recovered += 1;
      return;
    }
    const pointer = run.checkpoint.activeAttempt;
    if (pointer && pointer.attemptId !== attempt.id) {
      this.markAmbiguous(run, attempt);
      summary.unknown += 1;
      return;
    }
    if (pointer) {
      summary.recovered += 1;
      return;
    }
    const commit = this.deps.store.transaction((tx) => {
      const current = tx.runs.get(run.id);
      if (!current) return;
      const updated: RunRecord = {
        ...current,
        checkpoint: {
          ...current.checkpoint,
          activeAttempt: { attemptId: attempt.id, kind: attempt.kind },
        },
        updatedAt: this.deps.clock.now(),
      };
      tx.runs.update(updated);
      tx.changes.push({
        kind: "run.update",
        conversationId: run.conversationId,
        value: projectRun(updated),
      });
    });
    this.deps.publish(commit);
    summary.recovered += 1;
  }

  /**
   * ADR-0002: legacy runs in a model phase without an active-attempt pointer
   * are reconciled against their stored attempts. A single chain tail is
   * adopted; ambiguous state fails visibly rather than dispatching duplicate
   * roots or resetting retry limits.
   */
  private reconcileLegacyBookkeeping(summary: RecoverySummary): void {
    const active = this.deps.store.read((tx) => tx.runs.activeRuns());
    for (const run of active) {
      if (run.checkpoint.activeAttempt !== undefined) continue;
      if (run.state !== "running") continue;
      if (run.phase !== "request_model" && run.phase !== "compact_context") continue;
      const pending = this.deps.store.read((tx) =>
        tx.attempts
          .listForRun(run.id)
          .filter(
            (attempt) =>
              (attempt.kind === "model" || attempt.kind === "compaction") &&
              (attempt.state === "prepared" || attempt.state === "dispatched"),
          ),
      );
      if (pending.length === 0) continue;
      if (pending.length > 1) {
        this.markAmbiguous(run, pending[pending.length - 1] as AttemptRecord);
        summary.unknown += 1;
        continue;
      }
      const attempt = pending[0];
      if (!attempt) continue;
      if (attempt.state === "prepared") {
        this.adoptPrepared(attempt, summary);
      } else {
        this.recoverModel(run, attempt, summary);
      }
    }
  }

  /** ADR-0002: ambiguous historical bookkeeping becomes visible attention. */
  private markAmbiguous(run: RunRecord, attempt: AttemptRecord): void {
    const now = this.deps.clock.now();
    const commit = this.deps.store.transaction((tx) => {
      const current = tx.runs.get(run.id);
      if (!current) return;
      attempt.state = "unknown";
      attempt.errorCode = "MODEL_STATE_CONFLICT";
      attempt.errorMessage = "ambiguous pending model bookkeeping after reconstruction";
      attempt.uncertaintyJson = JSON.stringify({
        reason: "generation_restart",
        arguments: null,
        session: null,
        knownOutput: null,
      });
      attempt.updatedAt = now;
      tx.attempts.update(attempt);
      const updated: RunRecord = { ...current, state: "needs_attention", updatedAt: now };
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
  }

  private recoverModel(run: RunRecord, attempt: AttemptRecord, summary: RecoverySummary): void {
    const now = this.deps.clock.now();
    let retried = false;
    let wrote = false;
    const commit = this.deps.store.transaction((tx) => {
      const current = tx.runs.get(run.id);
      if (!current) return;
      // ADR-0002: the interrupted dispatched attempt consumes its invocation
      // chain budget, identical to the driver's accounting.
      const chain = countInvocationChain(tx, attempt);
      const canRetry = chain < this.deps.limits.maxModelAttempts;
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
      if (canRetry) {
        // ADR-0002: the retry child is created atomically with the parent
        // settlement; interrupted dispatched attempts retry immediately.
        const retry = createRetryChild(tx, this.deps.ids, now, {
          parent: attempt,
          run: current,
          retryEligibleAt: attempt.retryEligibleAt ?? now,
          errorCode: "MODEL_INTERRUPTED",
          errorMessage: "interrupted by a new object generation",
        });
        const updated: RunRecord = {
          ...current,
          checkpoint: {
            ...current.checkpoint,
            activeAttempt: { attemptId: retry.id, kind: attempt.kind },
          },
          updatedAt: now,
        };
        tx.runs.update(updated);
        retried = true;
        wrote = true;
        tx.changes.push({ kind: "attempt.update", conversationId: run.conversationId, value: projectAttempt(attempt) });
        tx.changes.push({ kind: "attempt.update", conversationId: run.conversationId, value: projectAttempt(retry) });
        tx.changes.push({ kind: "run.update", conversationId: run.conversationId, value: projectRun(updated) });
      } else {
        attempt.state = "failed";
        attempt.errorCode = "MODEL_INTERRUPTED";
        attempt.errorMessage = "interrupted by a new object generation";
        attempt.updatedAt = now;
        tx.attempts.update(attempt);
        const updated: RunRecord = {
          ...current,
          state: "failed",
          phase: "finish_turn",
          checkpoint: { ...current.checkpoint, activeAttempt: undefined },
          updatedAt: now,
        };
        tx.runs.update(updated);
        wrote = true;
        tx.changes.push({ kind: "attempt.update", conversationId: run.conversationId, value: projectAttempt(attempt) });
        tx.changes.push({ kind: "run.update", conversationId: run.conversationId, value: projectRun(updated) });
      }
    });
    this.deps.publish(commit);
    if (!wrote) {
      summary.recovered += 1;
      return;
    }
    if (retried) summary.retried += 1;
    else summary.recovered += 1;
  }

  private recoverTool(run: RunRecord, attempt: AttemptRecord, summary: RecoverySummary): void {
    const now = this.deps.clock.now();
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
        tx.changes.push({ kind: "attempt.update", conversationId: run.conversationId, value: projectAttempt(attempt) });
        tx.changes.push({ kind: "attempt.update", conversationId: run.conversationId, value: projectAttempt(retry) });
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
        tx.changes.push({ kind: "attempt.update", conversationId: run.conversationId, value: projectAttempt(attempt) });
        const current = tx.runs.get(run.id);
        if (current && current.state !== "completed" && current.state !== "cancelled" && current.state !== "failed") {
          const updated: RunRecord = { ...current, state: "needs_attention", updatedAt: now };
          tx.runs.update(updated);
          tx.changes.push({ kind: "run.update", conversationId: run.conversationId, value: projectRun(updated) });
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

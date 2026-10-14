// Committed partial output (PLAN.md -> Execution engine -> OutputCommitter).
// Partial output is committed in bounded batches; only committed output is
// presented as durable.

import type { SqlStore } from "../storage/SqlStore";
import type { Clock } from "./Clock";

export type OutputCommitListener = (attemptId: string, content: string, complete: boolean) => void;

export class OutputCommitter {
  private readonly buffers = new Map<string, string>();
  private readonly lastFlush = new Map<string, number>();

  constructor(
    private readonly store: SqlStore,
    private readonly clock: Clock,
    private readonly intervalMs = 100,
    private readonly listener?: OutputCommitListener,
  ) {}

  append(attemptId: string, delta: string): void {
    if (!delta) return;
    this.buffers.set(attemptId, (this.buffers.get(attemptId) ?? "") + delta);
    const now = this.clock.now();
    const last = this.lastFlush.get(attemptId) ?? 0;
    if (now - last >= this.intervalMs) this.flush(attemptId);
  }

  /** Force a commit of buffered output. Returns the full committed content. */
  flush(attemptId: string): string {
    const delta = this.buffers.get(attemptId);
    if (delta) {
      this.buffers.delete(attemptId);
      this.lastFlush.set(attemptId, this.clock.now());
      // ADR-0001: never write output for an attempt or run that no longer
      // exists; a deleted conversation must not be recreated by a late flush.
      const writable = this.store.read((tx) => {
        const attempt = tx.attempts.get(attemptId);
        return attempt !== undefined && tx.runs.get(attempt.runId) !== undefined;
      });
      if (!writable) return "";
      this.store.transaction((tx) => tx.liveOutput.append(attemptId, delta, this.clock.now()));
      const content = this.current(attemptId);
      this.listener?.(attemptId, content, false);
      return content;
    }
    return this.current(attemptId);
  }

  /** Flush and mark the attempt output complete. */
  close(attemptId: string): string {
    const content = this.flush(attemptId);
    this.buffers.delete(attemptId);
    this.listener?.(attemptId, content, true);
    return content;
  }

  /** Committed plus buffered content, without committing. */
  current(attemptId: string): string {
    const committed = this.store.read((tx) => tx.liveOutput.get(attemptId)?.content ?? "");
    return committed + (this.buffers.get(attemptId) ?? "");
  }

  clear(attemptId: string): void {
    this.buffers.delete(attemptId);
    this.lastFlush.delete(attemptId);
    this.store.transaction((tx) => tx.liveOutput.clear(attemptId));
  }

  /** ADR-0001: drop buffered output without writing it back to storage. */
  discard(attemptId: string): void {
    this.buffers.delete(attemptId);
    this.lastFlush.delete(attemptId);
  }
}

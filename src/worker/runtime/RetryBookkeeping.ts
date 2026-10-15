// ADR-0002: shared durable retry bookkeeping for the driver and recovery.
// Attempts form a parentAttemptId chain per logical model or compaction
// invocation; the chain length is the retry budget, and backoff eligibility is
// persisted once so reconstruction never recomputes it.

import type { StoreTransaction } from "../storage/SqlStore";
import type { AttemptRecord, RunRecord } from "../storage/records";
import type { IdGenerator } from "./Clock";

/**
 * Count the attempts along the parent chain of `leaf`, inclusive. A successful
 * tool round starts a new chain, so the count is per invocation, not per run.
 */
export function countInvocationChain(tx: StoreTransaction, leaf: AttemptRecord): number {
  let count = 0;
  let current: AttemptRecord | undefined = leaf;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    count += 1;
    if (!current.parentAttemptId) break;
    current = tx.attempts.get(current.parentAttemptId);
  }
  return count;
}

export interface RetryChildInput {
  parent: AttemptRecord;
  run: RunRecord;
  retryEligibleAt?: number;
  errorCode: string;
  errorMessage: string;
}

/**
 * ADR-0002: settle the parent as interrupted and create the prepared retry
 * child atomically. The child reuses the parent's frozen request artifact and
 * carries the run's current execution generation so it can dispatch.
 */
export function createRetryChild(
  tx: StoreTransaction,
  ids: IdGenerator,
  now: number,
  input: RetryChildInput,
): AttemptRecord {
  const { parent, run } = input;
  parent.state = "interrupted";
  parent.errorCode = input.errorCode;
  parent.errorMessage = input.errorMessage;
  parent.updatedAt = now;
  tx.attempts.update(parent);

  const child: AttemptRecord = {
    ...parent,
    id: ids.next("attempt"),
    state: "prepared",
    generation: run.generation,
    resultArtifactId: undefined,
    uncertaintyJson: undefined,
    errorCode: undefined,
    errorMessage: undefined,
    retryEligibleAt: input.retryEligibleAt,
    parentAttemptId: parent.id,
    createdAt: now,
    updatedAt: now,
  };
  tx.attempts.insert(child);
  return child;
}

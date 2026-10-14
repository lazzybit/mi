// Command acceptance with idempotency (PLAN.md -> Persistence and scheduling).
//
// Acceptance sequence:
//  1. enter the transition coordinator
//  2. check the command receipt table
//  3. ensure an alarm is scheduled
//  4. commit submission, run/inbox linkage, and receipt
//  5. leave the coordinator
//  6. publish the committed change and return the receipt
//
// ADR-0001: definitive deletion outcomes are persisted. A rejected mutation is
// rolled back before its rejection is stored, so a delayed retry returns the
// original refusal instead of running the destructive command later.

import { AppError, appErrorFromApi, type ApiError, type CommandEnvelope, type CommandReceipt } from "../../shared/domain";
import { hashPayload } from "../../shared/json";
import type { Commit, SqlStore, StoreTransaction } from "../storage/SqlStore";
import type { ServiceOutcome } from "../conversations/services";
import type { Clock } from "../runtime/Clock";
import type { TransitionCoordinator } from "../runtime/TransitionCoordinator";
import type { WakeScheduler } from "../runtime/WakeScheduler";

export interface CommandProcessorDeps {
  store: SqlStore;
  coordinator: TransitionCoordinator;
  wake: WakeScheduler;
  clock: Clock;
  publish(commit: Commit<unknown>): void;
}

export interface CommandProcessOptions<T = unknown> {
  /**
   * Persist definitive application rejections so a delayed retry cannot turn a
   * refusal into a later successful destructive command (ADR-0001).
   */
  persistRejections?: boolean;
  /** Value stored in the durable receipt; defaults to the handler value. */
  receiptValue?: (value: T) => unknown;
}

export type CommandHandler<T> = (tx: StoreTransaction, payload: unknown) => ServiceOutcome<T>;

export class CommandProcessor {
  constructor(private readonly deps: CommandProcessorDeps) {}

  async process<T>(
    kind: string,
    envelope: CommandEnvelope<unknown>,
    handler: CommandHandler<T>,
    options: CommandProcessOptions<T> = {},
  ): Promise<CommandReceipt<T>> {
    const payloadHash = hashPayload(envelope.payload);
    return this.deps.coordinator.exclusive(async () => {
      const existing = this.deps.store.read((tx) => tx.commands.find(envelope.commandId));
      if (existing) {
        // Both the command kind and the payload must match; a reused id with a
        // changed payload is a client error, not a replay.
        if (existing.kind !== kind || existing.payloadHash !== payloadHash) {
          throw new AppError(
            "CONFLICT",
            "commandId was reused with a different command or payload",
            false,
          );
        }
        if (existing.outcome === "rejected") {
          throw appErrorFromApi(JSON.parse(existing.resultJson) as ApiError);
        }
        return {
          commandId: envelope.commandId,
          revision: existing.revision,
          result: JSON.parse(existing.resultJson) as T,
        };
      }

      await this.deps.wake.ensureWakeBy(this.deps.clock.now());

      let commit: Commit<{ result: T; revision: number }>;
      try {
        commit = this.deps.store.transaction((tx) => {
          const outcome = handler(tx, envelope.payload);
          const revision = tx.ownerState.read().revision;
          tx.commands.insert({
            commandId: envelope.commandId,
            kind,
            payloadHash,
            resultJson: JSON.stringify(
              options.receiptValue ? options.receiptValue(outcome.value) : (outcome.value ?? null),
            ),
            revision,
            outcome: "accepted",
            createdAt: this.deps.clock.now(),
          });
          for (const change of outcome.changes) tx.changes.push(change);
          return { result: outcome.value, revision };
        });
      } catch (error) {
        if (options.persistRejections && error instanceof AppError) {
          this.recordRejection(kind, envelope.commandId, payloadHash, error);
        }
        throw error;
      }
      this.deps.publish(commit);
      return {
        commandId: envelope.commandId,
        revision: commit.value.revision,
        result: commit.value.result,
      };
    });
  }

  /**
   * Store a definitive rejection after the failed mutation has rolled back.
   * The rejection is a new transaction; it publishes no change.
   */
  private recordRejection(
    kind: string,
    commandId: string,
    payloadHash: string,
    error: AppError,
  ): void {
    this.deps.store.transaction((tx) => {
      tx.commands.insert({
        commandId,
        kind,
        payloadHash,
        resultJson: JSON.stringify(error.toApiError()),
        revision: tx.ownerState.read().revision,
        outcome: "rejected",
        createdAt: this.deps.clock.now(),
      });
    });
  }
}

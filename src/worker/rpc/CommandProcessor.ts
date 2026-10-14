// Command acceptance with idempotency (PLAN.md -> Persistence and scheduling).
//
// Acceptance sequence:
//  1. enter the transition coordinator
//  2. check the command receipt table
//  3. ensure an alarm is scheduled
//  4. commit submission, run/inbox linkage, and receipt
//  5. leave the coordinator
//  6. publish the committed change and return the receipt

import { AppError, type CommandEnvelope, type CommandReceipt } from "../../shared/domain";
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

export type CommandHandler<T> = (tx: StoreTransaction, payload: unknown) => ServiceOutcome<T>;

export class CommandProcessor {
  constructor(private readonly deps: CommandProcessorDeps) {}

  async process<T>(
    kind: string,
    envelope: CommandEnvelope<unknown>,
    handler: CommandHandler<T>,
  ): Promise<CommandReceipt<T>> {
    const payloadHash = hashPayload(envelope.payload);
    return this.deps.coordinator.exclusive(async () => {
      const existing = this.deps.store.read((tx) => tx.commands.find(envelope.commandId));
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw new AppError(
            "CONFLICT",
            "commandId was reused with a different command or payload",
          );
        }
        return {
          commandId: envelope.commandId,
          revision: existing.revision,
          result: JSON.parse(existing.resultJson) as T,
        };
      }

      await this.deps.wake.ensureWakeBy(this.deps.clock.now());

      const commit = this.deps.store.transaction((tx) => {
        const outcome = handler(tx, envelope.payload);
        const revision = tx.ownerState.read().revision;
        tx.commands.insert({
          commandId: envelope.commandId,
          kind,
          payloadHash,
          resultJson: JSON.stringify(outcome.value ?? null),
          revision,
          createdAt: this.deps.clock.now(),
        });
        for (const change of outcome.changes) tx.changes.push(change);
        return { result: outcome.value, revision };
      });
      this.deps.publish(commit);
      return {
        commandId: envelope.commandId,
        revision: commit.value.revision,
        result: commit.value.result,
      };
    });
  }
}

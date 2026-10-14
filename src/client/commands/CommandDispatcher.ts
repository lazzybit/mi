// Maps stable application command kinds to statically imported server
// functions and resends the same logical command after acknowledgement loss or
// a stale-bundle failure (PLAN.md -> Client -> CommandDispatcher).

import { AppError, type CommandEnvelope, type CommandReceipt } from "../../shared/domain";
import { stripUndefined } from "../../shared/json";
import { CommandOutbox, OUTBOX_SCHEMA_VERSION, type PendingCommand } from "./CommandOutbox";

export type CommandHandler = (command: CommandEnvelope<unknown>) => Promise<CommandReceipt<unknown>>;

export interface DispatchResult {
  receipt?: CommandReceipt<unknown>;
  status: "accepted" | "retry" | "rejected";
  error?: AppError;
}

export class CommandDispatcher {
  constructor(
    private readonly outbox: CommandOutbox,
    private readonly handlers: Record<string, CommandHandler>,
  ) {}

  newCommand(kind: string, payload: unknown): PendingCommand {
    return {
      commandId: crypto.randomUUID(),
      kind,
      payload: stripUndefined(payload),
      schemaVersion: OUTBOX_SCHEMA_VERSION,
      createdAt: Date.now(),
      state: "local_pending",
    };
  }

  async dispatch(command: PendingCommand): Promise<DispatchResult> {
    const handler = this.handlers[command.kind];
    if (!handler) {
      return { status: "rejected", error: new AppError("INVALID_INPUT", `unknown command kind ${command.kind}`) };
    }
    await this.outbox.enqueue({ ...command, state: "sending" });
    try {
      const receipt = await handler({ commandId: command.commandId, payload: command.payload });
      await this.outbox.acknowledge(command.commandId);
      return { status: "accepted", receipt };
    } catch (error) {
      const appError = toAppError(error);
      // Surface transport and serialization failures that would otherwise be
      // swallowed; application rejections are handled below.
      if (!appError) console.warn("mi: command transport failure", command.kind, error);
      // Definitive application rejections are terminal; transport failures and
      // stale-bundle reference errors keep the command pending for resend.
      if (appError && appError.code !== "UNAUTHENTICATED" && appError.code !== "CONFLICT") {
        await this.outbox.reject(command.commandId);
        return { status: "rejected", error: appError };
      }
      return { status: "retry", error: appError };
    }
  }

  /** Resend every pending command through the current function references. */
  async flush(): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];
    for (const command of await this.outbox.pending()) {
      results.push(await this.dispatch(command));
    }
    return results;
  }
}

function toAppError(error: unknown): AppError | undefined {
  if (error instanceof AppError) return error;
  return undefined;
}

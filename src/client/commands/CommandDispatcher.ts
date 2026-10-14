// Maps stable application command kinds to statically imported server
// functions and resends the same logical command after acknowledgement loss or
// a stale-bundle failure (PLAN.md -> Client -> CommandDispatcher).
//
// ADR-0001: a definitive deletion rejection leaves the outbox so an
// unavailable destructive action cannot run later. Transport uncertainty
// keeps the same logical command and command id for retry.

import { AppError, type CommandEnvelope, type CommandReceipt } from "../../shared/domain";
import { stripUndefined } from "../../shared/json";
import {
  CommandOutbox,
  OUTBOX_SCHEMA_VERSION,
  type PendingCommand,
  type PendingCommandTarget,
} from "./CommandOutbox";

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

  newCommand(kind: string, payload: unknown, target?: PendingCommandTarget): PendingCommand {
    const command: PendingCommand = {
      commandId: crypto.randomUUID(),
      kind,
      payload: stripUndefined(payload),
      schemaVersion: OUTBOX_SCHEMA_VERSION,
      createdAt: Date.now(),
      state: "local_pending",
    };
    const resolved = target ?? inferTarget(payload);
    if (resolved) command.target = resolved;
    return command;
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
      if (appError && this.isDefinitive(command.kind, appError)) {
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

  private isDefinitive(kind: string, error: AppError): boolean {
    if (error.code === "UNAUTHENTICATED") return false;
    // ADR-0001: any non-retryable deletion refusal is terminal.
    if (kind === "conversation.delete") return !error.retryable || error.code === "NOT_FOUND";
    return error.code !== "CONFLICT";
  }
}

function inferTarget(payload: unknown): PendingCommandTarget | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const target: PendingCommandTarget = {};
  if (typeof record.conversationId === "string") target.conversationId = record.conversationId;
  if (typeof record.runId === "string") target.runId = record.runId;
  if (typeof record.submissionId === "string") target.submissionId = record.submissionId;
  if (typeof record.attemptId === "string") target.attemptId = record.attemptId;
  return Object.keys(target).length > 0 ? target : undefined;
}

function toAppError(error: unknown): AppError | undefined {
  if (error instanceof AppError) return error;
  return undefined;
}

"use server";

import type {
  CommandEnvelope,
  CommandReceipt,
  ResolveAttemptInput,
  RunId,
  SubmitInput,
  SubmitResult,
} from "../shared/domain";
import type { WithdrawSubmissionInput } from "../shared/commands";
import { requireRpcContext } from "../worker/rpc/RpcContext";

export async function submitInput(
  command: CommandEnvelope<SubmitInput>,
): Promise<CommandReceipt<SubmitResult>> {
  return requireRpcContext().ownerStub.submit(command);
}

export async function withdrawSubmission(
  command: CommandEnvelope<WithdrawSubmissionInput>,
): Promise<CommandReceipt<void>> {
  return requireRpcContext().ownerStub.withdrawSubmission(command);
}

export async function cancelRun(
  command: CommandEnvelope<{ runId: RunId }>,
): Promise<CommandReceipt<void>> {
  return requireRpcContext().ownerStub.cancelRun(command);
}

export async function resumeRun(
  command: CommandEnvelope<{ runId: RunId }>,
): Promise<CommandReceipt<void>> {
  return requireRpcContext().ownerStub.resumeRun(command);
}

export async function resolveAttempt(
  command: CommandEnvelope<ResolveAttemptInput>,
): Promise<CommandReceipt<void>> {
  return requireRpcContext().ownerStub.resolveAttempt(command);
}

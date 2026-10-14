"use server";

import {
  AppError,
  type CommandEnvelope,
  type CommandFunctionOutcome,
  type CommandReceipt,
  type ConversationId,
  type HistoryPage,
  type HistoryQuery,
  type OwnerSnapshot,
} from "../shared/domain";
import type {
  CreateConversationInput,
  DeleteConversationInput,
  RenameConversationInput,
} from "../shared/commands";
import { requireRpcContext } from "../worker/rpc/RpcContext";

export async function createConversation(
  command: CommandEnvelope<CreateConversationInput>,
): Promise<CommandReceipt<{ conversationId: ConversationId }>> {
  return requireRpcContext().ownerStub.createConversation(command);
}

// ADR-0001: rename and delete return an explicit serializable outcome so a
// definitive rejection survives the Solid server-function boundary. A
// non-application failure is rethrown and stays an uncertain outcome.
export async function renameConversation(
  command: CommandEnvelope<RenameConversationInput>,
): Promise<CommandFunctionOutcome<void>> {
  try {
    const receipt = await requireRpcContext().ownerStub.renameConversation(command);
    return { ok: true, receipt };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error: error.toApiError() };
    throw error;
  }
}

export async function deleteConversation(
  command: CommandEnvelope<DeleteConversationInput>,
): Promise<CommandFunctionOutcome<void>> {
  try {
    const receipt = await requireRpcContext().ownerStub.deleteConversation(command);
    return { ok: true, receipt };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error: error.toApiError() };
    throw error;
  }
}

export async function getSnapshot(conversationId?: ConversationId): Promise<OwnerSnapshot> {
  return requireRpcContext().ownerStub.snapshot(conversationId);
}

export async function getHistory(query: HistoryQuery): Promise<HistoryPage> {
  return requireRpcContext().ownerStub.history(query);
}

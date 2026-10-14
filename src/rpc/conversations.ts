"use server";

import type {
  CommandEnvelope,
  CommandReceipt,
  ConversationId,
  HistoryPage,
  HistoryQuery,
  OwnerSnapshot,
} from "../shared/domain";
import type { CreateConversationInput, RenameConversationInput } from "../shared/commands";
import { requireRpcContext } from "../worker/rpc/RpcContext";

export async function createConversation(
  command: CommandEnvelope<CreateConversationInput>,
): Promise<CommandReceipt<{ conversationId: ConversationId }>> {
  return requireRpcContext().ownerStub.createConversation(command);
}

export async function renameConversation(
  command: CommandEnvelope<RenameConversationInput>,
): Promise<CommandReceipt<void>> {
  return requireRpcContext().ownerStub.renameConversation(command);
}

export async function getSnapshot(conversationId?: ConversationId): Promise<OwnerSnapshot> {
  return requireRpcContext().ownerStub.snapshot(conversationId);
}

export async function getHistory(query: HistoryQuery): Promise<HistoryPage> {
  return requireRpcContext().ownerStub.history(query);
}

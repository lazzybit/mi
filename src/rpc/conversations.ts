"use server";

// Catalog server functions (ADR-0003). They read and write the owner-scoped D1
// catalog directly; there is no owner Durable Object RPC.

import {
  AppError,
  type ActionResult,
  type CatalogView,
  type CommandEnvelope,
  type CommandReceipt,
  type ConversationId,
  type CreateConversationInput,
  type DeleteConversationInput,
  type RenameConversationInput,
} from "../shared/domain";
import { requireRpcContext } from "../worker/rpc/RpcContext";

export async function getCatalog(): Promise<CatalogView> {
  const context = requireRpcContext();
  return context.catalog.view(context.key);
}

export async function createConversation(
  command: CommandEnvelope<CreateConversationInput>,
): Promise<CommandReceipt<{ conversationId: ConversationId }>> {
  const context = requireRpcContext();
  return context.catalog.create(context.key, command, context.provision);
}

// ADR-0001: rename and delete return an explicit serializable outcome so a
// definitive rejection survives the Solid server-function boundary. A
// non-application failure is rethrown and stays an uncertain outcome.
export async function renameConversation(input: RenameConversationInput): Promise<ActionResult> {
  try {
    const context = requireRpcContext();
    await context.catalog.rename(context.key, input);
    return { ok: true };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error: error.toApiError() };
    throw error;
  }
}

export async function deleteConversation(input: DeleteConversationInput): Promise<ActionResult> {
  try {
    const context = requireRpcContext();
    await context.catalog.delete(context.key, input, context.erase);
    return { ok: true };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error: error.toApiError() };
    throw error;
  }
}

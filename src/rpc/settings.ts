"use server";

import type { CommandEnvelope, CommandReceipt, ModelProfileView } from "../shared/domain";
import type { SaveModelProfileInput } from "../shared/commands";
import { requireRpcContext } from "../worker/rpc/RpcContext";

export async function saveModelProfile(
  command: CommandEnvelope<SaveModelProfileInput>,
): Promise<CommandReceipt<ModelProfileView>> {
  return requireRpcContext().ownerStub.saveModelProfile(command);
}

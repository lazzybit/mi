"use server";

import type {
  CommandEnvelope,
  CommandReceipt,
  ConnectorId,
} from "../shared/domain";
import type { SaveConnectorInput, SetConnectorEnabledInput } from "../shared/commands";
import type { ConnectionReport } from "../worker/mcp/types";
import { requireRpcContext } from "../worker/rpc/RpcContext";

export async function saveConnector(
  command: CommandEnvelope<SaveConnectorInput>,
): Promise<CommandReceipt<{ connectorId: ConnectorId }>> {
  return requireRpcContext().ownerStub.saveConnector(command);
}

export async function setConnectorEnabled(
  command: CommandEnvelope<SetConnectorEnabledInput>,
): Promise<CommandReceipt<void>> {
  return requireRpcContext().ownerStub.setConnectorEnabled(command);
}

export async function connectConnector(connectorId: ConnectorId): Promise<ConnectionReport> {
  return requireRpcContext().ownerStub.connectConnector(connectorId);
}

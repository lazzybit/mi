// Typed owner RPC surface. The Solid server functions delegate here; the
// Durable Object stub never crosses the Solid serialization boundary
// (PLAN.md -> Server-function layer).

import type {
  ArtifactPage,
  ArtifactReadQuery,
  CommandEnvelope,
  CommandReceipt,
  ConnectorId,
  ConversationId,
  HistoryPage,
  HistoryQuery,
  ModelSettingsView,
  OwnerSnapshot,
  ResolveAttemptInput,
  RunId,
  SkillView,
  SubmitInput,
  SubmitResult,
} from "../../shared/domain";
import type {
  CreateConversationInput,
  CreateSkillInput,
  DeleteConversationInput,
  RenameConversationInput,
  SaveConnectorInput,
  SaveModelProfileInput,
  SelectConversationSkillsInput,
  SetConnectorEnabledInput,
  SkillIdInput,
  UpdateSkillInput,
  WithdrawSubmissionInput,
} from "../../shared/commands";
import type { ConnectionReport } from "../mcp/types";

export interface OwnerRpc {
  createConversation(command: CommandEnvelope<CreateConversationInput>): Promise<CommandReceipt<{ conversationId: ConversationId }>>;
  renameConversation(command: CommandEnvelope<RenameConversationInput>): Promise<CommandReceipt<void>>;
  deleteConversation(command: CommandEnvelope<DeleteConversationInput>): Promise<CommandReceipt<void>>;
  submit(command: CommandEnvelope<SubmitInput>): Promise<CommandReceipt<SubmitResult>>;
  withdrawSubmission(command: CommandEnvelope<WithdrawSubmissionInput>): Promise<CommandReceipt<void>>;
  cancelRun(command: CommandEnvelope<{ runId: RunId }>): Promise<CommandReceipt<void>>;
  resumeRun(command: CommandEnvelope<{ runId: RunId }>): Promise<CommandReceipt<void>>;
  resolveAttempt(command: CommandEnvelope<ResolveAttemptInput>): Promise<CommandReceipt<void>>;
  saveModelProfile(command: CommandEnvelope<SaveModelProfileInput>): Promise<CommandReceipt<ModelSettingsView>>;
  saveConnector(command: CommandEnvelope<SaveConnectorInput>): Promise<CommandReceipt<{ connectorId: ConnectorId }>>;
  setConnectorEnabled(command: CommandEnvelope<SetConnectorEnabledInput>): Promise<CommandReceipt<void>>;
  createSkill(command: CommandEnvelope<CreateSkillInput>): Promise<CommandReceipt<SkillView>>;
  updateSkill(command: CommandEnvelope<UpdateSkillInput>): Promise<CommandReceipt<SkillView>>;
  disableSkill(command: CommandEnvelope<SkillIdInput>): Promise<CommandReceipt<void>>;
  removeSkill(command: CommandEnvelope<SkillIdInput>): Promise<CommandReceipt<void>>;
  selectConversationSkills(command: CommandEnvelope<SelectConversationSkillsInput>): Promise<CommandReceipt<void>>;
  connectConnector(connectorId: ConnectorId): Promise<ConnectionReport>;
  snapshot(conversationId?: ConversationId): Promise<OwnerSnapshot>;
  history(query: HistoryQuery): Promise<HistoryPage>;
  readArtifact(query: ArtifactReadQuery): Promise<ArtifactPage>;
}

export type OwnerRpcCall = <T>(method: string, args: unknown[]) => Promise<T>;

export abstract class OwnerRpcBase implements OwnerRpc {
  protected abstract call<T>(method: string, args: unknown[]): Promise<T>;

  createConversation(command: CommandEnvelope<CreateConversationInput>) {
    return this.call<CommandReceipt<{ conversationId: ConversationId }>>("createConversation", [command]);
  }
  renameConversation(command: CommandEnvelope<RenameConversationInput>) {
    return this.call<CommandReceipt<void>>("renameConversation", [command]);
  }
  deleteConversation(command: CommandEnvelope<DeleteConversationInput>) {
    return this.call<CommandReceipt<void>>("deleteConversation", [command]);
  }
  submit(command: CommandEnvelope<SubmitInput>) {
    return this.call<CommandReceipt<SubmitResult>>("submit", [command]);
  }
  withdrawSubmission(command: CommandEnvelope<WithdrawSubmissionInput>) {
    return this.call<CommandReceipt<void>>("withdrawSubmission", [command]);
  }
  cancelRun(command: CommandEnvelope<{ runId: RunId }>) {
    return this.call<CommandReceipt<void>>("cancelRun", [command]);
  }
  resumeRun(command: CommandEnvelope<{ runId: RunId }>) {
    return this.call<CommandReceipt<void>>("resumeRun", [command]);
  }
  resolveAttempt(command: CommandEnvelope<ResolveAttemptInput>) {
    return this.call<CommandReceipt<void>>("resolveAttempt", [command]);
  }
  saveModelProfile(command: CommandEnvelope<SaveModelProfileInput>) {
    return this.call<CommandReceipt<ModelSettingsView>>("saveModelProfile", [command]);
  }
  saveConnector(command: CommandEnvelope<SaveConnectorInput>) {
    return this.call<CommandReceipt<{ connectorId: ConnectorId }>>("saveConnector", [command]);
  }
  setConnectorEnabled(command: CommandEnvelope<SetConnectorEnabledInput>) {
    return this.call<CommandReceipt<void>>("setConnectorEnabled", [command]);
  }
  createSkill(command: CommandEnvelope<CreateSkillInput>) {
    return this.call<CommandReceipt<SkillView>>("createSkill", [command]);
  }
  updateSkill(command: CommandEnvelope<UpdateSkillInput>) {
    return this.call<CommandReceipt<SkillView>>("updateSkill", [command]);
  }
  disableSkill(command: CommandEnvelope<SkillIdInput>) {
    return this.call<CommandReceipt<void>>("disableSkill", [command]);
  }
  removeSkill(command: CommandEnvelope<SkillIdInput>) {
    return this.call<CommandReceipt<void>>("removeSkill", [command]);
  }
  selectConversationSkills(command: CommandEnvelope<SelectConversationSkillsInput>) {
    return this.call<CommandReceipt<void>>("selectConversationSkills", [command]);
  }
  connectConnector(connectorId: ConnectorId) {
    return this.call<ConnectionReport>("connectConnector", [connectorId]);
  }
  snapshot(conversationId?: ConversationId) {
    return this.call<OwnerSnapshot>("snapshot", [conversationId]);
  }
  history(query: HistoryQuery) {
    return this.call<HistoryPage>("history", [query]);
  }
  readArtifact(query: ArtifactReadQuery) {
    return this.call<ArtifactPage>("readArtifact", [query]);
  }
}

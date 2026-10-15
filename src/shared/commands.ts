// Command payloads and the wire frames (PLAN.md -> Shared contracts).

import type {
  ArtifactId,
  ConnectorId,
  ConnectorAuthMode,
  ConversationId,
  ResolveAttemptInput,
  RunId,
  SkillId,
  SubmissionId,
  SubmitInput,
} from "./domain";

export interface CreateConversationInput {
  title?: string;
}

export interface RenameConversationInput {
  conversationId: ConversationId;
  title: string;
}

// ADR-0001: permanent conversation deletion uses the existing command path.
export interface DeleteConversationInput {
  conversationId: ConversationId;
}

export interface WithdrawSubmissionInput {
  submissionId: SubmissionId;
}

export interface CancelRunInput {
  runId: RunId;
}

export interface ResumeRunInput {
  runId: RunId;
}

/**
 * ADR-0002: model settings select an application-configured route; the server
 * resolves and validates catalog metadata. Client-supplied model metadata is
 * not authoritative.
 */
export interface RouteSettingsInput {
  gatewayId: string;
  routeId: string;
  thinkingLevel?: string;
  maxOutputTokens?: number;
}

export interface SaveModelProfileInput {
  settings: RouteSettingsInput;
}

export interface SaveConnectorInput {
  connectorId?: ConnectorId;
  name: string;
  endpoint: string;
  authMode: ConnectorAuthMode;
  role?: "container" | "web-research";
  /** For `header` mode: the credential to send. */
  headerName?: string;
  headerValue?: string;
  /** For `cf-access` mode: the trusted origin that receives the worker assertion. */
  trustedOrigin?: string;
}

export interface UpdateConnectorInput extends SaveConnectorInput {
  connectorId: ConnectorId;
}

export interface SetConnectorEnabledInput {
  connectorId: ConnectorId;
  enabled: boolean;
}

export interface CreateSkillInput {
  name: string;
  description: string;
  instructions: string;
  resources?: SkillResourceInput[];
}

export interface UpdateSkillInput {
  skillId: SkillId;
  name: string;
  description: string;
  instructions: string;
  resources?: SkillResourceInput[];
}

export interface SkillResourceInput {
  path: string;
  mediaType: string;
  /** Base64 or utf8 content, depending on `encoding`. */
  content: string;
  encoding: "utf8" | "base64";
}

export interface SkillIdInput {
  skillId: SkillId;
}

export interface SelectConversationSkillsInput {
  conversationId: ConversationId;
  skillIds: SkillId[];
}

export interface ResolveAttemptCommandInput extends ResolveAttemptInput {}

export type CommandKind =
  | "conversation.create"
  | "conversation.rename"
  | "conversation.delete"
  | "submission.submit"
  | "submission.withdraw"
  | "run.cancel"
  | "run.resume"
  | "run.resolve_attempt"
  | "settings.save_model_profile"
  | "connector.save"
  | "connector.set_enabled"
  | "skill.create"
  | "skill.update"
  | "skill.disable"
  | "skill.remove"
  | "skill.select_for_conversation";

export type { SubmitInput, ResolveAttemptInput };

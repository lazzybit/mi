// Shared domain contracts (ADR-0003, ADR-0004).
//
// mi manages user-visible conversations and coordinates peripheral
// capabilities. Agent execution and its authoritative state belong to
// pi-durable; this module keeps the D1 catalog projection and the model-route
// settings the Worker validates. ADR-0004 makes the application single-user, so
// the catalog and settings are application-wide rather than owner-scoped.

export type ConversationId = string;
export type CommandId = string;

export interface CommandEnvelope<T> {
  commandId: CommandId;
  payload: T;
}

export interface CommandReceipt<T> {
  commandId: CommandId;
  result: T;
}

/**
 * ADR-0001: explicit serializable reply for management server functions. The
 * Solid server-function boundary may not preserve thrown `AppError`
 * instances, so the adapter reconstructs one on the client.
 */
export type ActionResult =
  | { ok: true }
  | { ok: false; error: ApiError };

export type ApiErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "NOT_CONFIGURED"
  | "NOT_READY";

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  retryable: boolean;
}

/** Thrown by server code; serialized into `ApiError` across the RPC boundary. */
export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly retryable: boolean;

  constructor(code: ApiErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.retryable = retryable;
  }

  toApiError(): ApiError {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

/**
 * ADR-0001: reconstruct a browser-local `AppError` from a serialized
 * application error that crossed a server-function boundary.
 */
export function appErrorFromApi(api: ApiError): AppError {
  return new AppError(api.code, api.message, api.retryable);
}

// ---------------------------------------------------------------------------
// Application catalog (D1)
// ---------------------------------------------------------------------------

/** Lifecycle of a managed conversation row. */
export type ConversationLifecycle = "creating" | "active" | "deleting";

export interface ConversationSummary {
  id: ConversationId;
  title: string;
  lifecycle: ConversationLifecycle;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Model routes and settings (ADR-0002)
// ---------------------------------------------------------------------------

export type ModelProtocol = "openai-responses" | "openai-chat-completions" | "anthropic-messages";

/**
 * ADR-0002: a repository-configured model route with catalog-derived display
 * metadata. Users never supply provider protocols or token limits.
 */
export interface ModelRouteView {
  routeId: string;
  label: string;
  provider: string;
  modelId: string;
  api: string;
  contextWindow: number;
  maxTokens: number;
  thinkingLevels: string[];
}

/** The server-validated model settings projection (ADR-0002). */
export interface ModelSettingsView {
  kind: "route";
  gatewayId: string;
  routeId: string;
  /** Catalog-derived display name of the resolved model. */
  label: string;
  thinkingLevel?: string;
  maxOutputTokens?: number;
  contextWindow: number;
  maxTokens: number;
  thinkingLevels: string[];
}

/**
 * ADR-0003: the application catalog the client fetches over HTTP. It carries no
 * execution state; the selected conversation's transcript and live state come
 * from its session socket.
 */
export interface CatalogView {
  conversations: ConversationSummary[];
  routes: ModelRouteView[];
  model?: ModelSettingsView;
}

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

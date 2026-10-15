import type {
  AppError,
  ConversationId,
  ModelSettingsView,
  RouteSettingsInput,
} from "../../shared/domain";
import type { SubmissionId } from "@earendil-works/pi-durable";
import type { ConnectionStatus } from "../session/SessionFeed";

export type AppView = "chat" | "settings";

export interface DispatchResult {
  status: "accepted" | "rejected" | "retry";
  error?: AppError;
}

export interface AppActions {
  createConversation(): Promise<DispatchResult>;
  renameConversation(id: ConversationId, title: string): Promise<DispatchResult>;
  deleteConversation(id: ConversationId): Promise<DispatchResult>;
  submit(text: string, whenBusy: "followUp" | "steer"): Promise<void>;
  withdraw(submissionId: SubmissionId): Promise<void>;
  cancel(): Promise<void>;
  saveModelProfile(settings: RouteSettingsInput): Promise<ModelSettingsView | undefined>;
  selectConversation(id?: string): void;
  setView(view: AppView): void;
  reconnect(): void;
}

export type { ConnectionStatus };

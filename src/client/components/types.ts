import type { OwnerSnapshot } from "../../shared/domain";
import type { ConnectionStatus } from "../sync/ConversationFeed";

export type AppView = "chat" | "settings";

export interface AppActions {
  dispatch(kind: string, payload: unknown): Promise<void>;
  selectConversation(id?: string): void;
  setView(view: AppView): void;
  reconnect(): void;
}

export interface ScreenProps {
  snapshot: OwnerSnapshot;
  status: ConnectionStatus;
  actions: AppActions;
}

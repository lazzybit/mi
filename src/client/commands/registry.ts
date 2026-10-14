// Statically imported server-function references keyed by stable command kind
// (PLAN.md -> Client -> CommandDispatcher). A deployment can change generated
// function references while an old bundle keeps an outbox entry; the entry is
// resent through the current reference for the same logical kind.

import { cancelRun, resolveAttempt, resumeRun, submitInput, withdrawSubmission } from "../../rpc/runs";
import { createConversation, renameConversation } from "../../rpc/conversations";
import { saveModelProfile } from "../../rpc/settings";
import { connectConnector, saveConnector, setConnectorEnabled } from "../../rpc/connectors";
import {
  createSkill,
  disableSkill,
  removeSkill,
  selectConversationSkills,
  updateSkill,
} from "../../rpc/skills";
import type { CommandHandler } from "./CommandDispatcher";

export function createCommandHandlers(): Record<string, CommandHandler> {
  return {
    "conversation.create": (command) => createConversation(command as never),
    "conversation.rename": (command) => renameConversation(command as never),
    "submission.submit": (command) => submitInput(command as never),
    "submission.withdraw": (command) => withdrawSubmission(command as never),
    "run.cancel": (command) => cancelRun(command as never),
    "run.resume": (command) => resumeRun(command as never),
    "run.resolve_attempt": (command) => resolveAttempt(command as never),
    "settings.save_model_profile": (command) => saveModelProfile(command as never),
    "connector.save": (command) => saveConnector(command as never),
    "connector.set_enabled": (command) => setConnectorEnabled(command as never),
    "connector.connect": (command) =>
      connectConnector((command.payload as { connectorId: string }).connectorId) as never,
    "skill.create": (command) => createSkill(command as never),
    "skill.update": (command) => updateSkill(command as never),
    "skill.disable": (command) => disableSkill(command as never),
    "skill.remove": (command) => removeSkill(command as never),
    "skill.select_for_conversation": (command) => selectConversationSkills(command as never),
  };
}

"use server";

import type { CommandEnvelope, CommandReceipt, SkillView } from "../shared/domain";
import type {
  CreateSkillInput,
  SelectConversationSkillsInput,
  SkillIdInput,
  UpdateSkillInput,
} from "../shared/commands";
import { requireRpcContext } from "../worker/rpc/RpcContext";

export async function createSkill(
  command: CommandEnvelope<CreateSkillInput>,
): Promise<CommandReceipt<SkillView>> {
  return requireRpcContext().ownerStub.createSkill(command);
}

export async function updateSkill(
  command: CommandEnvelope<UpdateSkillInput>,
): Promise<CommandReceipt<SkillView>> {
  return requireRpcContext().ownerStub.updateSkill(command);
}

export async function disableSkill(
  command: CommandEnvelope<SkillIdInput>,
): Promise<CommandReceipt<void>> {
  return requireRpcContext().ownerStub.disableSkill(command);
}

export async function removeSkill(
  command: CommandEnvelope<SkillIdInput>,
): Promise<CommandReceipt<void>> {
  return requireRpcContext().ownerStub.removeSkill(command);
}

export async function selectConversationSkills(
  command: CommandEnvelope<SelectConversationSkillsInput>,
): Promise<CommandReceipt<void>> {
  return requireRpcContext().ownerStub.selectConversationSkills(command);
}

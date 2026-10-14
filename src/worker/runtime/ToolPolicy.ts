// Tool replay policy (PLAN.md -> Behavior -> Remote tool interruption).
//
// A configured role identifies the known helper contract; a matching tool name
// on an arbitrary server does not establish replay safety.

import type { ReplayPolicy } from "../../shared/domain";
import type { ToolDescriptor, ToolPolicy } from "../mcp/types";

export const APPLICATION_TOOL_PREFIX = "app__";

export const APPLICATION_TOOLS: readonly string[] = [
  "read_skill",
  "read_skill_resource",
  "read_tool_result",
  "read_repository_instructions",
];

const CONTAINER_SAFE_TOOLS = new Set(["read"]);
const CONTAINER_UNSAFE_TOOLS = new Set(["write", "edit", "bash"]);
const WEB_RESEARCH_SAFE_TOOLS = new Set(["search_topic", "fetch_page"]);

export class ToolPolicyRegistry implements ToolPolicy {
  replayPolicy(descriptor: ToolDescriptor): ReplayPolicy {
    if (descriptor.alias.startsWith(APPLICATION_TOOL_PREFIX)) return "safe";
    if (descriptor.connectorId.startsWith("app:")) return "safe";
    return "unsafe";
  }

  isAllowedDuringReconciliation(descriptor: ToolDescriptor): boolean {
    if (descriptor.alias.startsWith(APPLICATION_TOOL_PREFIX)) return true;
    return false;
  }

  /** Role-aware classification used by the recovery matrix. */
  classifyRoleTool(role: "container" | "web-research" | undefined, remoteName: string): ReplayPolicy {
    if (role === "container") {
      if (CONTAINER_SAFE_TOOLS.has(remoteName)) return "safe";
      if (CONTAINER_UNSAFE_TOOLS.has(remoteName)) return "unsafe";
      return "unsafe";
    }
    if (role === "web-research") {
      if (WEB_RESEARCH_SAFE_TOOLS.has(remoteName)) return "safe";
      return "unsafe";
    }
    return "unsafe";
  }
}

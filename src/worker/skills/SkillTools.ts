// Reserved application tools (PLAN.md -> Skills and context -> SkillTools).
// Only versions selected in the current conversation context are readable,
// resource paths are normalized, and traversal is rejected.

import { AppError } from "../../shared/domain";
import { normalizeResourcePath } from "../../shared/json";
import type { SqlStore } from "../storage/SqlStore";
import type { ApplicationToolHandler } from "../mcp/ToolRouter";
import type { ToolExecutionOutcome, ToolInvocation } from "../mcp/types";
import type { RepositoryContextService } from "../context/RepositoryContextService";

const APPLICATION_PREFIX = "app__";

export class SkillTools implements ApplicationToolHandler {
  constructor(
    private readonly store: SqlStore,
    private readonly repository?: RepositoryContextService,
  ) {}

  handles(alias: string): boolean {
    return alias.startsWith(APPLICATION_PREFIX);
  }

  async execute(alias: string, args: unknown, _invocation: ToolInvocation): Promise<ToolExecutionOutcome> {
    const name = alias.startsWith(APPLICATION_PREFIX) ? alias.slice(APPLICATION_PREFIX.length) : alias;
    const input = (args ?? {}) as Record<string, unknown>;
    switch (name) {
      case "read_skill":
        return this.readSkill(input);
      case "read_skill_resource":
        return this.readSkillResource(input);
      case "read_tool_result":
        return this.readToolResult(input);
      case "read_repository_instructions":
        return this.readRepositoryInstructions(input);
      default:
        throw new AppError("CONNECTOR_UNAVAILABLE", `unknown application tool: ${alias}`);
    }
  }

  private readSkill(input: Record<string, unknown>): ToolExecutionOutcome {
    const skillId = requireString(input, "skillId");
    const version = requireNumber(input, "version");
    const record = this.store.read((tx) => tx.skills.getVersion(skillId, version));
    if (!record) throw new AppError("NOT_FOUND", "skill version not found");
    return textResult(`# ${record.name}\n\n${record.instructions}`);
  }

  private readSkillResource(input: Record<string, unknown>): ToolExecutionOutcome {
    const skillId = requireString(input, "skillId");
    const version = requireNumber(input, "version");
    const path = normalizeResourcePath(requireString(input, "path"));
    const resource = this.store.read((tx) => tx.skills.getResource(skillId, version, path));
    if (!resource) throw new AppError("NOT_FOUND", "skill resource not found");
    const text = this.store.read((tx) => {
      const chunks = tx.artifacts.readChunks(resource.artifactId);
      return chunks.map((chunk) => chunk.data).join("");
    });
    return textResult(text);
  }

  private readToolResult(input: Record<string, unknown>): ToolExecutionOutcome {
    const artifactId = requireString(input, "artifactId");
    const offset = typeof input.offset === "number" ? input.offset : 0;
    const limit = typeof input.limit === "number" ? Math.min(input.limit, 262_144) : 65_536;
    const text = this.store.read((tx) => {
      const artifact = tx.artifacts.get(artifactId);
      if (!artifact) throw new AppError("NOT_FOUND", "artifact not found");
      const chunks = tx.artifacts.readChunks(artifactId);
      return chunks.map((chunk) => chunk.data).join("").slice(offset, offset + limit);
    });
    return textResult(text);
  }

  private async readRepositoryInstructions(input: Record<string, unknown>): Promise<ToolExecutionOutcome> {
    if (!this.repository) {
      throw new AppError("NOT_CONFIGURED", "repository instructions are not configured");
    }
    const path = requireString(input, "path");
    const instructions = await this.repository.loadForPath(path);
    if (instructions.length === 0) {
      return textResult(`No repository instructions apply to ${path}.`);
    }
    const text = instructions
      .map((instruction) => `# ${instruction.path}\n${instruction.content}`)
      .join("\n\n");
    return textResult(text);
  }
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError("INVALID_INPUT", `${key} must be a non-empty string`);
  }
  return value;
}

function requireNumber(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError("INVALID_INPUT", `${key} must be a number`);
  }
  return value;
}

function textResult(text: string): ToolExecutionOutcome {
  return { isError: false, content: [{ type: "text", text }] };
}

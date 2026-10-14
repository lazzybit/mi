// Repository instruction context (PLAN.md -> Skills and context ->
// RepositoryContextService).
//
// Fetching instructions is an explicit, recorded operation through the
// configured container connector; context assembly reads only committed
// records and never hides remote I/O inside prompt rendering.

import { AppError } from "../../shared/domain";
import { hashPayload, normalizeResourcePath } from "../../shared/json";
import type { SqlStore } from "../storage/SqlStore";
import type { RepositoryInstructionRecord } from "../storage/records";
import type { Clock, IdGenerator } from "../runtime/Clock";

export interface RepositoryInstructionContent {
  path: string;
  directory: string;
  content: string;
}

export const DEFAULT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];

export interface RepositoryContextDeps {
  store: SqlStore;
  clock: Clock;
  ids: IdGenerator;
  /** The selected workspace root, or undefined when none is configured. */
  workspaceRoot: () => string | undefined;
  /** A recorded file read through the configured container connector. */
  readFile: (path: string) => Promise<string>;
  instructionFiles?: string[];
}

export class RepositoryContextService {
  private readonly instructionFiles: string[];

  constructor(private readonly deps: RepositoryContextDeps) {
    this.instructionFiles = deps.instructionFiles ?? DEFAULT_INSTRUCTION_FILES;
  }

  /** Committed instructions applicable to `path`, fetching any that are missing. */
  async loadForPath(path: string): Promise<RepositoryInstructionContent[]> {
    const root = this.requireRoot();
    const candidates = this.candidatePaths(path);
    const resolved: RepositoryInstructionContent[] = [];
    for (const candidate of candidates) {
      const record = this.deps.store.read((tx) => tx.repositoryInstructions.get(root, candidate));
      if (record) {
        // A negative record means the file was confirmed absent; do not retry.
        if (record.present) resolved.push(this.toContent(record.artifactId, record.path, record.directory));
        continue;
      }
      const fetched = await this.tryFetch(root, candidate);
      if (fetched) resolved.push(fetched);
    }
    return resolved;
  }

  /** Committed instructions applicable to `path`. Performs no remote I/O. */
  applicable(path: string): RepositoryInstructionContent[] {
    const root = this.deps.workspaceRoot();
    if (!root) return [];
    const resolved: RepositoryInstructionContent[] = [];
    for (const candidate of this.candidatePaths(path)) {
      const record = this.deps.store.read((tx) => tx.repositoryInstructions.get(root, candidate));
      if (record?.present) resolved.push(this.toContent(record.artifactId, record.path, record.directory));
    }
    return resolved;
  }

  /** All committed instructions for the workspace, ordered by path. */
  listCommitted(): RepositoryInstructionContent[] {
    const root = this.deps.workspaceRoot();
    if (!root) return [];
    return this.deps.store
      .read((tx) => tx.repositoryInstructions.list(root))
      .filter((record) => record.present)
      .map((record) => this.toContent(record.artifactId, record.path, record.directory));
  }

  records(): RepositoryInstructionRecord[] {
    const root = this.deps.workspaceRoot();
    if (!root) return [];
    return this.deps.store.read((tx) => tx.repositoryInstructions.list(root));
  }

  private requireRoot(): string {
    const root = this.deps.workspaceRoot();
    if (!root) {
      throw new AppError("NOT_CONFIGURED", "no repository workspace is configured");
    }
    return root;
  }

  private async tryFetch(
    root: string,
    candidate: string,
  ): Promise<RepositoryInstructionContent | undefined> {
    const now = this.deps.clock.now();
    let content: string | undefined;
    try {
      content = await this.deps.readFile(candidate);
    } catch {
      content = undefined;
    }
    if (content === undefined || !content.trim()) {
      // Record a confirmed absence so the file is not refetched on every load.
      this.deps.store.transaction((tx) =>
        tx.repositoryInstructions.upsert({
          id: this.deps.ids.next("instr"),
          workspaceRoot: root,
          path: candidate,
          directory: dirname(candidate),
          artifactId: "",
          digest: "",
          present: false,
          fetchedAt: now,
        }),
      );
      return undefined;
    }
    const artifactId = this.deps.ids.next("artifact");
    const digest = hashPayload(content);
    this.deps.store.transaction((tx) => {
      tx.artifacts.create({
        id: artifactId,
        mimeType: "text/markdown",
        encoding: "utf8",
        byteCount: 0,
        complete: false,
        createdAt: now,
      });
      tx.artifacts.appendChunk(artifactId, 0, content as string, content.length);
      tx.artifacts.complete(artifactId, digest);
      tx.repositoryInstructions.upsert({
        id: this.deps.ids.next("instr"),
        workspaceRoot: root,
        path: candidate,
        directory: dirname(candidate),
        artifactId,
        digest,
        present: true,
        fetchedAt: now,
      });
    });
    return { path: candidate, directory: dirname(candidate), content };
  }

  private toContent(artifactId: string, path: string, directory: string): RepositoryInstructionContent {
    return { path, directory, content: this.readArtifact(artifactId) };
  }

  private readArtifact(artifactId: string): string {
    return this.deps.store.read((tx) =>
      tx.artifacts
        .readChunks(artifactId)
        .map((chunk) => chunk.data)
        .join(""),
    );
  }

  /** Instruction files along the path hierarchy, ordered root -> leaf. */
  private candidatePaths(target: string): string[] {
    const normalized = normalizeResourcePath(target);
    const segments = normalized.split("/");
    segments.pop();
    const directories: string[] = [""];
    let accumulated = "";
    for (const segment of segments) {
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;
      directories.push(accumulated);
    }
    const candidates: string[] = [];
    for (const directory of directories) {
      for (const file of this.instructionFiles) {
        candidates.push(directory ? `${directory}/${file}` : file);
      }
    }
    return candidates;
  }
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

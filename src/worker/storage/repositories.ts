// Repositories over the SQL schema. Business modules call these; they never
// build SQL themselves (PLAN.md -> Components -> storage).

import {
  all,
  boolToInt,
  chunk,
  count,
  first,
  intToBool,
  parseJson,
  run,
  stringifyJson,
  type SqlExecutor,
  type SqlValue,
} from "./Sql";
import type {
  ArtifactRecord,
  AttemptRecord,
  AttemptResolutionRecord,
  CommandReceiptRecord,
  ContextSnapshotRecord,
  ConversationRecord,
  ConversationSkillRecord,
  CredentialRecord,
  EntryRecord,
  LiveOutputRecord,
  McpServerRecord,
  McpToolRecord,
  OAuthTransactionRecord,
  OwnerStateRecord,
  RepositoryInstructionRecord,
  RunCheckpoint,
  RunRecord,
  SkillRecord,
  SkillResourceRecord,
  SkillVersionRecord,
  SubmissionRecord,
} from "./records";
import type { ConnectorAuthMode, RunState, SubmissionState } from "../types";
import type { RunPhase } from "./records";

export class OwnerStateRepository {
  constructor(private readonly sql: SqlExecutor) {}

  ensure(): void {
    run(
      this.sql,
      `INSERT INTO owner_state (id, revision, schema_version, driver_generation)
       VALUES (1, 0, 0, 0) ON CONFLICT (id) DO NOTHING`,
    );
  }

  read(): OwnerStateRecord {
    const row = first<{ revision: number; schema_version: number; driver_generation: number }>(
      this.sql,
      `SELECT revision, schema_version, driver_generation FROM owner_state WHERE id = 1`,
    );
    return {
      revision: Number(row?.revision ?? 0),
      schemaVersion: Number(row?.schema_version ?? 0),
      driverGeneration: Number(row?.driver_generation ?? 0),
    };
  }

  /** Allocate the next owner-wide revision inside the current transaction. */
  bumpRevision(): number {
    run(this.sql, `UPDATE owner_state SET revision = revision + 1 WHERE id = 1`);
    return this.read().revision;
  }

  setSchemaVersion(version: number): void {
    run(this.sql, `UPDATE owner_state SET schema_version = ? WHERE id = 1`, version);
  }

  bumpDriverGeneration(): number {
    run(
      this.sql,
      `UPDATE owner_state SET driver_generation = driver_generation + 1 WHERE id = 1`,
    );
    return this.read().driverGeneration;
  }

  readDriverGeneration(): number {
    return this.read().driverGeneration;
  }
}

export class CommandReceiptRepository {
  constructor(private readonly sql: SqlExecutor) {}

  find(commandId: string): CommandReceiptRecord | undefined {
    const row = first<{
      command_id: string;
      kind: string;
      payload_hash: string;
      result_json: string;
      revision: number;
      outcome: string | null;
      created_at: number;
    }>(
      this.sql,
      `SELECT command_id, kind, payload_hash, result_json, revision, outcome, created_at
       FROM command_receipts WHERE command_id = ?`,
      commandId,
    );
    if (!row) return undefined;
    return {
      commandId: row.command_id,
      kind: row.kind,
      payloadHash: row.payload_hash,
      resultJson: row.result_json,
      revision: Number(row.revision),
      outcome: row.outcome === "rejected" ? "rejected" : "accepted",
      createdAt: Number(row.created_at),
    };
  }

  insert(record: CommandReceiptRecord): void {
    run(
      this.sql,
      `INSERT INTO command_receipts (command_id, kind, payload_hash, result_json, revision, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      record.commandId,
      record.kind,
      record.payloadHash,
      record.resultJson,
      record.revision,
      record.outcome,
      record.createdAt,
    );
  }
}

export class SettingsRepository {
  constructor(private readonly sql: SqlExecutor) {}

  ensure(): void {
    run(
      this.sql,
      `INSERT INTO settings (id, model_profile_json, workspace_root, settings_version)
       VALUES (1, NULL, NULL, 0) ON CONFLICT (id) DO NOTHING`,
    );
  }

  read(): {
    modelProfileJson?: string;
    workspaceRoot?: string;
    settingsVersion: number;
  } {
    const row = first<{
      model_profile_json: string | null;
      workspace_root: string | null;
      settings_version: number;
    }>(
      this.sql,
      `SELECT model_profile_json, workspace_root, settings_version FROM settings WHERE id = 1`,
    );
    return {
      modelProfileJson: row?.model_profile_json ?? undefined,
      workspaceRoot: row?.workspace_root ?? undefined,
      settingsVersion: Number(row?.settings_version ?? 0),
    };
  }

  writeModelProfile(json: string): number {
    run(
      this.sql,
      `UPDATE settings SET model_profile_json = ?, settings_version = settings_version + 1 WHERE id = 1`,
      json,
    );
    return this.read().settingsVersion;
  }

  writeWorkspaceRoot(root: string | null): number {
    run(
      this.sql,
      `UPDATE settings SET workspace_root = ?, settings_version = settings_version + 1 WHERE id = 1`,
      root,
    );
    return this.read().settingsVersion;
  }
}

export class ConversationRepository {
  constructor(private readonly sql: SqlExecutor) {}

  create(record: ConversationRecord): void {
    run(
      this.sql,
      `INSERT INTO conversations (id, title, created_at, updated_at, selected_profile, workspace_config)
       VALUES (?, ?, ?, ?, ?, ?)`,
      record.id,
      record.title,
      record.createdAt,
      record.updatedAt,
      record.selectedProfile ?? null,
      record.workspaceConfig ?? null,
    );
  }

  get(id: string): ConversationRecord | undefined {
    const row = first<{
      id: string;
      title: string;
      created_at: number;
      updated_at: number;
      selected_profile: string | null;
      workspace_config: string | null;
    }>(
      this.sql,
      `SELECT id, title, created_at, updated_at, selected_profile, workspace_config
       FROM conversations WHERE id = ?`,
      id,
    );
    if (!row) return undefined;
    return {
      id: row.id,
      title: row.title,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      selectedProfile: row.selected_profile ?? undefined,
      workspaceConfig: row.workspace_config ?? undefined,
    };
  }

  list(): ConversationRecord[] {
    return all<{
      id: string;
      title: string;
      created_at: number;
      updated_at: number;
      selected_profile: string | null;
      workspace_config: string | null;
    }>(
      this.sql,
      `SELECT id, title, created_at, updated_at, selected_profile, workspace_config
       FROM conversations ORDER BY updated_at DESC`,
    ).map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      selectedProfile: row.selected_profile ?? undefined,
      workspaceConfig: row.workspace_config ?? undefined,
    }));
  }

  rename(id: string, title: string, updatedAt: number): void {
    run(
      this.sql,
      `UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`,
      title,
      updatedAt,
      id,
    );
  }

  // ADR-0001: permanent removal of the conversation row.
  delete(id: string): void {
    run(this.sql, `DELETE FROM conversations WHERE id = ?`, id);
  }

  touch(id: string, updatedAt: number): void {
    run(this.sql, `UPDATE conversations SET updated_at = ? WHERE id = ?`, updatedAt, id);
  }

  nextEntrySequence(conversationId: string): number {
    const row = first<{ n: number }>(
      this.sql,
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM entries WHERE conversation_id = ?`,
      conversationId,
    );
    return Number(row?.n ?? 1);
  }

  maxEntrySequence(conversationId: string): number {
    const row = first<{ n: number }>(
      this.sql,
      `SELECT COALESCE(MAX(sequence), 0) AS n FROM entries WHERE conversation_id = ?`,
      conversationId,
    );
    return Number(row?.n ?? 0);
  }
}

export class SubmissionRepository {
  constructor(private readonly sql: SqlExecutor) {}

  insert(record: SubmissionRecord): void {
    run(
      this.sql,
      `INSERT INTO submissions (id, conversation_id, command_id, mode, owner_sequence, content, state, run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.conversationId,
      record.commandId,
      record.mode,
      record.ownerSequence,
      record.content,
      record.state,
      record.runId ?? null,
      record.createdAt,
    );
  }

  get(id: string): SubmissionRecord | undefined {
    return mapSubmission(
      first<SubmissionRow>(
        this.sql,
        `SELECT id, conversation_id, command_id, mode, owner_sequence, content, state, run_id, created_at
         FROM submissions WHERE id = ?`,
        id,
      ),
    );
  }

  findByCommandId(commandId: string): SubmissionRecord | undefined {
    return mapSubmission(
      first<SubmissionRow>(
        this.sql,
        `SELECT id, conversation_id, command_id, mode, owner_sequence, content, state, run_id, created_at
         FROM submissions WHERE command_id = ?`,
        commandId,
      ),
    );
  }

  nextOwnerSequence(): number {
    const row = first<{ n: number }>(
      this.sql,
      `SELECT COALESCE(MAX(owner_sequence), 0) + 1 AS n FROM submissions`,
    );
    return Number(row?.n ?? 1);
  }

  listQueued(): SubmissionRecord[] {
    return all<SubmissionRow>(
      this.sql,
      `SELECT id, conversation_id, command_id, mode, owner_sequence, content, state, run_id, created_at
       FROM submissions WHERE state = 'queued' ORDER BY owner_sequence ASC`,
    ).map((row) => mapSubmission(row) as SubmissionRecord);
  }

  listQueuedForConversation(conversationId: string): SubmissionRecord[] {
    return all<SubmissionRow>(
      this.sql,
      `SELECT id, conversation_id, command_id, mode, owner_sequence, content, state, run_id, created_at
       FROM submissions WHERE state = 'queued' AND conversation_id = ? ORDER BY owner_sequence ASC`,
      conversationId,
    ).map((row) => mapSubmission(row) as SubmissionRecord);
  }

  listSteeringForRun(runId: string): SubmissionRecord[] {
    return all<SubmissionRow>(
      this.sql,
      `SELECT id, conversation_id, command_id, mode, owner_sequence, content, state, run_id, created_at
       FROM submissions WHERE state = 'steering' AND run_id = ? ORDER BY owner_sequence ASC`,
      runId,
    ).map((row) => mapSubmission(row) as SubmissionRecord);
  }

  setState(id: string, state: SubmissionState, runId?: string): void {
    run(
      this.sql,
      `UPDATE submissions SET state = ?, run_id = COALESCE(?, run_id) WHERE id = ?`,
      state,
      runId ?? null,
      id,
    );
  }

  claimForRun(id: string, runId: string, state: SubmissionState): void {
    run(
      this.sql,
      `UPDATE submissions SET state = ?, run_id = ? WHERE id = ?`,
      state,
      runId,
      id,
    );
  }

  // ADR-0001: conversation-owned submissions are removed with the conversation.
  deleteForConversation(conversationId: string): void {
    run(this.sql, `DELETE FROM submissions WHERE conversation_id = ?`, conversationId);
  }
}

interface SubmissionRow {
  id: string;
  conversation_id: string;
  command_id: string;
  mode: string;
  owner_sequence: number;
  content: string;
  state: string;
  run_id: string | null;
  created_at: number;
}

function mapSubmission(row: SubmissionRow | undefined): SubmissionRecord | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    commandId: row.command_id,
    mode: row.mode as SubmissionRecord["mode"],
    ownerSequence: Number(row.owner_sequence),
    content: row.content,
    state: row.state as SubmissionState,
    runId: row.run_id ?? undefined,
    createdAt: Number(row.created_at),
  };
}

export class RunRepository {
  constructor(private readonly sql: SqlExecutor) {}

  insert(record: RunRecord): void {
    run(
      this.sql,
      `INSERT INTO runs (id, conversation_id, state, phase, checkpoint_json, generation, cancel_requested_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.conversationId,
      record.state,
      record.phase,
      stringifyJson(record.checkpoint),
      record.generation,
      record.cancelRequestedAt ?? null,
      record.createdAt,
      record.updatedAt,
    );
  }

  get(id: string): RunRecord | undefined {
    return mapRun(
      first<RunRow>(this.sql, `SELECT * FROM runs WHERE id = ?`, id),
    );
  }

  activeForConversation(conversationId: string): RunRecord | undefined {
    return mapRun(
      first<RunRow>(
        this.sql,
        `SELECT * FROM runs WHERE conversation_id = ? AND state IN ('queued','running','waiting_for_auth','needs_attention')
         ORDER BY created_at DESC LIMIT 1`,
        conversationId,
      ),
    );
  }

  activeRuns(): RunRecord[] {
    return all<RunRow>(
      this.sql,
      `SELECT * FROM runs WHERE state IN ('queued','running','waiting_for_auth','needs_attention') ORDER BY created_at ASC`,
    ).map((row) => mapRun(row) as RunRecord);
  }

  /** The single run that may currently execute against the shared workspace. */
  running(): RunRecord | undefined {
    return mapRun(
      first<RunRow>(
        this.sql,
        `SELECT * FROM runs WHERE state = 'running' ORDER BY updated_at ASC LIMIT 1`,
      ),
    );
  }

  update(record: RunRecord): void {
    run(
      this.sql,
      `UPDATE runs SET state = ?, phase = ?, checkpoint_json = ?, generation = ?, cancel_requested_at = ?, updated_at = ?
       WHERE id = ?`,
      record.state,
      record.phase,
      stringifyJson(record.checkpoint),
      record.generation,
      record.cancelRequestedAt ?? null,
      record.updatedAt,
      record.id,
    );
  }

  requestCancel(id: string, at: number): void {
    run(
      this.sql,
      `UPDATE runs SET cancel_requested_at = ?, updated_at = ? WHERE id = ?`,
      at,
      at,
      id,
    );
  }

  listForConversation(conversationId: string): RunRecord[] {
    return all<RunRow>(
      this.sql,
      `SELECT * FROM runs WHERE conversation_id = ? ORDER BY created_at ASC`,
      conversationId,
    ).map((row) => mapRun(row) as RunRecord);
  }

  listAll(): RunRecord[] {
    return all<RunRow>(this.sql, `SELECT * FROM runs ORDER BY created_at ASC`).map(
      (row) => mapRun(row) as RunRecord,
    );
  }

  // ADR-0001: runs are removed after their dependent attempts.
  deleteForConversation(conversationId: string): void {
    run(this.sql, `DELETE FROM runs WHERE conversation_id = ?`, conversationId);
  }
}

interface RunRow {
  id: string;
  conversation_id: string;
  state: string;
  phase: string;
  checkpoint_json: string;
  generation: number;
  cancel_requested_at: number | null;
  created_at: number;
  updated_at: number;
}

function mapRun(row: RunRow | undefined): RunRecord | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    state: row.state as RunState,
    phase: row.phase as RunPhase,
    checkpoint: parseJson<RunCheckpoint>(row.checkpoint_json, {
      phase: "prepare_context",
      turnNumber: 0,
      pendingToolCalls: [],
      nextToolIndex: 0,
    }),
    generation: Number(row.generation),
    cancelRequestedAt: row.cancel_requested_at ?? undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class AttemptRepository {
  constructor(private readonly sql: SqlExecutor) {}

  insert(record: AttemptRecord): void {
    run(
      this.sql,
      `INSERT INTO attempts (id, run_id, conversation_id, kind, state, generation, request_artifact_id, result_artifact_id,
         replay_policy, connector_id, connector_version, catalog_version, tool_name, remote_name, tool_call_id,
         parent_attempt_id, retry_eligible_at, uncertainty_json, error_code, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.runId,
      record.conversationId,
      record.kind,
      record.state,
      record.generation,
      record.requestArtifactId ?? null,
      record.resultArtifactId ?? null,
      record.replayPolicy,
      record.connectorId ?? null,
      record.connectorVersion ?? null,
      record.catalogVersion ?? null,
      record.toolName ?? null,
      record.remoteName ?? null,
      record.toolCallId ?? null,
      record.parentAttemptId ?? null,
      record.retryEligibleAt ?? null,
      record.uncertaintyJson ?? null,
      record.errorCode ?? null,
      record.errorMessage ?? null,
      record.createdAt,
      record.updatedAt,
    );
  }

  get(id: string): AttemptRecord | undefined {
    return mapAttempt(first<AttemptRow>(this.sql, `SELECT * FROM attempts WHERE id = ?`, id));
  }

  listForRun(runId: string): AttemptRecord[] {
    return all<AttemptRow>(
      this.sql,
      `SELECT * FROM attempts WHERE run_id = ? ORDER BY created_at ASC`,
      runId,
    ).map((row) => mapAttempt(row) as AttemptRecord);
  }

  listByState(states: readonly string[]): AttemptRecord[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(",");
    return all<AttemptRow>(
      this.sql,
      `SELECT * FROM attempts WHERE state IN (${placeholders}) ORDER BY created_at ASC`,
      ...states,
    ).map((row) => mapAttempt(row) as AttemptRecord);
  }

  latestForRunKind(runId: string, kind: string): AttemptRecord | undefined {
    return mapAttempt(
      first<AttemptRow>(
        this.sql,
        `SELECT * FROM attempts WHERE run_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1`,
        runId,
        kind,
      ),
    );
  }

  countForRunKind(runId: string, kind: string): number {
    return count(
      this.sql,
      `SELECT COUNT(*) AS n FROM attempts WHERE run_id = ? AND kind = ?`,
      runId,
      kind,
    );
  }

  update(record: AttemptRecord): void {
    run(
      this.sql,
      `UPDATE attempts SET state = ?, result_artifact_id = ?, uncertainty_json = ?, error_code = ?, error_message = ?, retry_eligible_at = ?, updated_at = ?
       WHERE id = ?`,
      record.state,
      record.resultArtifactId ?? null,
      record.uncertaintyJson ?? null,
      record.errorCode ?? null,
      record.errorMessage ?? null,
      record.retryEligibleAt ?? null,
      record.updatedAt,
      record.id,
    );
  }

  markState(id: string, state: string, updatedAt: number): void {
    run(this.sql, `UPDATE attempts SET state = ?, updated_at = ? WHERE id = ?`, state, updatedAt, id);
  }

  listForConversation(conversationId: string): AttemptRecord[] {
    return all<AttemptRow>(
      this.sql,
      `SELECT * FROM attempts WHERE conversation_id = ? ORDER BY created_at ASC`,
      conversationId,
    ).map((row) => mapAttempt(row) as AttemptRecord);
  }

  listAll(): AttemptRecord[] {
    return all<AttemptRow>(this.sql, `SELECT * FROM attempts ORDER BY created_at ASC`).map(
      (row) => mapAttempt(row) as AttemptRecord,
    );
  }

  // ADR-0001: attempts are removed with their conversation.
  deleteForConversation(conversationId: string): void {
    run(this.sql, `DELETE FROM attempts WHERE conversation_id = ?`, conversationId);
  }
}

interface AttemptRow {
  id: string;
  run_id: string;
  conversation_id: string;
  kind: string;
  state: string;
  generation: number;
  request_artifact_id: string | null;
  result_artifact_id: string | null;
  replay_policy: string;
  connector_id: string | null;
  connector_version: number | null;
  catalog_version: number | null;
  tool_name: string | null;
  remote_name: string | null;
  tool_call_id: string | null;
  parent_attempt_id: string | null;
  retry_eligible_at: number | null;
  uncertainty_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

function mapAttempt(row: AttemptRow | undefined): AttemptRecord | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    runId: row.run_id,
    conversationId: row.conversation_id,
    kind: row.kind as AttemptRecord["kind"],
    state: row.state as AttemptRecord["state"],
    generation: Number(row.generation),
    requestArtifactId: row.request_artifact_id ?? undefined,
    resultArtifactId: row.result_artifact_id ?? undefined,
    replayPolicy: row.replay_policy as AttemptRecord["replayPolicy"],
    connectorId: row.connector_id ?? undefined,
    connectorVersion: row.connector_version ?? undefined,
    catalogVersion: row.catalog_version ?? undefined,
    toolName: row.tool_name ?? undefined,
    remoteName: row.remote_name ?? undefined,
    toolCallId: row.tool_call_id ?? undefined,
    parentAttemptId: row.parent_attempt_id ?? undefined,
    retryEligibleAt: row.retry_eligible_at ?? undefined,
    uncertaintyJson: row.uncertainty_json ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class EntryRepository {
  constructor(private readonly sql: SqlExecutor) {}

  insert(record: EntryRecord): void {
    run(
      this.sql,
      `INSERT INTO entries (id, conversation_id, sequence, kind, attempt_id, text, artifact_id, tool_name, tool_call_id, is_error, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.conversationId,
      record.sequence,
      record.kind,
      record.attemptId ?? null,
      record.text ?? null,
      record.artifactId ?? null,
      record.toolName ?? null,
      record.toolCallId ?? null,
      boolToInt(record.isError),
      record.metadataJson ?? null,
      record.createdAt,
    );
  }

  get(id: string): EntryRecord | undefined {
    return mapEntry(first<EntryRow>(this.sql, `SELECT * FROM entries WHERE id = ?`, id));
  }

  listRange(conversationId: string, firstSequence: number, lastSequence: number): EntryRecord[] {
    return all<EntryRow>(
      this.sql,
      `SELECT * FROM entries WHERE conversation_id = ? AND sequence >= ? AND sequence <= ? ORDER BY sequence ASC`,
      conversationId,
      firstSequence,
      lastSequence,
    ).map((row) => mapEntry(row) as EntryRecord);
  }

  listRecent(conversationId: string, limit: number): EntryRecord[] {
    return all<EntryRow>(
      this.sql,
      `SELECT * FROM entries WHERE conversation_id = ? ORDER BY sequence DESC LIMIT ?`,
      conversationId,
      limit,
    )
      .map((row) => mapEntry(row) as EntryRecord)
      .reverse();
  }

  listBefore(conversationId: string, beforeSequence: number, limit: number): EntryRecord[] {
    return all<EntryRow>(
      this.sql,
      `SELECT * FROM entries WHERE conversation_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?`,
      conversationId,
      beforeSequence,
      limit,
    )
      .map((row) => mapEntry(row) as EntryRecord)
      .reverse();
  }

  last(conversationId: string): EntryRecord | undefined {
    return mapEntry(
      first<EntryRow>(
        this.sql,
        `SELECT * FROM entries WHERE conversation_id = ? ORDER BY sequence DESC LIMIT 1`,
        conversationId,
      ),
    );
  }

  updateText(id: string, text: string): void {
    run(this.sql, `UPDATE entries SET text = ? WHERE id = ?`, text, id);
  }

  listForConversation(conversationId: string): EntryRecord[] {
    return all<EntryRow>(
      this.sql,
      `SELECT * FROM entries WHERE conversation_id = ? ORDER BY sequence ASC`,
      conversationId,
    ).map((row) => mapEntry(row) as EntryRecord);
  }

  listAll(): EntryRecord[] {
    return all<EntryRow>(this.sql, `SELECT * FROM entries ORDER BY conversation_id ASC, sequence ASC`).map(
      (row) => mapEntry(row) as EntryRecord,
    );
  }

  // ADR-0001: transcript entries are removed with their conversation.
  deleteForConversation(conversationId: string): void {
    run(this.sql, `DELETE FROM entries WHERE conversation_id = ?`, conversationId);
  }
}

interface EntryRow {
  id: string;
  conversation_id: string;
  sequence: number;
  kind: string;
  attempt_id: string | null;
  text: string | null;
  artifact_id: string | null;
  tool_name: string | null;
  tool_call_id: string | null;
  is_error: number;
  metadata_json: string | null;
  created_at: number;
}

function mapEntry(row: EntryRow | undefined): EntryRecord | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sequence: Number(row.sequence),
    kind: row.kind,
    attemptId: row.attempt_id ?? undefined,
    text: row.text ?? undefined,
    artifactId: row.artifact_id ?? undefined,
    toolName: row.tool_name ?? undefined,
    toolCallId: row.tool_call_id ?? undefined,
    isError: intToBool(row.is_error),
    metadataJson: row.metadata_json ?? undefined,
    createdAt: Number(row.created_at),
  };
}

export class LiveOutputRepository {
  constructor(private readonly sql: SqlExecutor) {}

  append(attemptId: string, delta: string, at: number): number {
    void at;
    run(
      this.sql,
      `INSERT INTO live_output (attempt_id, content, output_revision) VALUES (?, ?, 1)
       ON CONFLICT (attempt_id) DO UPDATE SET content = content || excluded.content, output_revision = output_revision + 1`,
      attemptId,
      delta,
    );
    const row = first<{ output_revision: number }>(
      this.sql,
      `SELECT output_revision FROM live_output WHERE attempt_id = ?`,
      attemptId,
    );
    return Number(row?.output_revision ?? 0);
  }

  get(attemptId: string): LiveOutputRecord | undefined {
    const row = first<{ attempt_id: string; content: string; output_revision: number }>(
      this.sql,
      `SELECT attempt_id, content, output_revision FROM live_output WHERE attempt_id = ?`,
      attemptId,
    );
    if (!row) return undefined;
    return {
      attemptId: row.attempt_id,
      content: row.content,
      outputRevision: Number(row.output_revision),
    };
  }

  clear(attemptId: string): void {
    run(this.sql, `DELETE FROM live_output WHERE attempt_id = ?`, attemptId);
  }

  // ADR-0001: live output for the conversation's attempts is removed first.
  deleteForAttempts(attemptIds: readonly string[]): void {
    for (const batch of chunk(attemptIds, 500)) {
      const placeholders = batch.map(() => "?").join(",");
      run(this.sql, `DELETE FROM live_output WHERE attempt_id IN (${placeholders})`, ...batch);
    }
  }
}

export class ArtifactRepository {
  constructor(private readonly sql: SqlExecutor) {}

  create(record: ArtifactRecord): void {
    run(
      this.sql,
      `INSERT INTO artifacts (id, mime_type, encoding, byte_count, digest, complete, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.mimeType,
      record.encoding,
      record.byteCount,
      record.digest ?? null,
      boolToInt(record.complete),
      record.createdAt,
    );
  }

  get(id: string): ArtifactRecord | undefined {
    const row = first<{
      id: string;
      mime_type: string;
      encoding: string;
      byte_count: number;
      digest: string | null;
      complete: number;
      created_at: number;
    }>(this.sql, `SELECT * FROM artifacts WHERE id = ?`, id);
    if (!row) return undefined;
    return {
      id: row.id,
      mimeType: row.mime_type,
      encoding: row.encoding as "utf8" | "base64",
      byteCount: Number(row.byte_count),
      digest: row.digest ?? undefined,
      complete: intToBool(row.complete),
      createdAt: Number(row.created_at),
    };
  }

  appendChunk(artifactId: string, ordinal: number, data: string, addedBytes: number): void {
    run(
      this.sql,
      `INSERT INTO artifact_chunks (artifact_id, ordinal, data) VALUES (?, ?, ?)`,
      artifactId,
      ordinal,
      data,
    );
    run(
      this.sql,
      `UPDATE artifacts SET byte_count = byte_count + ? WHERE id = ?`,
      addedBytes,
      artifactId,
    );
  }

  readChunks(artifactId: string): { ordinal: number; data: string }[] {
    return all<{ ordinal: number; data: string }>(
      this.sql,
      `SELECT ordinal, data FROM artifact_chunks WHERE artifact_id = ? ORDER BY ordinal ASC`,
      artifactId,
    ).map((row) => ({ ordinal: Number(row.ordinal), data: row.data }));
  }

  nextOrdinal(artifactId: string): number {
    const row = first<{ n: number }>(
      this.sql,
      `SELECT COALESCE(MAX(ordinal), -1) + 1 AS n FROM artifact_chunks WHERE artifact_id = ?`,
      artifactId,
    );
    return Number(row?.n ?? 0);
  }

  complete(artifactId: string, digest: string): void {
    run(
      this.sql,
      `UPDATE artifacts SET complete = 1, digest = ? WHERE id = ?`,
      digest,
      artifactId,
    );
  }

  // ADR-0001: remove identifiable conversation-exclusive payloads and chunks.
  deleteMany(ids: readonly string[]): void {
    for (const batch of chunk(ids, 500)) {
      const placeholders = batch.map(() => "?").join(",");
      run(this.sql, `DELETE FROM artifact_chunks WHERE artifact_id IN (${placeholders})`, ...batch);
      run(this.sql, `DELETE FROM artifacts WHERE id IN (${placeholders})`, ...batch);
    }
  }
}

export class McpServerRepository {
  constructor(private readonly sql: SqlExecutor) {}

  upsert(record: McpServerRecord): void {
    run(
      this.sql,
      `INSERT INTO mcp_servers (id, name, endpoint, configuration_version, authentication_mode, role, state, enabled,
         discovery_json, header_name, trusted_origin, credential_id, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name,
         endpoint = excluded.endpoint,
         configuration_version = excluded.configuration_version,
         authentication_mode = excluded.authentication_mode,
         role = excluded.role,
         state = excluded.state,
         enabled = excluded.enabled,
         discovery_json = excluded.discovery_json,
         header_name = excluded.header_name,
         trusted_origin = excluded.trusted_origin,
         credential_id = excluded.credential_id,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
      record.id,
      record.name,
      record.endpoint,
      record.configurationVersion,
      record.authenticationMode,
      record.role ?? null,
      record.state,
      boolToInt(record.enabled),
      record.discoveryJson ?? null,
      record.headerName ?? null,
      record.trustedOrigin ?? null,
      record.credentialId ?? null,
      record.lastError ?? null,
      record.createdAt,
      record.updatedAt,
    );
  }

  get(id: string): McpServerRecord | undefined {
    return mapServer(first<McpServerRow>(this.sql, `SELECT * FROM mcp_servers WHERE id = ?`, id));
  }

  list(): McpServerRecord[] {
    return all<McpServerRow>(this.sql, `SELECT * FROM mcp_servers ORDER BY created_at ASC`).map(
      (row) => mapServer(row) as McpServerRecord,
    );
  }

  setState(id: string, state: string, lastError: string | null, updatedAt: number): void {
    run(
      this.sql,
      `UPDATE mcp_servers SET state = ?, last_error = ?, updated_at = ? WHERE id = ?`,
      state,
      lastError,
      updatedAt,
      id,
    );
  }

  setCredential(id: string, credentialId: string | null, updatedAt: number): void {
    run(
      this.sql,
      `UPDATE mcp_servers SET credential_id = ?, updated_at = ? WHERE id = ?`,
      credentialId,
      updatedAt,
      id,
    );
  }
}

interface McpServerRow {
  id: string;
  name: string;
  endpoint: string;
  configuration_version: number;
  authentication_mode: string;
  role: string | null;
  state: string;
  enabled: number;
  discovery_json: string | null;
  header_name: string | null;
  trusted_origin: string | null;
  credential_id: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function mapServer(row: McpServerRow | undefined): McpServerRecord | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    configurationVersion: Number(row.configuration_version),
    authenticationMode: row.authentication_mode as ConnectorAuthMode,
    role: (row.role as McpServerRecord["role"]) ?? undefined,
    state: row.state as McpServerRecord["state"],
    enabled: intToBool(row.enabled),
    discoveryJson: row.discovery_json ?? undefined,
    headerName: row.header_name ?? undefined,
    trustedOrigin: row.trusted_origin ?? undefined,
    credentialId: row.credential_id ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class McpToolRepository {
  constructor(private readonly sql: SqlExecutor) {}

  replaceForVersion(connectorId: string, catalogVersion: number, tools: McpToolRecord[]): void {
    run(
      this.sql,
      `DELETE FROM mcp_tools WHERE connector_id = ? AND catalog_version = ?`,
      connectorId,
      catalogVersion,
    );
    for (const tool of tools) {
      run(
        this.sql,
        `INSERT INTO mcp_tools (connector_id, tool_name, catalog_version, alias, description, input_schema_json, output_schema_json, annotations_json, available)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        tool.connectorId,
        tool.toolName,
        tool.catalogVersion,
        tool.alias,
        tool.description,
        tool.inputSchemaJson,
        tool.outputSchemaJson ?? null,
        tool.annotationsJson ?? null,
        boolToInt(tool.available),
      );
    }
  }

  listLatest(connectorId: string): McpToolRecord[] {
    const version = this.latestVersion(connectorId);
    if (version === undefined) return [];
    return all<McpToolRow>(
      this.sql,
      `SELECT * FROM mcp_tools WHERE connector_id = ? AND catalog_version = ? ORDER BY alias ASC`,
      connectorId,
      version,
    ).map((row) => mapTool(row) as McpToolRecord);
  }

  latestVersion(connectorId: string): number | undefined {
    const row = first<{ n: number | null }>(
      this.sql,
      `SELECT MAX(catalog_version) AS n FROM mcp_tools WHERE connector_id = ?`,
      connectorId,
    );
    return row?.n === null || row?.n === undefined ? undefined : Number(row.n);
  }

  findByAlias(alias: string): McpToolRecord | undefined {
    return mapTool(
      first<McpToolRow>(
        this.sql,
        `SELECT * FROM mcp_tools WHERE alias = ? ORDER BY catalog_version DESC LIMIT 1`,
        alias,
      ),
    );
  }

  listAllAliases(): McpToolRecord[] {
    return all<McpToolRow>(
      this.sql,
      `SELECT * FROM mcp_tools ORDER BY connector_id, alias`,
    ).map((row) => mapTool(row) as McpToolRecord);
  }
}

interface McpToolRow {
  connector_id: string;
  tool_name: string;
  catalog_version: number;
  alias: string;
  description: string;
  input_schema_json: string;
  output_schema_json: string | null;
  annotations_json: string | null;
  available: number;
}

function mapTool(row: McpToolRow | undefined): McpToolRecord | undefined {
  if (!row) return undefined;
  return {
    connectorId: row.connector_id,
    toolName: row.tool_name,
    catalogVersion: Number(row.catalog_version),
    alias: row.alias,
    description: row.description,
    inputSchemaJson: row.input_schema_json,
    outputSchemaJson: row.output_schema_json ?? undefined,
    annotationsJson: row.annotations_json ?? undefined,
    available: intToBool(row.available),
  };
}

export class CredentialRepository {
  constructor(private readonly sql: SqlExecutor) {}

  upsert(record: CredentialRecord): void {
    run(
      this.sql,
      `INSERT INTO credentials (id, kind, connector_id, owner_key, value, expires_at, version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at,
         version = excluded.version, created_at = excluded.created_at`,
      record.id,
      record.kind,
      record.connectorId ?? null,
      record.ownerKey ?? null,
      record.value,
      record.expiresAt ?? null,
      record.version,
      record.createdAt,
    );
  }

  get(id: string): CredentialRecord | undefined {
    return mapCredential(
      first<CredentialRow>(this.sql, `SELECT * FROM credentials WHERE id = ?`, id),
    );
  }

  findForConnector(connectorId: string): CredentialRecord | undefined {
    return mapCredential(
      first<CredentialRow>(
        this.sql,
        `SELECT * FROM credentials WHERE connector_id = ? ORDER BY version DESC LIMIT 1`,
        connectorId,
      ),
    );
  }

  delete(id: string): void {
    run(this.sql, `DELETE FROM credentials WHERE id = ?`, id);
  }
}

interface CredentialRow {
  id: string;
  kind: string;
  connector_id: string | null;
  owner_key: string | null;
  value: string;
  expires_at: number | null;
  version: number;
  created_at: number;
}

function mapCredential(row: CredentialRow | undefined): CredentialRecord | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    kind: row.kind as CredentialRecord["kind"],
    connectorId: row.connector_id ?? undefined,
    ownerKey: row.owner_key ?? undefined,
    value: row.value,
    expiresAt: row.expires_at ?? undefined,
    version: Number(row.version),
    createdAt: Number(row.created_at),
  };
}

export class OAuthTransactionRepository {
  constructor(private readonly sql: SqlExecutor) {}

  insert(record: OAuthTransactionRecord): void {
    run(
      this.sql,
      `INSERT INTO oauth_transactions (id, state_digest, connector_id, owner_key, pkce_verifier, issuer, redirect_uri, expires_at, exchange_state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.stateDigest,
      record.connectorId,
      record.ownerKey,
      record.pkceVerifier,
      record.issuer,
      record.redirectUri,
      record.expiresAt,
      record.exchangeState,
      record.createdAt,
    );
  }

  findByStateDigest(stateDigest: string): OAuthTransactionRecord | undefined {
    return mapOAuth(
      first<OAuthRow>(
        this.sql,
        `SELECT * FROM oauth_transactions WHERE state_digest = ?`,
        stateDigest,
      ),
    );
  }

  setExchangeState(id: string, state: string): void {
    run(this.sql, `UPDATE oauth_transactions SET exchange_state = ? WHERE id = ?`, state, id);
  }

  delete(id: string): void {
    run(this.sql, `DELETE FROM oauth_transactions WHERE id = ?`, id);
  }
}

interface OAuthRow {
  id: string;
  state_digest: string;
  connector_id: string;
  owner_key: string;
  pkce_verifier: string;
  issuer: string;
  redirect_uri: string;
  expires_at: number;
  exchange_state: string;
  created_at: number;
}

function mapOAuth(row: OAuthRow | undefined): OAuthTransactionRecord | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    stateDigest: row.state_digest,
    connectorId: row.connector_id,
    ownerKey: row.owner_key,
    pkceVerifier: row.pkce_verifier,
    issuer: row.issuer,
    redirectUri: row.redirect_uri,
    expiresAt: Number(row.expires_at),
    exchangeState: row.exchange_state,
    createdAt: Number(row.created_at),
  };
}

export class SkillRepository {
  constructor(private readonly sql: SqlExecutor) {}

  upsertSkill(record: SkillRecord): void {
    run(
      this.sql,
      `INSERT INTO skills (id, name, description, enabled, deleted, current_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description,
         enabled = excluded.enabled, deleted = excluded.deleted, current_version = excluded.current_version,
         updated_at = excluded.updated_at`,
      record.id,
      record.name,
      record.description,
      boolToInt(record.enabled),
      boolToInt(record.deleted),
      record.currentVersion,
      record.createdAt,
      record.updatedAt,
    );
  }

  get(id: string): SkillRecord | undefined {
    return mapSkill(first<SkillRow>(this.sql, `SELECT * FROM skills WHERE id = ?`, id));
  }

  list(includeDeleted = false): SkillRecord[] {
    const query = includeDeleted
      ? `SELECT * FROM skills ORDER BY created_at ASC`
      : `SELECT * FROM skills WHERE deleted = 0 ORDER BY created_at ASC`;
    return all<SkillRow>(this.sql, query).map((row) => mapSkill(row) as SkillRecord);
  }

  insertVersion(record: SkillVersionRecord): void {
    run(
      this.sql,
      `INSERT INTO skill_versions (skill_id, version, name, description, instructions, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      record.skillId,
      record.version,
      record.name,
      record.description,
      record.instructions,
      record.createdAt,
    );
  }

  getVersion(skillId: string, version: number): SkillVersionRecord | undefined {
    return mapSkillVersion(
      first<SkillVersionRow>(
        this.sql,
        `SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?`,
        skillId,
        version,
      ),
    );
  }

  insertResource(record: SkillResourceRecord): void {
    run(
      this.sql,
      `INSERT INTO skill_resources (skill_id, version, path, media_type, artifact_id)
       VALUES (?, ?, ?, ?, ?)`,
      record.skillId,
      record.version,
      record.path,
      record.mediaType,
      record.artifactId,
    );
  }

  listResources(skillId: string, version: number): SkillResourceRecord[] {
    return all<{
      skill_id: string;
      version: number;
      path: string;
      media_type: string;
      artifact_id: string;
    }>(
      this.sql,
      `SELECT * FROM skill_resources WHERE skill_id = ? AND version = ? ORDER BY path ASC`,
      skillId,
      version,
    ).map((row) => ({
      skillId: row.skill_id,
      version: Number(row.version),
      path: row.path,
      mediaType: row.media_type,
      artifactId: row.artifact_id,
    }));
  }

  getResource(skillId: string, version: number, path: string): SkillResourceRecord | undefined {
    const row = first<{
      skill_id: string;
      version: number;
      path: string;
      media_type: string;
      artifact_id: string;
    }>(
      this.sql,
      `SELECT * FROM skill_resources WHERE skill_id = ? AND version = ? AND path = ?`,
      skillId,
      version,
      path,
    );
    if (!row) return undefined;
    return {
      skillId: row.skill_id,
      version: Number(row.version),
      path: row.path,
      mediaType: row.media_type,
      artifactId: row.artifact_id,
    };
  }

  listAllResources(): SkillResourceRecord[] {
    return all<{
      skill_id: string;
      version: number;
      path: string;
      media_type: string;
      artifact_id: string;
    }>(this.sql, `SELECT * FROM skill_resources ORDER BY skill_id ASC, version ASC, path ASC`).map(
      (row) => ({
        skillId: row.skill_id,
        version: Number(row.version),
        path: row.path,
        mediaType: row.media_type,
        artifactId: row.artifact_id,
      }),
    );
  }

  selectForConversation(conversationId: string, skillIds: readonly string[]): void {
    run(this.sql, `DELETE FROM conversation_skills WHERE conversation_id = ?`, conversationId);
    for (const skillId of skillIds) {
      run(
        this.sql,
        `INSERT INTO conversation_skills (conversation_id, skill_id, follow_current) VALUES (?, ?, 1)`,
        conversationId,
        skillId,
      );
    }
  }

  selectedForConversation(conversationId: string): ConversationSkillRecord[] {
    return all<{ conversation_id: string; skill_id: string; follow_current: number }>(
      this.sql,
      `SELECT * FROM conversation_skills WHERE conversation_id = ? ORDER BY skill_id ASC`,
      conversationId,
    ).map((row) => ({
      conversationId: row.conversation_id,
      skillId: row.skill_id,
      followCurrent: intToBool(row.follow_current),
    }));
  }
}

interface SkillRow {
  id: string;
  name: string;
  description: string;
  enabled: number;
  deleted: number;
  current_version: number;
  created_at: number;
  updated_at: number;
}

function mapSkill(row: SkillRow | undefined): SkillRecord | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: intToBool(row.enabled),
    deleted: intToBool(row.deleted),
    currentVersion: Number(row.current_version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

interface SkillVersionRow {
  skill_id: string;
  version: number;
  name: string;
  description: string;
  instructions: string;
  created_at: number;
}

function mapSkillVersion(row: SkillVersionRow | undefined): SkillVersionRecord | undefined {
  if (!row) return undefined;
  return {
    skillId: row.skill_id,
    version: Number(row.version),
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    createdAt: Number(row.created_at),
  };
}

export class ContextSnapshotRepository {
  constructor(private readonly sql: SqlExecutor) {}

  insert(record: ContextSnapshotRecord): void {
    run(
      this.sql,
      `INSERT INTO context_snapshots (id, conversation_id, run_id, turn_number, model_profile_json, skill_versions_json,
         tool_catalog_json, system_sections_json, history_first, history_last, summary_entry_id, digest, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.conversationId,
      record.runId,
      record.turnNumber,
      record.modelProfileJson,
      record.skillVersionsJson,
      record.toolCatalogJson,
      record.systemSectionsJson,
      record.historyFirst,
      record.historyLast,
      record.summaryEntryId ?? null,
      record.digest,
      record.createdAt,
    );
  }

  get(id: string): ContextSnapshotRecord | undefined {
    const row = first<ContextSnapshotRow>(
      this.sql,
      `SELECT * FROM context_snapshots WHERE id = ?`,
      id,
    );
    if (!row) return undefined;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      runId: row.run_id,
      turnNumber: Number(row.turn_number),
      modelProfileJson: row.model_profile_json,
      skillVersionsJson: row.skill_versions_json,
      toolCatalogJson: row.tool_catalog_json,
      systemSectionsJson: row.system_sections_json,
      historyFirst: Number(row.history_first),
      historyLast: Number(row.history_last),
      summaryEntryId: row.summary_entry_id ?? undefined,
      digest: row.digest,
      createdAt: Number(row.created_at),
    };
  }

  // ADR-0001: context snapshots are conversation-owned and removed with it.
  deleteForConversation(conversationId: string): void {
    run(this.sql, `DELETE FROM context_snapshots WHERE conversation_id = ?`, conversationId);
  }
}

interface ContextSnapshotRow {
  id: string;
  conversation_id: string;
  run_id: string;
  turn_number: number;
  model_profile_json: string;
  skill_versions_json: string;
  tool_catalog_json: string;
  system_sections_json: string;
  history_first: number;
  history_last: number;
  summary_entry_id: string | null;
  digest: string;
  created_at: number;
}

export class AttemptResolutionRepository {
  constructor(private readonly sql: SqlExecutor) {}

  insert(record: AttemptResolutionRecord): void {
    run(
      this.sql,
      `INSERT INTO attempt_resolutions (id, attempt_id, action, explanation, evidence_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      record.id,
      record.attemptId,
      record.action,
      record.explanation,
      record.evidenceJson,
      record.createdAt,
    );
  }

  listForAttempt(attemptId: string): AttemptResolutionRecord[] {
    return all<{
      id: string;
      attempt_id: string;
      action: string;
      explanation: string;
      evidence_json: string;
      created_at: number;
    }>(
      this.sql,
      `SELECT * FROM attempt_resolutions WHERE attempt_id = ? ORDER BY created_at ASC`,
      attemptId,
    ).map((row) => ({
      id: row.id,
      attemptId: row.attempt_id,
      action: row.action,
      explanation: row.explanation,
      evidenceJson: row.evidence_json,
      createdAt: Number(row.created_at),
    }));
  }

  listAll(): AttemptResolutionRecord[] {
    return all<{
      id: string;
      attempt_id: string;
      action: string;
      explanation: string;
      evidence_json: string;
      created_at: number;
    }>(this.sql, `SELECT * FROM attempt_resolutions ORDER BY created_at ASC`).map((row) => ({
      id: row.id,
      attemptId: row.attempt_id,
      action: row.action,
      explanation: row.explanation,
      evidenceJson: row.evidence_json,
      createdAt: Number(row.created_at),
    }));
  }

  // ADR-0001: resolutions of the conversation's attempts are removed with it.
  deleteForAttempts(attemptIds: readonly string[]): void {
    for (const batch of chunk(attemptIds, 500)) {
      const placeholders = batch.map(() => "?").join(",");
      run(
        this.sql,
        `DELETE FROM attempt_resolutions WHERE attempt_id IN (${placeholders})`,
        ...batch,
      );
    }
  }
}

export type { SqlValue };

export class RepositoryInstructionRepository {
  constructor(private readonly sql: SqlExecutor) {}

  upsert(record: RepositoryInstructionRecord): void {
    run(
      this.sql,
      `INSERT INTO repository_instructions (id, workspace_root, path, directory, artifact_id, digest, present, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_root, path) DO UPDATE SET
         artifact_id = excluded.artifact_id,
         digest = excluded.digest,
         present = excluded.present,
         fetched_at = excluded.fetched_at`,
      record.id,
      record.workspaceRoot,
      record.path,
      record.directory,
      record.artifactId,
      record.digest,
      boolToInt(record.present),
      record.fetchedAt,
    );
  }

  get(workspaceRoot: string, path: string): RepositoryInstructionRecord | undefined {
    return mapRepositoryInstruction(
      first<RepositoryInstructionRow>(
        this.sql,
        `SELECT * FROM repository_instructions WHERE workspace_root = ? AND path = ?`,
        workspaceRoot,
        path,
      ),
    );
  }

  list(workspaceRoot: string): RepositoryInstructionRecord[] {
    return all<RepositoryInstructionRow>(
      this.sql,
      `SELECT * FROM repository_instructions WHERE workspace_root = ? ORDER BY path ASC`,
      workspaceRoot,
    ).map((row) => mapRepositoryInstruction(row) as RepositoryInstructionRecord);
  }

  listAll(): RepositoryInstructionRecord[] {
    return all<RepositoryInstructionRow>(
      this.sql,
      `SELECT * FROM repository_instructions ORDER BY workspace_root ASC, path ASC`,
    ).map((row) => mapRepositoryInstruction(row) as RepositoryInstructionRecord);
  }
}

interface RepositoryInstructionRow {
  id: string;
  workspace_root: string;
  path: string;
  directory: string;
  artifact_id: string;
  digest: string;
  present: number;
  fetched_at: number;
}

function mapRepositoryInstruction(
  row: RepositoryInstructionRow | undefined,
): RepositoryInstructionRecord | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    workspaceRoot: row.workspace_root,
    path: row.path,
    directory: row.directory,
    artifactId: row.artifact_id,
    digest: row.digest,
    present: intToBool(row.present),
    fetchedAt: Number(row.fetched_at),
  };
}

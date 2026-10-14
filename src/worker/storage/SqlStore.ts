// The one transactional boundary (PLAN.md -> Persistence and scheduling).
// `transaction` uses a synchronous SQLite transaction; its callback must not
// return a promise.

import type { ConfigurationStatusView, ConversationId, OwnerSnapshot } from "../../shared/domain";
import type { ViewChange } from "../../shared/wire";
import { parseJson } from "./Sql";
import type { StorageBackend } from "./Sql";
import {
  ArtifactRepository,
  AttemptRepository,
  AttemptResolutionRepository,
  CommandReceiptRepository,
  ContextSnapshotRepository,
  ConversationRepository,
  CredentialRepository,
  EntryRepository,
  LiveOutputRepository,
  McpServerRepository,
  McpToolRepository,
  OAuthTransactionRepository,
  OwnerStateRepository,
  RepositoryInstructionRepository,
  RunRepository,
  SettingsRepository,
  SkillRepository,
  SubmissionRepository,
} from "./repositories";
import { SCHEMA_STATEMENTS, SCHEMA_VERSION } from "./schema";
import {
  projectAttempt,
  projectConversation,
  projectEntry,
  projectRun,
  projectSubmission,
} from "./projections";
import type { ModelProfile } from "../types";

export interface StoreTransaction {
  readonly ownerState: OwnerStateRepository;
  readonly commands: CommandReceiptRepository;
  readonly settings: SettingsRepository;
  readonly conversations: ConversationRepository;
  readonly submissions: SubmissionRepository;
  readonly runs: RunRepository;
  readonly attempts: AttemptRepository;
  readonly entries: EntryRepository;
  readonly liveOutput: LiveOutputRepository;
  readonly artifacts: ArtifactRepository;
  readonly mcpServers: McpServerRepository;
  readonly mcpTools: McpToolRepository;
  readonly credentials: CredentialRepository;
  readonly oauthTransactions: OAuthTransactionRepository;
  readonly skills: SkillRepository;
  readonly contextSnapshots: ContextSnapshotRepository;
  readonly attemptResolutions: AttemptResolutionRepository;
  readonly repositoryInstructions: RepositoryInstructionRepository;
  /** View changes emitted during this transaction. */
  readonly changes: ViewChange[];
}

export interface Commit<T> {
  value: T;
  revision: number;
  changes: ViewChange[];
}


/**
 * The owner-visible configuration projection. Extracted so that configuration
 * commands and connector connects can publish a live `configuration.update`
 * frame instead of waiting for the next full snapshot.
 */
export function buildConfiguration(tx: StoreTransaction): ConfigurationStatusView {
  const settings = tx.settings.read();
  const modelProfile = parseJson<ModelProfile | undefined>(settings.modelProfileJson, undefined);
  const connectors = tx.mcpServers.list().map((record) => ({
    id: record.id,
    name: record.name,
    endpoint: record.endpoint,
    authMode: record.authenticationMode,
    role: record.role,
    state: record.state,
    version: record.configurationVersion,
    toolCount: tx.mcpTools.listLatest(record.id).length,
    lastError: record.lastError,
  }));
  const skills = tx.skills.list().map((record) => ({
    id: record.id,
    name: record.name,
    description: record.description,
    enabled: record.enabled,
    deleted: record.deleted,
    currentVersion: record.currentVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }));
  const configuration: ConfigurationStatusView = {
    connectors,
    skills,
    settingsVersion: settings.settingsVersion,
    missing: [],
  };
  if (modelProfile) configuration.model = modelProfile;
  if (settings.workspaceRoot) configuration.workspaceRoot = settings.workspaceRoot;
  return configuration;
}

export class SqlStore {
  constructor(private readonly backend: StorageBackend) {}

  migrate(): void {
    this.backend.transactionSync(() => {
      for (const statement of SCHEMA_STATEMENTS) this.backend.sql.exec(statement);
      const ownerState = new OwnerStateRepository(this.backend.sql);
      const settings = new SettingsRepository(this.backend.sql);
      ownerState.ensure();
      settings.ensure();
      const current = ownerState.read();
      if (current.schemaVersion !== SCHEMA_VERSION) {
        ownerState.setSchemaVersion(SCHEMA_VERSION);
      }
    });
  }

  /** Read-only access without allocating a revision. */
  read<T>(operation: (tx: StoreTransaction) => T): T {
    return this.backend.transactionSync(() => operation(this.buildTransaction()));
  }

  transaction<T>(operation: (tx: StoreTransaction) => T): Commit<T> {
    return this.backend.transactionSync(() => {
      const tx = this.buildTransaction();
      // Allocate the revision before the operation so handlers can write
      // revision-stamped receipts (e.g. command receipts) atomically.
      const revision = tx.ownerState.bumpRevision();
      const value = operation(tx);
      return { value, revision, changes: tx.changes };
    });
  }

  readRevision(): number {
    return this.read((tx) => tx.ownerState.read().revision);
  }

  readSnapshot(conversationId?: ConversationId): OwnerSnapshot {
    return this.read((tx) => buildSnapshot(tx, conversationId));
  }

  private buildTransaction(): StoreTransaction {
    const sql = this.backend.sql;
    return {
      ownerState: new OwnerStateRepository(sql),
      commands: new CommandReceiptRepository(sql),
      settings: new SettingsRepository(sql),
      conversations: new ConversationRepository(sql),
      submissions: new SubmissionRepository(sql),
      runs: new RunRepository(sql),
      attempts: new AttemptRepository(sql),
      entries: new EntryRepository(sql),
      liveOutput: new LiveOutputRepository(sql),
      artifacts: new ArtifactRepository(sql),
      mcpServers: new McpServerRepository(sql),
      mcpTools: new McpToolRepository(sql),
      credentials: new CredentialRepository(sql),
      oauthTransactions: new OAuthTransactionRepository(sql),
      skills: new SkillRepository(sql),
      contextSnapshots: new ContextSnapshotRepository(sql),
      attemptResolutions: new AttemptResolutionRepository(sql),
      repositoryInstructions: new RepositoryInstructionRepository(sql),
      changes: [],
    };
  }
}

export function buildSnapshot(tx: StoreTransaction, conversationId?: ConversationId): OwnerSnapshot {
  const revision = tx.ownerState.read().revision;
  const conversations = tx.conversations.list().map((record) => {
    const activeRun = tx.runs.activeForConversation(record.id);
    const lastEntry = tx.entries.last(record.id);
    const queuedCount = tx.submissions.listQueuedForConversation(record.id).length;
    const summary = {
      ...projectConversation(record),
      queuedCount,
    } as OwnerSnapshot["conversations"][number];
    if (activeRun) summary.activeRunState = activeRun.state;
    if (lastEntry?.text) summary.lastEntryPreview = lastEntry.text.slice(0, 120);
    return summary;
  });

  const snapshot: OwnerSnapshot = {
    revision,
    conversations,
    configuration: buildConfiguration(tx),
  };

  if (conversationId) {
    const conversation = tx.conversations.get(conversationId);
    if (conversation) {
      const entries = tx.entries.listRecent(conversationId, 100);
      const activeRun = tx.runs.activeForConversation(conversationId);
      const activeAttempt = activeRun
        ? tx.attempts.listForRun(activeRun.id).find((a) => a.state === "dispatched" || a.state === "prepared")
        : undefined;
      const queuedInputs = tx.submissions.listQueuedForConversation(conversationId);
      const steering = activeRun ? tx.submissions.listSteeringForRun(activeRun.id) : [];
      const conversationSnapshot = {
        conversation: projectConversation(conversation),
        entries: entries.map((entry) => {
          const live = entry.attemptId ? tx.liveOutput.get(entry.attemptId) : undefined;
          const text = entry.text ?? live?.content;
          const projected = projectEntry({ ...entry, text }, live !== undefined && entry.text === undefined);
          return projected;
        }),
        queuedInputs: [...queuedInputs, ...steering].map(projectSubmission),
        selectedSkillIds: tx.skills.selectedForConversation(conversationId).map((record) => record.skillId),
      } as NonNullable<OwnerSnapshot["selectedConversation"]>;
      if (entries.length > 0) {
        const firstSeq = entries[0]?.sequence ?? 1;
        conversationSnapshot.olderEntriesCursor = String(firstSeq);
      }
      if (activeRun) conversationSnapshot.activeRun = projectRun(activeRun);
      if (activeAttempt) conversationSnapshot.activeAttempt = projectAttempt(activeAttempt);
      snapshot.selectedConversation = conversationSnapshot;
    }
  }

  return snapshot;
}

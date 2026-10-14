// Owner-scoped runtime wiring. One `OwnerRuntime` owns all durable state and
// execution for one verified owner (PLAN.md -> One authoritative state owner).

import {
  AppError,
  type CommandEnvelope,
  type CommandReceipt,
  type ConversationId,
  type OwnerSnapshot,
  type RunId,
} from "../../shared/domain";
import type {
  CreateConversationInput,
  CreateSkillInput,
  DeleteConversationInput,
  RenameConversationInput,
  ResolveAttemptCommandInput,
  SaveConnectorInput,
  SaveModelProfileInput,
  SelectConversationSkillsInput,
  SetConnectorEnabledInput,
  SkillIdInput,
  SubmitInput,
  UpdateSkillInput,
  WithdrawSubmissionInput,
} from "../../shared/commands";
import type { Commit, SqlStore, StoreTransaction } from "../storage/SqlStore";
import type { StorageBackend } from "../storage/Sql";
import type { SqlExecutor } from "../storage/Sql";
import { SqlStore as SqlStoreClass, buildConfiguration } from "../storage/SqlStore";
import { projectEntry } from "../storage/projections";
import { ConversationService, RunControlService, SubmissionService, type ConversationDeletion, type ServiceOutcome } from "../conversations/services";
import { SettingsService } from "../settings/SettingsService";
import { SkillRegistry } from "../skills/SkillRegistry";
import { ConnectorService } from "../mcp/ConnectorService";
import { ToolCatalog } from "../mcp/ToolCatalog";
import type { ConnectionReport, ToolDescriptor, ToolExecutor } from "../mcp/types";
import { ContextAssembler } from "../context/ContextAssembler";
import { ContextBudget, CompactionPlanner } from "../context/ContextBudget";
import type { ModelGateway } from "../models/types";
import { createMcpStack, listAllTools, type McpStack } from "../mcp/stack";
import { AttemptExecutor } from "../runtime/AttemptExecutor";
import { OutputCommitter } from "../runtime/OutputCommitter";
import { RunDriver } from "../runtime/RunDriver";
import { RunMachine } from "../runtime/RunMachine";
import { RecoveryService, type RecoverySummary } from "../runtime/RecoveryService";
import { TransitionCoordinator } from "../runtime/TransitionCoordinator";
import { WakeScheduler, type AlarmStore } from "../runtime/WakeScheduler";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../runtime/limits";
import { cryptoIdGenerator, systemClock, type Clock, type IdGenerator } from "../runtime/Clock";
import { CommandProcessor, type CommandProcessOptions } from "../rpc/CommandProcessor";
import { SyncHub, type SyncSocket } from "../sync/SyncHub";

/** Commands whose result must be pushed to connected clients as a live
 * `configuration.update` frame. */
const CONFIGURATION_COMMANDS = new Set([
  "settings.save_model_profile",
  "connector.save",
  "connector.set_enabled",
  "skill.create",
  "skill.update",
  "skill.disable",
  "skill.remove",
]);

export interface OwnerRuntimeDeps {
  backend: StorageBackend;
  alarms: AlarmStore;
  model: ModelGateway;
  tools?: ToolExecutor | ((store: SqlStore) => ToolExecutor);
  clock?: Clock;
  ids?: IdGenerator;
  limits?: RuntimeLimits;
  baseInstructions?: string;
  oauthClientMetadataUrl?: string;
  oauthCallbackUrl?: string;
  connectConnector?: (connectorId: string) => Promise<ConnectionReport>;
}

export class OwnerRuntime {
  readonly store: SqlStore;
  readonly sync: SyncHub;
  readonly driver: RunDriver;
  readonly recovery: RecoveryService;
  private readonly coordinator = new TransitionCoordinator();
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly limits: RuntimeLimits;
  private readonly conversations: ConversationService;
  private readonly submissions: SubmissionService;
  private readonly runControl: RunControlService;
  private readonly settings: SettingsService;
  private readonly skills: SkillRegistry;
  private readonly connectors: ConnectorService;
  private readonly catalog: ToolCatalog;
  private readonly processor: CommandProcessor;
  private readonly tools: ToolExecutor;
  private readonly mcp: McpStack;
  private started = false;

  constructor(private readonly deps: OwnerRuntimeDeps) {
    this.clock = deps.clock ?? systemClock;
    this.ids = deps.ids ?? cryptoIdGenerator;
    this.limits = deps.limits ?? DEFAULT_RUNTIME_LIMITS;

    this.store = new SqlStoreClass(deps.backend);
    this.store.migrate();

    const serviceDeps = { now: () => this.clock.now(), newId: () => this.ids.next() };
    this.conversations = new ConversationService(serviceDeps);
    this.submissions = new SubmissionService(serviceDeps);
    this.runControl = new RunControlService(serviceDeps);
    this.settings = new SettingsService(serviceDeps);
    this.skills = new SkillRegistry(serviceDeps);
    this.connectors = new ConnectorService(serviceDeps);
    this.catalog = new ToolCatalog(serviceDeps);

    this.sync = new SyncHub((conversationId) => this.store.readSnapshot(conversationId));

    this.mcp = createMcpStack({
      store: this.store,
      clock: this.clock,
      ids: this.ids,
      clientMetadataUrl: deps.oauthClientMetadataUrl ?? "",
      callbackUrl: deps.oauthCallbackUrl ?? "",
    });
    this.tools =
      typeof deps.tools === "function"
        ? deps.tools(this.store)
        : (deps.tools ?? this.mcp.router);

    const committer = new OutputCommitter(this.store, this.clock, this.limits.outputFlushIntervalMs, () => {
      /* streaming updates are reflected by the next committed frame */
    });
    const assembler = new ContextAssembler({
      clock: this.clock,
      ids: this.ids,
      budget: new ContextBudget(),
      compaction: new CompactionPlanner(),
      listTools: (tx) => this.catalog.snapshot(tx),
      baseInstructions: deps.baseInstructions,
    });
    const executor = new AttemptExecutor(deps.model, this.tools, committer);
    const wake = new WakeScheduler(deps.alarms);

    this.driver = new RunDriver({
      store: this.store,
      clock: this.clock,
      ids: this.ids,
      machine: new RunMachine(),
      context: assembler,
      executor,
      tools: this.tools,
      committer,
      wake,
      limits: this.limits,
      publish: (commit) => this.sync.publish(commit),
    });

    this.recovery = new RecoveryService({
      store: this.store,
      clock: this.clock,
      ids: this.ids,
      limits: this.limits,
      publish: (commit) => this.sync.publish(commit),
    });

    this.processor = new CommandProcessor({
      store: this.store,
      coordinator: this.coordinator,
      wake,
      clock: this.clock,
      publish: (commit) => this.sync.publish(commit),
    });
  }

  /** Runs once per object generation. */
  start(): RecoverySummary {
    if (this.started) {
      return { recovered: 0, retried: 0, unknown: 0, cancelled: 0 };
    }
    this.started = true;
    const generation = this.store.transaction((tx) => tx.ownerState.bumpDriverGeneration());
    return this.recovery.recoverPreviousGeneration(generation.value);
  }

  async alarm(): Promise<void> {
    await this.driver.driveSlice();
  }

  signalCancellation(runId: RunId): void {
    this.driver.signalCancellation(runId);
  }

  /** Persist the latest usable delegated Access assertion (private state). */
  updateAccessAssertion(assertion: string, expiresAt: number, owner: string): void {
    this.store.transaction((tx) => {
      tx.credentials.upsert({
        id: "access:owner",
        kind: "access",
        ownerKey: owner,
        value: assertion,
        expiresAt,
        version: 1,
        createdAt: this.clock.now(),
      });
    });
  }

  readAccessAssertion(): { value: string; expiresAt?: number } | undefined {
    return this.store.read((tx) => {
      const record = tx.credentials.get("access:owner");
      if (!record) return undefined;
      return { value: record.value, expiresAt: record.expiresAt };
    });
  }

  attachSocket(key: object, socket: SyncSocket, selection?: ConversationId, authExpiresAt?: number): OwnerSnapshot {
    return this.sync.attach(key, socket, selection, authExpiresAt);
  }

  detachSocket(key: object): void {
    this.sync.detach(key);
  }

  resnapshot(key: object): void {
    this.sync.resnapshot(key);
  }

  /** True when a tool attempt has been dispatched but not settled. */
  hasDispatchedAttempt(): boolean {
    return this.store.read((tx) => tx.attempts.listByState(["dispatched"]).length > 0);
  }

  async dispatch(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "createConversation":
        return this.command("conversation.create", args[0] as CommandEnvelope<CreateConversationInput>, (tx, p) =>
          this.conversations.create(tx, p as CreateConversationInput),
        );
      case "renameConversation":
        return this.command("conversation.rename", args[0] as CommandEnvelope<RenameConversationInput>, (tx, p) =>
          this.conversations.rename(tx, p as RenameConversationInput),
        );
      case "deleteConversation":
        return this.deleteConversation(args[0] as CommandEnvelope<DeleteConversationInput>);
      case "submit":
        return this.command("submission.submit", args[0] as CommandEnvelope<SubmitInput>, (tx, p) =>
          this.submissions.submit(tx, p as SubmitInput),
        );
      case "withdrawSubmission":
        return this.command(
          "submission.withdraw",
          args[0] as CommandEnvelope<WithdrawSubmissionInput>,
          (tx, p) => this.submissions.withdraw(tx, p as WithdrawSubmissionInput),
        );
      case "cancelRun":
        return this.command(
          "run.cancel",
          args[0] as CommandEnvelope<{ runId: RunId }>,
          (tx, p) => {
            const result = this.runControl.cancel(tx, (p as { runId: RunId }).runId);
            this.signalCancellation((p as { runId: RunId }).runId);
            return result;
          },
        );
      case "resumeRun":
        return this.command(
          "run.resume",
          args[0] as CommandEnvelope<{ runId: RunId }>,
          (tx, p) => this.runControl.resume(tx, (p as { runId: RunId }).runId),
        );
      case "resolveAttempt":
        return this.command(
          "run.resolve_attempt",
          args[0] as CommandEnvelope<ResolveAttemptCommandInput>,
          (tx, p) => this.runControl.resolveAttempt(tx, p as ResolveAttemptCommandInput),
        );
      case "saveModelProfile":
        return this.command(
          "settings.save_model_profile",
          args[0] as CommandEnvelope<SaveModelProfileInput>,
          (tx, p) => this.settings.saveModelProfile(tx, p as SaveModelProfileInput),
        );
      case "saveConnector":
        return this.command(
          "connector.save",
          args[0] as CommandEnvelope<SaveConnectorInput>,
          (tx, p) => this.connectors.save(tx, p as SaveConnectorInput),
        );
      case "setConnectorEnabled":
        return this.command(
          "connector.set_enabled",
          args[0] as CommandEnvelope<SetConnectorEnabledInput>,
          (tx, p) => this.connectors.setEnabled(tx, p as SetConnectorEnabledInput),
        );
      case "createSkill":
        return this.command("skill.create", args[0] as CommandEnvelope<CreateSkillInput>, (tx, p) =>
          this.skills.create(tx, p as CreateSkillInput),
        );
      case "updateSkill":
        return this.command("skill.update", args[0] as CommandEnvelope<UpdateSkillInput>, (tx, p) =>
          this.skills.update(tx, p as UpdateSkillInput),
        );
      case "disableSkill":
        return this.command("skill.disable", args[0] as CommandEnvelope<SkillIdInput>, (tx, p) =>
          this.skills.disable(tx, (p as SkillIdInput).skillId),
        );
      case "removeSkill":
        return this.command("skill.remove", args[0] as CommandEnvelope<SkillIdInput>, (tx, p) =>
          this.skills.remove(tx, (p as SkillIdInput).skillId),
        );
      case "selectConversationSkills":
        return this.command(
          "skill.select_for_conversation",
          args[0] as CommandEnvelope<SelectConversationSkillsInput>,
          (tx, p) => this.runControl.selectConversationSkills(tx, p as SelectConversationSkillsInput),
        );
      case "connectConnector": {
        if (this.deps.connectConnector) return this.deps.connectConnector(args[0] as string);
        return this.connectConnector(args[0] as string);
      }
      case "snapshot":
        return this.store.readSnapshot(args[0] as ConversationId | undefined);
      case "history":
        return this.history(args[0] as { conversationId: ConversationId; beforeSequence?: number; limit?: number });
      case "readArtifact":
        return this.readArtifact(args[0] as { artifactId: string; offset?: number; limit?: number });
      default:
        throw new AppError("NOT_FOUND", `unknown owner method: ${method}`);
    }
  }

  private async command<T>(
    kind: string,
    envelope: CommandEnvelope<unknown>,
    handler: (tx: StoreTransaction, payload: unknown) => ServiceOutcome<T>,
    options: CommandProcessOptions<T> = {},
  ): Promise<CommandReceipt<T>> {
    if (!envelope || typeof envelope.commandId !== "string" || envelope.commandId.length === 0) {
      throw new AppError("INVALID_INPUT", "a command envelope with a commandId is required");
    }
    return this.processor.process(kind, envelope, (tx, payload) => {
      const outcome = handler(tx, payload);
      if (CONFIGURATION_COMMANDS.has(kind)) {
        outcome.changes.push({ kind: "configuration.update", value: buildConfiguration(tx) });
      }
      return outcome;
    }, options);
  }

  /**
   * ADR-0001: permanent deletion keeps the public receipt empty while the
   * internal cleanup result carries the affected runtime ids. Definitive
   * rejections are persisted so a delayed retry cannot delete later.
   */
  private async deleteConversation(
    envelope: CommandEnvelope<DeleteConversationInput>,
  ): Promise<CommandReceipt<void>> {
    const receipt = await this.command<ConversationDeletion>(
      "conversation.delete",
      envelope,
      (tx, payload) => this.conversations.delete(tx, payload as DeleteConversationInput),
      { persistRejections: true, receiptValue: () => null },
    );
    const deletion = receipt.result as ConversationDeletion | null;
    if (deletion) this.afterConversationDeletion(deletion);
    return { commandId: receipt.commandId, revision: receipt.revision, result: undefined };
  }

  /** Discard in-memory execution state for records that no longer exist. */
  private afterConversationDeletion(deletion: ConversationDeletion): void {
    for (const attemptId of deletion.attemptIds) this.driver.discardAttempt(attemptId);
    for (const runId of deletion.runIds) this.driver.discardRun(runId);
  }

  /** Push the current configuration to connected clients. */
  private publishConfiguration(): void {
    const commit = this.store.transaction((tx) => {
      tx.changes.push({ kind: "configuration.update", value: buildConfiguration(tx) });
      return null;
    });
    this.sync.publish(commit);
  }

  history(query: { conversationId: ConversationId; beforeSequence?: number; limit?: number }) {
    return this.store.read((tx) => {
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const entries = query.beforeSequence
        ? tx.entries.listBefore(query.conversationId, query.beforeSequence, limit)
        : tx.entries.listRecent(query.conversationId, limit);
      const page: {
        conversationId: ConversationId;
        entries: ReturnType<typeof projectEntry>[];
        olderEntriesCursor?: string;
        revision: number;
      } = {
        conversationId: query.conversationId,
        entries: entries.map((entry) => projectEntry(entry)),
        revision: tx.ownerState.read().revision,
      };
      const first = entries[0];
      if (first && first.sequence > 1) page.olderEntriesCursor = String(first.sequence);
      return page;
    });
  }

  readArtifact(query: { artifactId: string; offset?: number; limit?: number }) {
    return this.store.read((tx) => {
      const artifact = tx.artifacts.get(query.artifactId);
      if (!artifact) throw new AppError("NOT_FOUND", "artifact not found");
      const chunks = tx.artifacts.readChunks(query.artifactId);
      const full = chunks.map((chunk) => chunk.data).join("");
      const offset = Math.max(query.offset ?? 0, 0);
      const limit = Math.min(Math.max(query.limit ?? 65536, 1), 262144);
      const text = full.slice(offset, offset + limit);
      return {
        artifactId: artifact.id,
        mimeType: artifact.mimeType,
        encoding: artifact.encoding,
        byteCount: text.length,
        totalByteCount: artifact.byteCount,
        complete: artifact.complete,
        offset,
        text,
      };
    });
  }

  listTools(): ToolDescriptor[] {
    return this.store.read((tx) => this.mcp.catalog.snapshot(tx));
  }

  /** Discovery, authentication negotiation, and tool enumeration. */
  async connectConnector(connectorId: string): Promise<ConnectionReport> {
    const connector = this.store.read((tx) => tx.mcpServers.get(connectorId));
    if (!connector) throw new AppError("NOT_FOUND", "connector not found");
    try {
      const session = await this.mcp.sessions.acquire(connectorId);
      const discovered = await listAllTools(session.connection);
      const descriptors = this.store.transaction((tx) =>
        this.mcp.catalog.replaceDiscovery(tx, connectorId, connector.configurationVersion, discovered),
      );
      this.store.transaction((tx) => tx.mcpServers.setState(connectorId, "ready", null, this.clock.now()));
      return { connectorId, state: "ready", toolCount: descriptors.value.length };
    } catch (error) {
      if (error instanceof AppError && error.code === "AUTH_REQUIRED") {
        if (connector.authenticationMode === "oauth") {
          const { authorizationUrl } = await this.mcp.oauth.begin(connectorId);
          this.store.transaction((tx) => tx.mcpServers.setState(connectorId, "auth_required", null, this.clock.now()));
          return { connectorId, state: "auth_required", toolCount: 0, authUrl: authorizationUrl };
        }
        this.store.transaction((tx) =>
          tx.mcpServers.setState(connectorId, "auth_required", error.message, this.clock.now()),
        );
        return { connectorId, state: "auth_required", toolCount: 0 };
      }
      const message = error instanceof Error ? error.message : "connection failed";
      this.store.transaction((tx) => tx.mcpServers.setState(connectorId, "error", message, this.clock.now()));
      return { connectorId, state: "error", toolCount: 0, error: message };
    } finally {
      // Connector state and tool counts are part of the configuration view.
      this.publishConfiguration();
    }
  }

  async handleOAuthCallback(callback: {
    state: string;
    code?: string;
    error?: string;
  }): Promise<ConnectionReport> {
    const { connectorId } = await this.mcp.oauth.complete(callback);
    return this.connectConnector(connectorId);
  }
}

export type { SqlExecutor, StorageBackend, Commit };

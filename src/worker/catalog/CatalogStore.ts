// Application catalog over D1 (ADR-0003, ADR-0004).
//
// There is no owner Durable Object and no owner scoping. The authenticated
// Worker verifies access, then reads and writes the application-wide catalog
// and settings here. Conversations use their conversation identifiers,
// settings use one singleton record, and creation receipts use their command
// identifiers. Session lifecycle crosses D1 and a session object with no shared
// transaction, so every mutation uses conditional SQL, checked affected-row
// counts, and an idempotent sequence.

import {
  AppError,
  type CatalogView,
  type CommandEnvelope,
  type CommandReceipt,
  type ConversationLifecycle,
  type ConversationSummary,
  type CreateConversationInput,
  type DeleteConversationInput,
  type ModelSettingsView,
  type RenameConversationInput,
  type SaveModelProfileInput,
} from "../../shared/domain";
import { hashPayload } from "../../shared/json";
import { defaultRouteSettings, listRouteViews, resolveRouteById } from "../models";
import { parseStoredRouteSettings, type StoredRouteSettings } from "../models/StoredSettings";

const CREATE_KIND = "conversation.create";
const DEFAULT_TITLE = "New conversation";
/** ADR-0004: the application is single-user, so settings have one fixed key. */
const SETTINGS_KEY = "app";

export interface ConversationRow {
  id: string;
  title: string;
  lifecycle: ConversationLifecycle;
  created_at: number;
  updated_at: number;
}

interface CommandRow {
  kind: string;
  payload_hash: string;
  result_json: string;
}

/** Provisioning callback that initializes one session's storage. */
export type SessionProvisioner = (conversationId: string) => Promise<void>;
/** Erasure callback that quiesces and removes one session's storage. */
export type SessionEraser = (conversationId: string) => Promise<void>;

export class CatalogStore {
  private schemaReady?: Promise<void>;

  constructor(private readonly db: D1Database) {}

  private ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        await this.db
          .prepare(
            `CREATE TABLE IF NOT EXISTS conversations (
               id TEXT PRIMARY KEY,
               title TEXT NOT NULL,
               lifecycle TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL
             )`,
          )
          .run();
        await this.db
          .prepare(
            `CREATE INDEX IF NOT EXISTS conversations_updated
               ON conversations (updated_at DESC, id)`,
          )
          .run();
        await this.db
          .prepare(
            `CREATE TABLE IF NOT EXISTS settings (
               key TEXT PRIMARY KEY,
               model_json TEXT,
               updated_at INTEGER NOT NULL
             )`,
          )
          .run();
        // ADR-0003: creation receipts only. Rename, delete, and settings are
        // direct application-wide operations.
        await this.db
          .prepare(
            `CREATE TABLE IF NOT EXISTS commands (
               command_id TEXT PRIMARY KEY,
               kind TEXT NOT NULL,
               payload_hash TEXT NOT NULL,
               result_json TEXT NOT NULL,
               outcome TEXT NOT NULL,
               created_at INTEGER NOT NULL
             )`,
          )
          .run();
      })();
    }
    return this.schemaReady;
  }

  async list(): Promise<ConversationSummary[]> {
    await this.ensureSchema();
    const { results } = await this.db
      .prepare(
        `SELECT id, title, lifecycle, created_at, updated_at
           FROM conversations
          ORDER BY updated_at DESC, id`,
      )
      .all<ConversationRow>();
    return (results ?? []).map(toSummary);
  }

  async get(conversationId: string): Promise<ConversationRow | undefined> {
    await this.ensureSchema();
    const row = await this.db
      .prepare(`SELECT * FROM conversations WHERE id = ?`)
      .bind(conversationId)
      .first<ConversationRow>();
    return row ?? undefined;
  }

  async readSettings(): Promise<StoredRouteSettings | undefined> {
    await this.ensureSchema();
    const row = await this.db
      .prepare(`SELECT model_json FROM settings WHERE key = ?`)
      .bind(SETTINGS_KEY)
      .first<{ model_json: string | null }>();
    return parseStoredRouteSettings(row?.model_json ?? undefined);
  }

  async view(): Promise<CatalogView> {
    const [conversations, stored] = await Promise.all([this.list(), this.readSettings()]);
    const routes = listRouteViews();
    if (!stored) return { conversations, routes };
    const selection = resolveRouteById(stored.routeId);
    return { conversations, routes, model: settingsView(stored, selection) };
  }

  /**
   * Create a conversation. The creating row and its receipt are written in one
   * batch; activation and provisioning follow as separate, retryable steps.
   */
  async create(
    command: CommandEnvelope<CreateConversationInput>,
    provision: SessionProvisioner,
  ): Promise<CommandReceipt<{ conversationId: string }>> {
    await this.ensureSchema();
    const payloadHash = hashPayload(command.payload);
    const existing = await this.findCommand(command.commandId);
    if (existing) return this.resumeCreate(existing, payloadHash, provision);

    const conversationId = crypto.randomUUID();
    const now = Date.now();
    const title = normalizeTitle(command.payload.title) ?? DEFAULT_TITLE;
    const receipt: CommandReceipt<{ conversationId: string }> = {
      commandId: command.commandId,
      result: { conversationId },
    };
    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO conversations (id, title, lifecycle, created_at, updated_at)
             VALUES (?, ?, 'creating', ?, ?)`,
          )
          .bind(conversationId, title, now, now),
        this.db
          .prepare(
            `INSERT INTO commands (command_id, kind, payload_hash, result_json, outcome, created_at)
             VALUES (?, ?, ?, ?, 'accepted', ?)`,
          )
          .bind(command.commandId, CREATE_KIND, payloadHash, JSON.stringify(receipt), now),
      ]);
    } catch (error) {
      // Two concurrent creates with the same command id: the loser adopts the
      // winner's receipt instead of surfacing a unique-constraint failure.
      const winner = await this.findCommand(command.commandId);
      if (winner) return this.resumeCreate(winner, payloadHash, provision);
      throw error;
    }

    await this.activate(conversationId);
    await provision(conversationId);
    return receipt;
  }

  /** Resume an existing create receipt without ever recreating a missing row. */
  private async resumeCreate(
    row: CommandRow,
    payloadHash: string,
    provision: SessionProvisioner,
  ): Promise<CommandReceipt<{ conversationId: string }>> {
    const receipt = this.replay<{ conversationId: string }>(row, CREATE_KIND, payloadHash);
    const current = await this.get(receipt.result.conversationId);
    if (!current) return receipt;
    if (current.lifecycle === "creating") await this.activate(current.id);
    const after = await this.get(receipt.result.conversationId);
    if (after && after.lifecycle === "active") await provision(after.id);
    return receipt;
  }

  /**
   * Conditionally activate a creating row. Implementation clarification: the
   * row becomes active before the session is provisioned, so an active row
   * without an initialized session is recoverable by retrying the create.
   */
  private async activate(conversationId: string): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE conversations SET lifecycle = 'active', updated_at = ?
          WHERE id = ? AND lifecycle = 'creating'`,
      )
      .bind(Date.now(), conversationId)
      .run();
    if ((result.meta.changes ?? 0) > 0) return;
    const row = await this.get(conversationId);
    if (!row) throw new AppError("NOT_FOUND", "conversation disappeared during creation");
    if (row.lifecycle === "deleting") {
      throw new AppError("CONFLICT", "conversation is being deleted");
    }
    // Already active: a concurrent retry activated it.
  }

  async rename(input: RenameConversationInput): Promise<void> {
    await this.ensureSchema();
    const title = normalizeTitle(input.title);
    if (!title) throw new AppError("INVALID_INPUT", "title must not be empty");
    const result = await this.db
      .prepare(
        `UPDATE conversations SET title = ?, updated_at = ?
          WHERE id = ? AND lifecycle != 'deleting'`,
      )
      .bind(title, Date.now(), input.conversationId)
      .run();
    if ((result.meta.changes ?? 0) > 0) return;
    const row = await this.get(input.conversationId);
    if (!row) throw new AppError("NOT_FOUND", "conversation not found");
    throw new AppError("CONFLICT", "conversation is being deleted");
  }

  /**
   * Quiesce and erase one session, then remove its catalog row. An absent row
   * means the deletion already completed; a retry resumes a partial sequence.
   */
  async delete(input: DeleteConversationInput, erase: SessionEraser): Promise<void> {
    await this.ensureSchema();
    const row = await this.get(input.conversationId);
    if (!row) return;

    if (row.lifecycle !== "deleting") {
      const result = await this.db
        .prepare(
          `UPDATE conversations SET lifecycle = 'deleting', updated_at = ?
            WHERE id = ? AND lifecycle IN ('active', 'creating')`,
        )
        .bind(Date.now(), row.id)
        .run();
      if ((result.meta.changes ?? 0) === 0) {
        const current = await this.get(row.id);
        if (!current) return;
        if (current.lifecycle !== "deleting") {
          throw new AppError("CONFLICT", "conversation could not be marked for deletion");
        }
      }
    }

    await erase(row.id);
    await this.db.prepare(`DELETE FROM conversations WHERE id = ?`).bind(row.id).run();
  }

  async saveModelProfile(input: SaveModelProfileInput): Promise<ModelSettingsView> {
    await this.ensureSchema();
    const settings = input.settings;
    if (!settings.gatewayId || !settings.routeId) {
      throw new AppError("INVALID_INPUT", "model settings require gatewayId and routeId");
    }
    if (settings.maxOutputTokens !== undefined && settings.maxOutputTokens <= 0) {
      throw new AppError("INVALID_INPUT", "maxOutputTokens must be positive");
    }
    const selection = resolveRouteById(settings.routeId);
    if (
      settings.maxOutputTokens !== undefined &&
      selection.maxTokens > 0 &&
      settings.maxOutputTokens > selection.maxTokens
    ) {
      throw new AppError(
        "INVALID_INPUT",
        `maxOutputTokens exceeds the model limit of ${selection.maxTokens}`,
      );
    }
    if (
      settings.thinkingLevel !== undefined &&
      !selection.thinkingLevels.includes(settings.thinkingLevel as never)
    ) {
      throw new AppError(
        "INVALID_INPUT",
        `thinking level ${settings.thinkingLevel} is not supported by ${selection.modelName}`,
      );
    }

    const stored: StoredRouteSettings = {
      kind: "route",
      gatewayId: settings.gatewayId,
      routeId: settings.routeId,
      thinkingLevel: settings.thinkingLevel,
      maxOutputTokens: settings.maxOutputTokens,
    };
    await this.db
      .prepare(
        `INSERT INTO settings (key, model_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET model_json = excluded.model_json, updated_at = excluded.updated_at`,
      )
      .bind(SETTINGS_KEY, JSON.stringify(stored), Date.now())
      .run();
    return settingsView(stored, selection);
  }

  private async findCommand(commandId: string): Promise<CommandRow | undefined> {
    const row = await this.db
      .prepare(`SELECT kind, payload_hash, result_json FROM commands WHERE command_id = ?`)
      .bind(commandId)
      .first<CommandRow>();
    return row ?? undefined;
  }

  private replay<T>(row: CommandRow, kind: string, payloadHash: string): CommandReceipt<T> {
    if (row.kind !== kind || row.payload_hash !== payloadHash) {
      throw new AppError("CONFLICT", "commandId was reused with a different command or payload", false);
    }
    return JSON.parse(row.result_json) as CommandReceipt<T>;
  }
}

function toSummary(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    lifecycle: row.lifecycle,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function normalizeTitle(title: unknown): string | undefined {
  if (typeof title !== "string") return undefined;
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function settingsView(
  stored: StoredRouteSettings,
  selection: {
    routeId: string;
    modelName: string;
    contextWindow: number;
    maxTokens: number;
    thinkingLevels: string[];
  },
): ModelSettingsView {
  return {
    kind: "route",
    gatewayId: stored.gatewayId,
    routeId: selection.routeId,
    label: selection.modelName,
    thinkingLevel: stored.thinkingLevel,
    maxOutputTokens: stored.maxOutputTokens,
    contextWindow: selection.contextWindow,
    maxTokens: selection.maxTokens,
    thinkingLevels: selection.thinkingLevels,
  };
}

export { defaultRouteSettings };

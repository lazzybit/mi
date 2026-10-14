// Conversation, submission, and run-control domain services
// (PLAN.md -> Domain services). Services mutate through a `StoreTransaction`
// and never perform network I/O.

import { AppError, isTerminalRunState, type CommandEnvelope, type ConversationId, type RunId, type SubmissionId } from "../../shared/domain";
import type {
  CreateConversationInput,
  DeleteConversationInput,
  RenameConversationInput,
  SelectConversationSkillsInput,
  SkillIdInput,
  SubmitInput,
  WithdrawSubmissionInput,
} from "../../shared/commands";
import type { ResolveAttemptInput } from "../../shared/domain";
import type { StoreTransaction } from "../storage/SqlStore";
import { projectAttempt, projectConversation, projectEntry, projectRun, projectSubmission } from "../storage/projections";
import { projectConversationSummary, conversationSummaryChange } from "../storage/ConversationProjection";
import { collectArtifactCandidates, collectSurvivingReferences } from "../storage/ArtifactReferences";
import type { EntryRecord, RunCheckpoint, RunRecord } from "../storage/records";
import type { ViewChange } from "../../shared/wire";

export interface ServiceDeps {
  now(): number;
  newId(): string;
}

export interface ServiceOutcome<T> {
  value: T;
  changes: ViewChange[];
}

/**
 * ADR-0001: internal deletion result. The affected runtime ids let the owner
 * discard in-flight execution state without exposing an inventory in the
 * public command receipt.
 */
export interface ConversationDeletion {
  conversationId: ConversationId;
  runIds: RunId[];
  attemptIds: string[];
}

function emptyCheckpoint(): RunCheckpoint {
  return {
    phase: "prepare_context",
    turnNumber: 0,
    pendingToolCalls: [],
    nextToolIndex: 0,
  };
}

export class ConversationService {
  constructor(private readonly deps: ServiceDeps) {}

  create(
    tx: StoreTransaction,
    input: CreateConversationInput,
  ): ServiceOutcome<{ conversationId: ConversationId }> {
    const now = this.deps.now();
    const id = this.deps.newId();
    const title = input.title?.trim() || "New conversation";
    tx.conversations.create({ id, title, createdAt: now, updatedAt: now });
    const conversation = tx.conversations.get(id);
    return {
      value: { conversationId: id },
      changes: conversation
        ? [{ kind: "conversation.upsert", value: projectConversationSummary(tx, conversation) }]
        : [],
    };
  }

  list(tx: StoreTransaction) {
    return tx.conversations.list().map(projectConversation);
  }

  rename(tx: StoreTransaction, input: RenameConversationInput): ServiceOutcome<void> {
    const conversation = tx.conversations.get(input.conversationId);
    if (!conversation) throw new AppError("NOT_FOUND", "conversation not found");
    const title = input.title.trim();
    if (!title) throw new AppError("INVALID_INPUT", "title must not be empty");
    tx.conversations.rename(input.conversationId, title, this.deps.now());
    const updated = tx.conversations.get(input.conversationId);
    return {
      value: undefined,
      changes: updated
        ? [{ kind: "conversation.upsert", value: projectConversationSummary(tx, updated) }]
        : [],
    };
  }

  /**
   * ADR-0001: permanently remove a conversation. Eligibility is checked in the
   * same transaction that performs the removal. Any non-terminal run refuses
   * deletion with a definitive, non-retryable CONFLICT.
   */
  delete(
    tx: StoreTransaction,
    input: DeleteConversationInput,
  ): ServiceOutcome<ConversationDeletion> {
    const conversation = tx.conversations.get(input.conversationId);
    if (!conversation) throw new AppError("NOT_FOUND", "conversation not found", false);

    const runs = tx.runs.listForConversation(input.conversationId);
    if (runs.some((run) => !isTerminalRunState(run.state))) {
      throw new AppError(
        "CONFLICT",
        "conversation has queued or active work; finish or cancel it first",
        false,
      );
    }

    const attempts = tx.attempts.listForConversation(input.conversationId);
    const attemptIds = attempts.map((attempt) => attempt.id);

    // Evaluate surviving references before any row is removed.
    const candidates = collectArtifactCandidates(tx, input.conversationId);
    const surviving = collectSurvivingReferences(tx, input.conversationId);
    const removable = [...candidates].filter((id) => !surviving.has(id));

    tx.liveOutput.deleteForAttempts(attemptIds);
    tx.attemptResolutions.deleteForAttempts(attemptIds);
    tx.entries.deleteForConversation(input.conversationId);
    tx.submissions.deleteForConversation(input.conversationId);
    tx.contextSnapshots.deleteForConversation(input.conversationId);
    tx.skills.selectForConversation(input.conversationId, []);
    tx.attempts.deleteForConversation(input.conversationId);
    tx.runs.deleteForConversation(input.conversationId);
    tx.artifacts.deleteMany(removable);
    tx.conversations.delete(input.conversationId);

    return {
      value: {
        conversationId: input.conversationId,
        runIds: runs.map((run) => run.id),
        attemptIds,
      },
      changes: [{ kind: "conversation.remove", conversationId: input.conversationId }],
    };
  }
}

export class SubmissionService {
  constructor(private readonly deps: ServiceDeps) {}

  submit(tx: StoreTransaction, input: SubmitInput): ServiceOutcome<{
    submissionId: SubmissionId;
    runId: RunId;
    state: "queued" | "joined";
  }> {
    const conversation = tx.conversations.get(input.conversationId);
    if (!conversation) throw new AppError("NOT_FOUND", "conversation not found");
    const text = input.text.trim();
    if (!text) throw new AppError("INVALID_INPUT", "submission text must not be empty");

    const now = this.deps.now();

    if (input.mode === "steer") {
      const activeRun = tx.runs.activeForConversation(input.conversationId);
      if (!activeRun) {
        throw new AppError("CONFLICT", "no active run to steer; use queue mode instead");
      }
      const id = this.deps.newId();
      tx.submissions.insert({
        id,
        conversationId: input.conversationId,
        commandId: id,
        mode: "steer",
        ownerSequence: tx.submissions.nextOwnerSequence(),
        content: text,
        state: "steering",
        runId: activeRun.id,
        createdAt: now,
      });
      tx.conversations.touch(input.conversationId, now);
      const userEntry = this.appendUserEntry(tx, input.conversationId, text, now);
      const steering = tx.submissions.listSteeringForRun(activeRun.id);
      const changes: ViewChange[] = [
        { kind: "entry.append", conversationId: input.conversationId, value: projectEntry(userEntry) },
        {
          kind: "inbox.replace",
          conversationId: input.conversationId,
          values: steering.map(projectSubmission),
        },
      ];
      const summary = conversationSummaryChange(tx, input.conversationId);
      if (summary) changes.push(summary);
      return {
        value: { submissionId: id, runId: activeRun.id, state: "joined" },
        changes,
      };
    }

    // queue: create a queued run for this submission immediately, so the
    // receipt carries a stable run id and the driver can pick the oldest.
    const runId = this.deps.newId();
    const run: RunRecord = {
      id: runId,
      conversationId: input.conversationId,
      state: "queued",
      phase: "prepare_context",
      checkpoint: emptyCheckpoint(),
      generation: tx.ownerState.readDriverGeneration(),
      createdAt: now,
      updatedAt: now,
    };
    tx.runs.insert(run);
    const submissionId = this.deps.newId();
    tx.submissions.insert({
      id: submissionId,
      conversationId: input.conversationId,
      commandId: submissionId,
      mode: "queue",
      ownerSequence: tx.submissions.nextOwnerSequence(),
      content: text,
      state: "queued",
      runId,
      createdAt: now,
    });
    tx.conversations.touch(input.conversationId, now);
    const userEntry = this.appendUserEntry(tx, input.conversationId, text, now);
    const queued = tx.submissions.listQueuedForConversation(input.conversationId);
    const changes: ViewChange[] = [
      { kind: "run.update", conversationId: input.conversationId, value: projectRun(run) },
      { kind: "entry.append", conversationId: input.conversationId, value: projectEntry(userEntry) },
      {
        kind: "inbox.replace",
        conversationId: input.conversationId,
        values: queued.map(projectSubmission),
      },
    ];
    const summary = conversationSummaryChange(tx, input.conversationId);
    if (summary) changes.push(summary);
    return {
      value: { submissionId, runId, state: "queued" },
      changes,
    };
  }

  private appendUserEntry(
    tx: StoreTransaction,
    conversationId: ConversationId,
    text: string,
    now: number,
  ): EntryRecord {
    const entry: EntryRecord = {
      id: this.deps.newId(),
      conversationId,
      sequence: tx.conversations.nextEntrySequence(conversationId),
      kind: "user",
      text,
      isError: false,
      createdAt: now,
    };
    tx.entries.insert(entry);
    return entry;
  }

  withdraw(tx: StoreTransaction, input: WithdrawSubmissionInput): ServiceOutcome<void> {
    const submission = tx.submissions.get(input.submissionId);
    if (!submission) throw new AppError("NOT_FOUND", "submission not found");
    if (submission.state !== "queued" && submission.state !== "steering") {
      throw new AppError("CONFLICT", "submission has already been accepted");
    }
    tx.submissions.setState(submission.id, "withdrawn");
    const remaining = [
      ...tx.submissions.listQueuedForConversation(submission.conversationId),
      ...(submission.runId ? tx.submissions.listSteeringForRun(submission.runId) : []),
    ];
    const changes: ViewChange[] = [
      {
        kind: "inbox.replace",
        conversationId: submission.conversationId,
        values: remaining.map(projectSubmission),
      },
    ];
    const summary = conversationSummaryChange(tx, submission.conversationId);
    if (summary) changes.push(summary);
    return { value: undefined, changes };
  }
}

export class RunControlService {
  constructor(private readonly deps: ServiceDeps) {}

  cancel(tx: StoreTransaction, runId: RunId): ServiceOutcome<void> {
    const run = tx.runs.get(runId);
    if (!run) throw new AppError("NOT_FOUND", "run not found");
    const now = this.deps.now();
    if (run.state === "queued") {
      run.state = "cancelled";
      run.updatedAt = now;
      tx.runs.update(run);
      for (const submission of tx.submissions.listQueuedForConversation(run.conversationId)) {
        if (submission.runId === runId) tx.submissions.setState(submission.id, "withdrawn");
      }
    } else if (run.state === "running" || run.state === "waiting_for_auth" || run.state === "needs_attention") {
      run.cancelRequestedAt = now;
      run.updatedAt = now;
      tx.runs.update(run);
    } else {
      throw new AppError("CONFLICT", `run is already ${run.state}`);
    }
    const changes: ViewChange[] = [
      { kind: "run.update", conversationId: run.conversationId, value: projectRun(run) },
    ];
    const summary = conversationSummaryChange(tx, run.conversationId);
    if (summary) changes.push(summary);
    return { value: undefined, changes };
  }

  resume(tx: StoreTransaction, runId: RunId): ServiceOutcome<void> {
    const run = tx.runs.get(runId);
    if (!run) throw new AppError("NOT_FOUND", "run not found");
    if (run.state !== "waiting_for_auth" && run.state !== "needs_attention") {
      throw new AppError("CONFLICT", `run is not paused (state ${run.state})`);
    }
    run.state = "queued";
    run.updatedAt = this.deps.now();
    tx.runs.update(run);
    const changes: ViewChange[] = [
      { kind: "run.update", conversationId: run.conversationId, value: projectRun(run) },
    ];
    const summary = conversationSummaryChange(tx, run.conversationId);
    if (summary) changes.push(summary);
    return { value: undefined, changes };
  }

  resolveAttempt(tx: StoreTransaction, input: ResolveAttemptInput): ServiceOutcome<void> {
    const attempt = tx.attempts.get(input.attemptId);
    if (!attempt) throw new AppError("NOT_FOUND", "attempt not found");
    if (attempt.state !== "unknown" && attempt.state !== "interrupted" && attempt.state !== "failed") {
      throw new AppError("CONFLICT", "attempt does not require resolution");
    }
    const run = tx.runs.get(attempt.runId);
    if (!run) throw new AppError("NOT_FOUND", "run not found");
    const now = this.deps.now();

    tx.attemptResolutions.insert({
      id: this.deps.newId(),
      attemptId: attempt.id,
      action: input.action,
      explanation: input.explanation,
      evidenceJson: JSON.stringify(input.evidenceArtifactIds),
      createdAt: now,
    });

    const changes: ViewChange[] = [];

    if (input.action === "retry") {
      // A retry creates a new linked attempt; the original unknown outcome is
      // preserved and never rewritten into "not executed".
      const retry = {
        ...attempt,
        id: this.deps.newId(),
        state: "prepared" as const,
        parentAttemptId: attempt.id,
        resultArtifactId: undefined,
        uncertaintyJson: undefined,
        errorCode: undefined,
        errorMessage: undefined,
        createdAt: now,
        updatedAt: now,
      };
      tx.attempts.insert(retry);
      run.state = "queued";
      run.updatedAt = now;
      tx.runs.update(run);
      changes.push({ kind: "attempt.update", conversationId: run.conversationId, value: projectAttempt(attempt) });
      changes.push({ kind: "attempt.update", conversationId: run.conversationId, value: projectAttempt(retry) });
    } else if (input.action === "accept_observed_state") {
      attempt.state = "succeeded";
      attempt.updatedAt = now;
      tx.attempts.update(attempt);
      run.state = "queued";
      run.updatedAt = now;
      tx.runs.update(run);
      changes.push({ kind: "attempt.update", conversationId: run.conversationId, value: projectAttempt(attempt) });
    } else {
      // abandon
      attempt.state = "failed";
      attempt.updatedAt = now;
      tx.attempts.update(attempt);
      run.state = "failed";
      run.updatedAt = now;
      tx.runs.update(run);
      changes.push({ kind: "attempt.update", conversationId: run.conversationId, value: projectAttempt(attempt) });
    }

    changes.push({ kind: "run.update", conversationId: run.conversationId, value: projectRun(run) });
    const summary = conversationSummaryChange(tx, run.conversationId);
    if (summary) changes.push(summary);
    return { value: undefined, changes };
  }

  selectConversationSkills(
    tx: StoreTransaction,
    input: SelectConversationSkillsInput,
  ): ServiceOutcome<void> {
    const conversation = tx.conversations.get(input.conversationId);
    if (!conversation) throw new AppError("NOT_FOUND", "conversation not found");
    for (const skillId of input.skillIds) {
      const skill = tx.skills.get(skillId);
      if (!skill || skill.deleted) throw new AppError("NOT_FOUND", `skill not found: ${skillId}`);
    }
    tx.skills.selectForConversation(input.conversationId, input.skillIds);
    return {
      value: undefined,
      changes: [
        {
          kind: "conversation.skills",
          conversationId: input.conversationId,
          skillIds: [...input.skillIds],
        },
      ],
    };
  }
}

export { emptyCheckpoint };

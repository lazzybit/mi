// Conversation, submission, and run-control domain services
// (PLAN.md -> Domain services). Services mutate through a `StoreTransaction`
// and never perform network I/O.

import { AppError, type CommandEnvelope, type ConversationId, type RunId, type SubmissionId } from "../../shared/domain";
import type {
  CreateConversationInput,
  RenameConversationInput,
  SelectConversationSkillsInput,
  SkillIdInput,
  SubmitInput,
  WithdrawSubmissionInput,
} from "../../shared/commands";
import type { ResolveAttemptInput } from "../../shared/domain";
import type { StoreTransaction } from "../storage/SqlStore";
import { projectConversation, projectEntry, projectRun, projectSubmission } from "../storage/projections";
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
        ? [{ kind: "conversation.upsert", value: { ...projectConversation(conversation), queuedCount: 0 } }]
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
        ? [
            {
              kind: "conversation.upsert",
              value: {
                ...projectConversation(updated),
                queuedCount: tx.submissions.listQueuedForConversation(input.conversationId).length,
              },
            },
          ]
        : [],
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
      return {
        value: { submissionId: id, runId: activeRun.id, state: "joined" },
        changes: [
          { kind: "entry.append", conversationId: input.conversationId, value: projectEntry(userEntry) },
          {
            kind: "inbox.replace",
            conversationId: input.conversationId,
            values: steering.map(projectSubmission),
          },
        ],
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
    return {
      value: { submissionId, runId, state: "queued" },
      changes: [
        { kind: "run.update", conversationId: input.conversationId, value: projectRun(run) },
        { kind: "entry.append", conversationId: input.conversationId, value: projectEntry(userEntry) },
        {
          kind: "inbox.replace",
          conversationId: input.conversationId,
          values: queued.map(projectSubmission),
        },
      ],
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
    return {
      value: undefined,
      changes: [
        {
          kind: "inbox.replace",
          conversationId: submission.conversationId,
          values: remaining.map(projectSubmission),
        },
      ],
    };
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
    return {
      value: undefined,
      changes: [
        { kind: "run.update", conversationId: run.conversationId, value: projectRun(run) },
      ],
    };
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
    return {
      value: undefined,
      changes: [
        { kind: "run.update", conversationId: run.conversationId, value: projectRun(run) },
      ],
    };
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
    } else if (input.action === "accept_observed_state") {
      attempt.state = "succeeded";
      attempt.updatedAt = now;
      tx.attempts.update(attempt);
      run.state = "queued";
      run.updatedAt = now;
      tx.runs.update(run);
    } else {
      // abandon
      attempt.state = "failed";
      attempt.updatedAt = now;
      tx.attempts.update(attempt);
      run.state = "failed";
      run.updatedAt = now;
      tx.runs.update(run);
    }

    return {
      value: undefined,
      changes: [
        { kind: "run.update", conversationId: run.conversationId, value: projectRun(run) },
      ],
    };
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

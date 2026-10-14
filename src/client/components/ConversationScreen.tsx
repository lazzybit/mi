import { Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { OwnerSnapshot, TranscriptEntryView } from "../../shared/domain";
import type { ConnectionStatus } from "../sync/ConversationFeed";
import { Composer } from "./Composer";
import { ConversationSkillPicker } from "./ConversationSkillPicker";
import { QueuePanel } from "./QueuePanel";
import { RecoveryPanel } from "./RecoveryPanel";
import { RunStatusBar } from "./RunStatusBar";
import { Transcript } from "./Transcript";
import type { AppActions } from "./types";

export function ConversationScreen(props: {
  snapshot: OwnerSnapshot;
  status: ConnectionStatus;
  actions: AppActions;
  draft: string;
  onDraft: (value: string) => void;
  onHistory: (beforeSequence?: number) => Promise<TranscriptEntryView[]>;
  onReadArtifact: (artifactId: string) => Promise<string>;
}): JSX.Element {
  const conversation = () => props.snapshot.selectedConversation;
  const [older, setOlder] = createSignal<TranscriptEntryView[]>([]);
  // ADR-0001: selection-scoped state is discarded when the selection changes,
  // including when the same conversation is selected again.
  const [selectionGeneration, setSelectionGeneration] = createSignal(0);
  createEffect(
    () => conversation()?.conversation.id,
    () => {
      setOlder([]);
      setSelectionGeneration((generation) => generation + 1);
    },
  );

  const entries = () => [...older(), ...(conversation()?.entries ?? [])];
  // Pagination advances from the oldest entry already loaded rather than
  // reusing the snapshot cursor, which would refetch the same page forever.
  const oldestSequence = () => older()[0]?.sequence ?? conversation()?.entries[0]?.sequence;
  const hasOlder = () => (oldestSequence() ?? 1) > 1;

  const loadOlder = async () => {
    const before = oldestSequence();
    if (!before || before <= 1) return;
    const generation = selectionGeneration();
    const page = await props.onHistory(before);
    // Discard a late page that belongs to a replaced selection.
    if (generation !== selectionGeneration()) return;
    setOlder((previous) => [...page, ...previous]);
  };

  return (
    <section class="conversation-screen">
      <Show when={conversation()} fallback={<div class="empty">Select or create a conversation.</div>}>
        {(selected) => (
          <>
            <header class="conversation-header">
              <h2>{selected().conversation.title}</h2>
            </header>
            <details class="conversation-skills">
              <summary>Skills</summary>
              <ConversationSkillPicker
                skills={props.snapshot.configuration.skills.filter(
                  (skill) => skill.enabled && !skill.deleted,
                )}
                selected={selected().selectedSkillIds ?? []}
                onChange={(skillIds) =>
                  void props.actions.dispatch("skill.select_for_conversation", {
                    conversationId: selected().conversation.id,
                    skillIds,
                  })
                }
              />
            </details>
            <RunStatusBar
              run={selected().activeRun}
              attempt={selected().activeAttempt}
              status={props.status}
              onCancel={() => {
                const run = selected().activeRun;
                if (run) void props.actions.dispatch("run.cancel", { runId: run.id });
              }}
            />
            <RecoveryPanel
              attempt={selected().activeAttempt}
              onResolve={(action) => {
                const attempt = selected().activeAttempt;
                if (!attempt) return;
                void props.actions.dispatch("run.resolve_attempt", {
                  attemptId: attempt.id,
                  action,
                  explanation: "resolved from the client",
                  evidenceArtifactIds: [],
                });
              }}
            />
            <Transcript
              entries={entries()}
              hasOlder={hasOlder()}
              generation={selectionGeneration()}
              onLoadOlder={() => void loadOlder()}
              onReadArtifact={props.onReadArtifact}
            />
            <QueuePanel
              queued={selected().queuedInputs}
              onWithdraw={(submissionId) =>
                void props.actions.dispatch("submission.withdraw", { submissionId })
              }
            />
            <Composer
              draft={props.draft}
              activeRun={selected().activeRun}
              onDraft={props.onDraft}
              onSubmit={(text, mode) =>
                void props.actions.dispatch("submission.submit", {
                  conversationId: selected().conversation.id,
                  text,
                  mode,
                })
              }
            />
          </>
        )}
      </Show>
    </section>
  );
}

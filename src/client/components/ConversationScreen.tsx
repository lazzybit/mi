import { Show, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { OwnerSnapshot, TranscriptEntryView } from "../../shared/domain";
import type { ConnectionStatus } from "../sync/ConversationFeed";
import { Composer } from "./Composer";
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

  const entries = () => [...older(), ...(conversation()?.entries ?? [])];
  // Pagination advances from the oldest entry already loaded rather than
  // reusing the snapshot cursor, which would refetch the same page forever.
  const oldestSequence = () => older()[0]?.sequence ?? conversation()?.entries[0]?.sequence;
  const hasOlder = () => (oldestSequence() ?? 1) > 1;

  const loadOlder = async () => {
    const before = oldestSequence();
    if (!before || before <= 1) return;
    const page = await props.onHistory(before);
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

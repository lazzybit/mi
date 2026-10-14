import { For, Show, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { ConnectorView } from "../../shared/domain";
import { McpConnectionEditor } from "./McpConnectionEditor";

export function McpConnectionList(props: {
  connectors: ConnectorView[];
  dispatch: (kind: string, payload: unknown) => Promise<void>;
}): JSX.Element {
  const [editing, setEditing] = createSignal<string | "new">();
  const [report, setReport] = createSignal<string>();

  return (
    <div class="connector-list">
      <button class="primary touch" onClick={() => setEditing("new")}>
        Add connector
      </button>
      <Show when={editing()}>
        <McpConnectionEditor
          connector={
            editing() === "new"
              ? undefined
              : props.connectors.find((connector) => connector.id === editing())
          }
          onCancel={() => setEditing(undefined)}
          onSave={async (payload) => {
            await props.dispatch("connector.save", payload);
            setEditing(undefined);
          }}
        />
      </Show>
      <ul>
        <For each={props.connectors}>
          {(connector) => (
            <li class="connector-item">
              <div class="connector-summary">
                <span class="connector-name">{connector.name}</span>
                <span class={`connector-state ${connector.state}`}>{connector.state}</span>
                <span class="connector-tools">{connector.toolCount} tools</span>
              </div>
              <div class="connector-actions">
                <button class="link touch" onClick={() => setEditing(connector.id)}>
                  Edit
                </button>
                <button
                  class="link touch"
                  onClick={() =>
                    void props
                      .dispatch("connector.connect", { connectorId: connector.id })
                      .catch((error: Error) => setReport(error.message))
                  }
                >
                  Connect
                </button>
                <button
                  class="link touch"
                  onClick={() =>
                    void props.dispatch("connector.set_enabled", {
                      connectorId: connector.id,
                      enabled: connector.state !== "ready",
                    })
                  }
                >
                  Toggle
                </button>
              </div>
              <Show when={connector.lastError}>
                <div class="connector-error">{connector.lastError}</div>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <Show when={report()}>
        <p class="notice">{report()}</p>
      </Show>
    </div>
  );
}

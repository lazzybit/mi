import { createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { ConfigurationStatusView } from "../../shared/domain";
import { McpConnectionList } from "./McpConnectionList";
import { ModelSettingsForm } from "./ModelSettingsForm";
import { SkillList } from "./SkillList";

export function SettingsScreen(props: {
  configuration: ConfigurationStatusView;
  dispatch: (kind: string, payload: unknown) => Promise<unknown>;
}): JSX.Element {
  const [tab, setTab] = createSignal<"model" | "connectors" | "skills">("model");
  return (
    <section class="settings-screen">
      <nav class="tabs">
        <button class={`tab touch ${tab() === "model" ? "active" : ""}`} onClick={() => setTab("model")}>
          Model
        </button>
        <button
          class={`tab touch ${tab() === "connectors" ? "active" : ""}`}
          onClick={() => setTab("connectors")}
        >
          Connectors
        </button>
        <button class={`tab touch ${tab() === "skills" ? "active" : ""}`} onClick={() => setTab("skills")}>
          Skills
        </button>
      </nav>
      {tab() === "model" && (
        <ModelSettingsForm
          model={props.configuration.model}
          routes={props.configuration.routes}
          legacyModel={props.configuration.legacyModel}
          dispatch={props.dispatch}
        />
      )}
      {tab() === "connectors" && (
        <McpConnectionList connectors={props.configuration.connectors} dispatch={props.dispatch} />
      )}
      {tab() === "skills" && <SkillList skills={props.configuration.skills} dispatch={props.dispatch} />}
    </section>
  );
}

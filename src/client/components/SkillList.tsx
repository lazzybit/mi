import { For, Show, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { SkillView } from "../../shared/domain";
import { SkillEditor } from "./SkillEditor";

export function SkillList(props: {
  skills: SkillView[];
  dispatch: (kind: string, payload: unknown) => Promise<void>;
}): JSX.Element {
  const [editing, setEditing] = createSignal<string | "new">();
  return (
    <div class="skill-list">
      <button class="primary touch" onClick={() => setEditing("new")}>
        New skill
      </button>
      <Show when={editing()}>
        <SkillEditor
          skill={editing() === "new" ? undefined : props.skills.find((skill) => skill.id === editing())}
          onCancel={() => setEditing(undefined)}
          onSave={async (payload, skillId) => {
            await props.dispatch(skillId ? "skill.update" : "skill.create", payload);
            setEditing(undefined);
          }}
        />
      </Show>
      <ul>
        <For each={props.skills}>
          {(skill) => (
            <li class="skill-item">
              <div class="skill-summary">
                <span class="skill-name">{skill.name}</span>
                <span class="skill-version">v{skill.currentVersion}</span>
                <Show when={!skill.enabled}>
                  <span class="skill-disabled">disabled</span>
                </Show>
              </div>
              <p class="skill-description">{skill.description}</p>
              <div class="skill-actions">
                <button class="link touch" onClick={() => setEditing(skill.id)}>
                  Edit
                </button>
                <button
                  class="link touch"
                  onClick={() => void props.dispatch("skill.disable", { skillId: skill.id })}
                >
                  Disable
                </button>
                <button
                  class="link touch"
                  onClick={() => void props.dispatch("skill.remove", { skillId: skill.id })}
                >
                  Delete
                </button>
              </div>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

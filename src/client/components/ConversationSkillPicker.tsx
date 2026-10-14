import { For } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { SkillView } from "../../shared/domain";

export function ConversationSkillPicker(props: {
  skills: SkillView[];
  selected: string[];
  onChange: (skillIds: string[]) => void;
}): JSX.Element {
  const toggle = (skillId: string) => {
    const next = props.selected.includes(skillId)
      ? props.selected.filter((id) => id !== skillId)
      : [...props.selected, skillId];
    props.onChange(next);
  };
  return (
    <div class="skill-picker">
      <For each={props.skills}>
        {(skill) => (
          <label class="skill-option">
            <input
              type="checkbox"
              checked={props.selected.includes(skill.id)}
              onChange={() => toggle(skill.id)}
            />
            {skill.name}
          </label>
        )}
      </For>
    </div>
  );
}

import { createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { SkillView } from "../../shared/domain";

export function SkillEditor(props: {
  skill?: SkillView;
  onSave: (payload: unknown, skillId?: string) => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const [name, setName] = createSignal(props.skill?.name ?? "");
  const [description, setDescription] = createSignal(props.skill?.description ?? "");
  const [instructions, setInstructions] = createSignal("");

  return (
    <form
      class="skill-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void props.onSave(
          {
            skillId: props.skill?.id,
            name: name(),
            description: description(),
            instructions: instructions(),
          },
          props.skill?.id,
        );
      }}
    >
      <label>
        Name
        <input value={name()} onInput={(event) => setName(event.currentTarget.value)} />
      </label>
      <label>
        Description
        <input value={description()} onInput={(event) => setDescription(event.currentTarget.value)} />
      </label>
      <label>
        Instructions
        <textarea
          rows={8}
          value={instructions()}
          onInput={(event) => setInstructions(event.currentTarget.value)}
        />
      </label>
      <div class="editor-actions">
        <button class="primary touch" type="submit">
          Save version
        </button>
        <button class="secondary touch" type="button" onClick={() => props.onCancel()}>
          Cancel
        </button>
      </div>
    </form>
  );
}

import { createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { ModelProfileView } from "../../shared/domain";

export function ModelSettingsForm(props: {
  model?: ModelProfileView;
  dispatch: (kind: string, payload: unknown) => Promise<unknown>;
}): JSX.Element {
  const [gatewayId, setGatewayId] = createSignal(props.model?.gatewayId ?? "default");
  const [provider, setProvider] = createSignal(props.model?.provider ?? "openai");
  const [model, setModel] = createSignal(props.model?.model ?? "gpt-4.1-mini");
  const [protocol, setProtocol] = createSignal<ModelProfileView["protocol"]>(
    props.model?.protocol ?? "openai-chat-completions",
  );
  const [contextWindow, setContextWindow] = createSignal(props.model?.contextWindow ?? 128_000);
  const [maxOutputTokens, setMaxOutputTokens] = createSignal(props.model?.maxOutputTokens ?? 4_096);
  const [saved, setSaved] = createSignal(false);

  return (
    <form
      class="settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        void props
          .dispatch("settings.save_model_profile", {
            profile: {
              gatewayId: gatewayId(),
              provider: provider(),
              model: model(),
              protocol: protocol(),
              contextWindow: contextWindow(),
              maxOutputTokens: maxOutputTokens(),
            },
          })
          .then(() => setSaved(true));
      }}
    >
      <label>
        Gateway id
        <input value={gatewayId()} onInput={(event) => setGatewayId(event.currentTarget.value)} />
      </label>
      <label>
        Provider
        <input value={provider()} onInput={(event) => setProvider(event.currentTarget.value)} />
      </label>
      <label>
        Model
        <input value={model()} onInput={(event) => setModel(event.currentTarget.value)} />
      </label>
      <label>
        Protocol
        <select
          value={protocol()}
          onChange={(event) => setProtocol(event.currentTarget.value as ModelProfileView["protocol"])}
        >
          <option value="openai-responses">OpenAI Responses</option>
          <option value="openai-chat-completions">OpenAI Chat Completions</option>
          <option value="anthropic-messages">Anthropic Messages</option>
        </select>
      </label>
      <label>
        Context window
        <input
          type="number"
          value={contextWindow()}
          onInput={(event) => setContextWindow(Number(event.currentTarget.value))}
        />
      </label>
      <label>
        Max output tokens
        <input
          type="number"
          value={maxOutputTokens()}
          onInput={(event) => setMaxOutputTokens(Number(event.currentTarget.value))}
        />
      </label>
      <button class="primary touch" type="submit">
        Save model settings
      </button>
      {saved() && <span class="saved">Saved</span>}
    </form>
  );
}

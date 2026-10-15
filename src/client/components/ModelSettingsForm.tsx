// ADR-0002: model setup selects an application-configured route. Provider
// protocols, model ids, context windows, and output limits are resolved
// server-side from the catalog; the form never asks for them.

import { createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { ModelRouteView, ModelSettingsView } from "../../shared/domain";

export function ModelSettingsForm(props: {
  model?: ModelSettingsView;
  routes: ModelRouteView[];
  legacyModel?: ModelSettingsFormLegacy;
  dispatch: (kind: string, payload: unknown) => Promise<unknown>;
}): JSX.Element {
  const initial = props.model;
  const [gatewayId, setGatewayId] = createSignal(initial?.gatewayId ?? "mi");
  const [routeId, setRouteId] = createSignal(initial?.routeId ?? props.routes[0]?.routeId ?? "");
  const [thinkingLevel, setThinkingLevel] = createSignal(initial?.thinkingLevel ?? "");
  const [saved, setSaved] = createSignal(false);

  const selected = () => props.routes.find((route) => route.routeId === routeId());

  return (
    <form
      class="settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        const level = thinkingLevel();
        void props
          .dispatch("settings.save_model_profile", {
            settings: {
              gatewayId: gatewayId(),
              routeId: routeId(),
              thinkingLevel: level === "" ? undefined : level,
            },
          })
          .then(() => setSaved(true));
      }}
    >
      <Show when={props.legacyModel}>
        <p class="settings-notice">
          A historical concrete model profile is stored. Saving route settings below replaces it
          for new requests; historical requests keep their frozen configuration.
        </p>
      </Show>
      <label>
        Gateway id
        <input value={gatewayId()} onInput={(event) => setGatewayId(event.currentTarget.value)} />
      </label>
      <label>
        Model route
        <select value={routeId()} onChange={(event) => setRouteId(event.currentTarget.value)}>
          <For each={props.routes}>
            {(route) => <option value={route.routeId}>{`${route.label} (${route.routeId})`}</option>}
          </For>
        </select>
      </label>
      <Show when={selected()}>
        <p class="settings-note">
          {(selected() as ModelRouteView).label} — context window{" "}
          {(selected() as ModelRouteView).contextWindow.toLocaleString()} tokens
        </p>
      </Show>
      <Show when={selected()?.thinkingLevels.length}>
        <label>
          Thinking level
          <select
            value={thinkingLevel()}
            onChange={(event) => setThinkingLevel(event.currentTarget.value)}
          >
            <option value="">Default</option>
            <For each={selected()?.thinkingLevels ?? []}>
              {(level) => <option value={level}>{level}</option>}
            </For>
          </select>
        </label>
      </Show>
      <button class="primary touch" type="submit">
        Save model settings
      </button>
      {saved() && <span class="saved">Saved</span>}
    </form>
  );
}

/** Historical concrete profile shape, displayed read-only (ADR-0002). */
export interface ModelSettingsFormLegacy {
  gatewayId: string;
  provider: string;
  model: string;
  protocol: string;
  contextWindow: number;
  maxOutputTokens: number;
}

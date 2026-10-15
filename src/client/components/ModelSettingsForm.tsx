// ADR-0002: model setup selects an application-configured route. Provider
// protocols, model ids, context windows, and output limits are resolved
// server-side from the catalog; the form never asks for them.

import { createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { ModelRouteView, ModelSettingsView, RouteSettingsInput } from "../../shared/domain";

export function ModelSettingsForm(props: {
  model?: ModelSettingsView;
  routes: ModelRouteView[];
  onSave: (settings: RouteSettingsInput) => Promise<ModelSettingsView | undefined>;
}): JSX.Element {
  const initial = props.model;
  const [gatewayId, setGatewayId] = createSignal(initial?.gatewayId ?? "mi");
  const [routeId, setRouteId] = createSignal(initial?.routeId ?? props.routes[0]?.routeId ?? "");
  const [thinkingLevel, setThinkingLevel] = createSignal(initial?.thinkingLevel ?? "");
  const [saved, setSaved] = createSignal(false);
  const [error, setError] = createSignal<string>();

  const selected = () => props.routes.find((route) => route.routeId === routeId());

  const save = async () => {
    setError(undefined);
    setSaved(false);
    try {
      const level = thinkingLevel();
      const settings: RouteSettingsInput = { gatewayId: gatewayId(), routeId: routeId() };
      // The server-function codec rejects `undefined` members, so omit unset fields.
      if (level !== "") settings.thinkingLevel = level;
      await props.onSave(settings);
      setSaved(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "settings could not be saved");
    }
  };

  return (
    <form
      class="settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
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
        {(route) => (
          <p class="settings-note">
            {route().label} — context window {route().contextWindow.toLocaleString()} tokens
          </p>
        )}
      </Show>
      <Show when={(selected()?.thinkingLevels.length ?? 0) > 0}>
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
      {error() && <p class="inline-error">{error()}</p>}
    </form>
  );
}

import { createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { ConnectorAuthMode, ConnectorView } from "../../shared/domain";

export function McpConnectionEditor(props: {
  connector?: ConnectorView;
  onSave: (payload: unknown) => Promise<unknown>;
  onCancel: () => void;
}): JSX.Element {
  const [name, setName] = createSignal(props.connector?.name ?? "");
  const [endpoint, setEndpoint] = createSignal(props.connector?.endpoint ?? "");
  const [authMode, setAuthMode] = createSignal<ConnectorAuthMode>(props.connector?.authMode ?? "auto");
  const [role, setRole] = createSignal<"" | "container" | "web-research">(props.connector?.role ?? "");
  const [headerName, setHeaderName] = createSignal("");
  const [headerValue, setHeaderValue] = createSignal("");
  const [trustedOrigin, setTrustedOrigin] = createSignal("");

  return (
    <form
      class="connector-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void props.onSave({
          connectorId: props.connector?.id,
          name: name(),
          endpoint: endpoint(),
          authMode: authMode(),
          role: role() || undefined,
          headerName: authMode() === "header" ? headerName() : undefined,
          headerValue: authMode() === "header" ? headerValue() : undefined,
          trustedOrigin: authMode() === "cf-access" ? trustedOrigin() : undefined,
        });
      }}
    >
      <label>
        Name
        <input value={name()} onInput={(event) => setName(event.currentTarget.value)} />
      </label>
      <label>
        Endpoint
        <input value={endpoint()} onInput={(event) => setEndpoint(event.currentTarget.value)} />
      </label>
      <label>
        Authentication
        <select
          value={authMode()}
          onChange={(event) => setAuthMode(event.currentTarget.value as ConnectorAuthMode)}
        >
          <option value="auto">Auto</option>
          <option value="none">None</option>
          <option value="oauth">OAuth</option>
          <option value="header">Header</option>
          <option value="cf-access">Cloudflare Access delegation</option>
        </select>
      </label>
      <label>
        Role
        <select
          value={role()}
          onChange={(event) => setRole(event.currentTarget.value as "" | "container" | "web-research")}
        >
          <option value="">Unspecified</option>
          <option value="container">Container</option>
          <option value="web-research">Web research</option>
        </select>
      </label>
      {authMode() === "header" && (
        <>
          <label>
            Header name
            <input value={headerName()} onInput={(event) => setHeaderName(event.currentTarget.value)} />
          </label>
          <label>
            Header value
            <input
              type="password"
              value={headerValue()}
              onInput={(event) => setHeaderValue(event.currentTarget.value)}
            />
          </label>
        </>
      )}
      {authMode() === "cf-access" && (
        <label>
          Trusted origin
          <input value={trustedOrigin()} onInput={(event) => setTrustedOrigin(event.currentTarget.value)} />
        </label>
      )}
      <div class="editor-actions">
        <button class="primary touch" type="submit">
          Save
        </button>
        <button class="secondary touch" type="button" onClick={() => props.onCancel()}>
          Cancel
        </button>
      </div>
    </form>
  );
}

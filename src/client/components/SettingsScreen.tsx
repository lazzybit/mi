import type { JSX } from "@solidjs/web";
import type { CatalogView } from "../../shared/domain";
import { ModelSettingsForm } from "./ModelSettingsForm";
import type { AppActions } from "./types";

export function SettingsScreen(props: { catalog: CatalogView; actions: AppActions }): JSX.Element {
  return (
    <section class="settings-screen">
      <ModelSettingsForm
        model={props.catalog.model}
        routes={props.catalog.routes}
        onSave={(settings) => props.actions.saveModelProfile(settings)}
      />
    </section>
  );
}

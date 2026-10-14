
import type { JSX } from "@solidjs/web";

// Dynamic viewport height and safe-area padding for mobile (PLAN.md -> Client).
export function AppShell(props: { children: JSX.Element }): JSX.Element {
  return <div class="app-shell">{props.children}</div>;
}

// Request-local values attached by the authentication middleware. We keep a
// local interface and cast rather than augmenting `@solidjs/web`, because an
// ambient `declare module` in a script `.d.ts` would shadow the package's own
// types.

import type { OwnerIdentity } from "../../shared/domain";

export interface OwnerLocals {
  owner?: OwnerIdentity;
  accessExpiresAt?: number;
  accessAssertion?: string;
}

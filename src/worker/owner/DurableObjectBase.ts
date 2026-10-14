/**
 * Minimal base for a Durable Object that does not import `cloudflare:workers`
 * at runtime.
 *
 * The Workers runtime constructs a Durable Object class with `(ctx, env)`, and
 * extending `DurableObject` from `cloudflare:workers` only adds typed `ctx`/`env`
 * fields. We avoid that import deliberately: the Solid plugin's client-mode
 * build prerenders the shell by importing the built server bundle in Node, and
 * a top-level `cloudflare:workers` import would make that Node import fail with
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME`. Keeping the runtime import out of the graph
 * lets the same Worker entry serve the Solid handler and export the Durable
 * Object class.
 */
export abstract class DurableObjectBase<EnvType = Env> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: EnvType;

  constructor(ctx: DurableObjectState, env: EnvType) {
    this.ctx = ctx;
    this.env = env;
  }
}

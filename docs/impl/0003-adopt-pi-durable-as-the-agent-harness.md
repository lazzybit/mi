# Impl-0003: Adopt pi-durable as the agent harness

- Created Date: 2026-10-16

## Commits

Implementation commit on `adr-0003`:

- `5c300d2` replace the custom execution engine with pi-durable

The earlier branch commits in this set were squashed into `5c300d2` when the
branch history was cleaned up; the tree is unchanged. The hash identifies the
verified implementation commit on the branch, not a target-branch commit. The
PR is not merged.

## Result

The custom execution engine, its storage, projections, command framework, and
peripherals are removed. The application is a thin Worker that manages
owner-scoped conversations and coordinates model access.

Implemented:

- One SQLite-backed `SessionObject` per managed conversation over
  `openDurableObjectSqliteStorage(ctx.storage)` and `Harness.open`. The session
  owns provisioning, `resume()`, the Chord view socket, and
  submission/withdrawal/cancellation/history control frames.
- A stateless Worker with a D1 catalog (`conversations`, `settings`, creation
  receipts in `commands`) and an authenticated session route. `OwnerObject`,
  `OwnerRuntime`, and the owner RPC are gone.
- Model generation through a pi-ai gateway provider registered per session
  (`getModel("gateway", "dynamic/runner")`). Gateway `mi`, the
  `deepseek/deepseek-flash` catalog lookup, `openai-completions`, suppressed
  provider credentials, and the fixture transport are preserved. Saved settings
  are re-applied at the next request boundary, and `maxOutputTokens` is bounded
  by the catalog limit.
- A client that fetches the catalog over HTTP and observes the selected
  conversation over a Chord view socket, applying exact operation batches with
  `applyImmutable`. Drafts, inline rename, deletion confirmation, model
  settings, and the mobile layout are retained.
- Deleted: `RunDriver`, `RunMachine`, `AttemptExecutor`, `RecoveryService`,
  `RetryBookkeeping`, `OutputCommitter`, `WakeScheduler`, `TransitionCoordinator`,
  `ToolPolicy`, `ContextAssembler`, `ContextBudget`, `SyncHub`, the execution
  storage and repositories, the MCP stack, skills, and their suites.

Verification (all run at `5c300d2`):

- `npm run typecheck` — passed.
- `npm run test:unit` — 13 passed.
- `npm run test:workers` — 29 passed. These run the built
  `dist/server/server.js` under workerd through `vitest-pool-workers` and cover
  the real harness, Cloudflare SQLite storage, D1 catalog, provisioning,
  concurrent create, `creating` recovery, duplicate deletion, closure-failure
  retry, a delayed open racing deletion, session settings applied to an outgoing
  provider request, seeded multi-page history, and a malformed session address.
- `npm run test:e2e` — 38 passed (narrow and wide), exit status 0. Coverage
  includes chat generation through the built Worker, follow-up queueing, a real
  object eviction with reconnect-resume (the instance id changes, the alarm is
  null, and the committed input is not duplicated), an unacknowledged
  submission, a lost submission acknowledgement recovered with the same request
  id, conversation switching, catalog refresh on focus, and socket expiry.
- `wrangler deploy --dry-run` — succeeded. The emitted server bundle contains
  only the `openai-completions` provider chunk plus shared/runtime chunks. A scan
  of every emitted server chunk found no codemode, Photon/image processing, Node
  environment, `tool-search`, or JSONL storage module. The `/images/*` and
  `agents-api/tools/*` strings that remain belong to the bundled OpenAI SDK, not
  to the pi-durable extensions.
- Migration: an isolated non-production Worker (`mi-adr0003-check`, workers.dev,
  no production route) was deployed with a `v1` `OwnerObject` fixture, then with
  the built `v2` artifact declaring
  `deleted_classes: ["OwnerObject"]` and
  `new_sqlite_classes: ["SessionObject"]`. Cloudflare accepted the migration.
  The temporary Worker and D1 database were deleted afterwards.
- Production D1: database `mi` (`325930a8-ff96-403b-8f62-00302d6e7fcc`) was
  created and bound as `DB` in `wrangler.jsonc`.

Inventory, using the same `find … \( -name '*.ts' -o -name '*.tsx' \)` filter at
the baseline and now:

| | Baseline `7b415aa` | Now |
|---|---|---|
| `src` lines / files | 13,211 / 97 | 3,687 / 36 |
| `tests` lines / files | 4,478 / 32 | 1,519 / 16 |

## Deviations

- **Creation order (clarified in PLAN-0003).** The approved plan said "insert a
  `creating` row and a creation receipt in one batch, initialize the session,
  then set `active`." The session refuses to provision a row that is not
  `active`, so the implementation activates conditionally before explicit
  provisioning: `creating + receipt → conditional activation → provisioning`.
  An `active` row without an initialized session rejects ordinary access with a
  retryable `NOT_READY` and is recovered only by retrying the create.
- **Deletion of an absent row.** PLAN-0003 says "A missing row means the deletion
  already completed." The implementation therefore resolves deletion of an
  unknown conversation successfully rather than `NOT_FOUND`. This re-expresses
  ADR-0001's older deletion contract for the storage-lifecycle model; the
  receipt-based replay guard for accepted deletes is not carried forward.
- **Receipts only for creation.** Rename, delete, and settings are direct
  owner-scoped operations. Only `conversation.create` writes a receipt, matching
  PLAN-0003's `commands` table purpose and the decision not to carry forward the
  command framework.
- **Settings applied at the request boundary.** The harness holds its `Models`
  collection for the life of an open session. A saved setting re-registers the
  gateway provider and reconfigures the conversation agent before the next
  submission, and the persisted agent is reconciled with current settings before
  `resume()`. An in-flight request keeps the model it was prepared with.
- **Fixture-only routes.** `/__fixture/evict`, `/__fixture/state`, and
  `/__fixture/seed` exist only when `MI_FIXTURE_MODEL_URL` is configured. They
  are authenticated like `/ws` and are used by the browser and workerd suites.
- **Solid module marker.** The Worker entry keeps the `$$moduleUrl` marker in a
  comment, as at the baseline, so the Solid SSR transform does not append a
  non-function export that workerd rejects.

## Follow-ups

- Unattended session recovery: committed work resumes on the next request or
  reconnect, and no alarm is scheduled. Completion after an object restart
  without further requests is not guaranteed. Recorded in `docs/TODO.md`.
- Skills, application tools, MCP connectors, credentials, OAuth, and repository
  instructions are deferred and recorded in `docs/TODO.md`.
- The deployed migration check did not seed legacy `OwnerObject` storage or
  provision a session through the deployed `SessionObject`; provisioning through
  the built artifact is covered by the workerd suite instead. A full
  legacy-storage retirement check on a disposable namespace remains.
- Production Worker deployment and PR merge require explicit authorization and
  are not part of this report.

# TODO

## Reintroduce skills, application tools, and MCP connectors

Status: Deferred from the initial pi-durable rollout.

Related documents:

- [ADR-0003](adr/0003-adopt-pi-durable-as-the-agent-harness.md)
- [PLAN-0003](plan/0003-adopt-pi-durable-as-the-agent-harness.md)

The initial rollout keeps only authenticated conversation management, model
chat, and streaming. Skills, application tools, MCP connectors, credentials,
OAuth, and repository instructions are removed with the old owner object and
must be rebuilt on the pi-durable harness.

Future user needs:

- Select reusable instructions for a conversation and let the model read them.
- Connect remote MCP servers and expose their tools to the model.
- Read repository instructions through a container connector.

Integration boundaries to design before implementing:

- Owner-scoped storage for skills, skill resources, connector configuration,
  and credentials, without restoring the retired execution storage.
- Upstream extension and prompt-section registration for selected skills and
  repository instructions.
- Upstream tool registration for MCP tools, with credential handling at the
  owner boundary and an explicit replay policy per tool.
- A credential and OAuth callback path that does not reintroduce an owner
  execution object.

## Unattended session recovery

Status: Deferred from ADR-0003.

Committed work resumes on the next authenticated session request or reconnect.
No alarm or other host wake mechanism is scheduled, so completion after an
object restart without further requests is not guaranteed. Any unattended
recovery mechanism requires a separate design.

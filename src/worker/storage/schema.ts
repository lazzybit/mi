// SQLite schema (PLAN.md -> Persistence and scheduling -> Stored records).
// `migrate()` is idempotent; `SCHEMA_VERSION` is bumped when the shape changes.

export const SCHEMA_VERSION = 2;

export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS owner_state (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     revision INTEGER NOT NULL DEFAULT 0,
     schema_version INTEGER NOT NULL DEFAULT 0,
     driver_generation INTEGER NOT NULL DEFAULT 0
   )`,

  `CREATE TABLE IF NOT EXISTS command_receipts (
     command_id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     payload_hash TEXT NOT NULL,
     result_json TEXT NOT NULL,
     revision INTEGER NOT NULL,
     outcome TEXT NOT NULL DEFAULT 'accepted',
     created_at INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS settings (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     model_profile_json TEXT,
     workspace_root TEXT,
     settings_version INTEGER NOT NULL DEFAULT 0
   )`,

  `CREATE TABLE IF NOT EXISTS conversations (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     selected_profile TEXT,
     workspace_config TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS submissions (
     id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL,
     command_id TEXT NOT NULL UNIQUE,
     mode TEXT NOT NULL,
     owner_sequence INTEGER NOT NULL,
     content TEXT NOT NULL,
     state TEXT NOT NULL,
     run_id TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS submissions_queue ON submissions (state, owner_sequence)`,

  `CREATE TABLE IF NOT EXISTS runs (
     id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL,
     state TEXT NOT NULL,
     phase TEXT NOT NULL,
     checkpoint_json TEXT NOT NULL,
     generation INTEGER NOT NULL,
     cancel_requested_at INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS runs_active ON runs (state, updated_at)`,

  `CREATE TABLE IF NOT EXISTS attempts (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL,
     conversation_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     state TEXT NOT NULL,
     generation INTEGER NOT NULL,
     request_artifact_id TEXT,
     result_artifact_id TEXT,
     replay_policy TEXT NOT NULL,
     connector_id TEXT,
     connector_version INTEGER,
     catalog_version INTEGER,
     tool_name TEXT,
     remote_name TEXT,
     tool_call_id TEXT,
     parent_attempt_id TEXT,
     uncertainty_json TEXT,
     error_code TEXT,
     error_message TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS attempts_run ON attempts (run_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS attempts_state ON attempts (state)`,

  `CREATE TABLE IF NOT EXISTS entries (
     id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL,
     sequence INTEGER NOT NULL,
     kind TEXT NOT NULL,
     attempt_id TEXT,
     text TEXT,
     artifact_id TEXT,
     tool_name TEXT,
     tool_call_id TEXT,
     is_error INTEGER NOT NULL DEFAULT 0,
     metadata_json TEXT,
     created_at INTEGER NOT NULL,
     UNIQUE (conversation_id, sequence)
   )`,
  `CREATE INDEX IF NOT EXISTS entries_conversation ON entries (conversation_id, sequence)`,

  `CREATE TABLE IF NOT EXISTS live_output (
     attempt_id TEXT PRIMARY KEY,
     content TEXT NOT NULL DEFAULT '',
     output_revision INTEGER NOT NULL DEFAULT 0
   )`,

  `CREATE TABLE IF NOT EXISTS artifacts (
     id TEXT PRIMARY KEY,
     mime_type TEXT NOT NULL,
     encoding TEXT NOT NULL,
     byte_count INTEGER NOT NULL DEFAULT 0,
     digest TEXT,
     complete INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS artifact_chunks (
     artifact_id TEXT NOT NULL,
     ordinal INTEGER NOT NULL,
     data TEXT NOT NULL,
     PRIMARY KEY (artifact_id, ordinal)
   )`,

  `CREATE TABLE IF NOT EXISTS mcp_servers (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     endpoint TEXT NOT NULL,
     configuration_version INTEGER NOT NULL,
     authentication_mode TEXT NOT NULL,
     role TEXT,
     state TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     discovery_json TEXT,
     header_name TEXT,
     trusted_origin TEXT,
     credential_id TEXT,
     last_error TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS mcp_tools (
     connector_id TEXT NOT NULL,
     tool_name TEXT NOT NULL,
     catalog_version INTEGER NOT NULL,
     alias TEXT NOT NULL,
     description TEXT NOT NULL,
     input_schema_json TEXT NOT NULL,
     output_schema_json TEXT,
     annotations_json TEXT,
     available INTEGER NOT NULL DEFAULT 1,
     PRIMARY KEY (connector_id, tool_name, catalog_version)
   )`,
  `CREATE INDEX IF NOT EXISTS mcp_tools_alias ON mcp_tools (alias)`,

  `CREATE TABLE IF NOT EXISTS credentials (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     connector_id TEXT,
     owner_key TEXT,
     value TEXT NOT NULL,
     expires_at INTEGER,
     version INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS credentials_connector ON credentials (connector_id)`,

  `CREATE TABLE IF NOT EXISTS oauth_transactions (
     id TEXT PRIMARY KEY,
     state_digest TEXT NOT NULL,
     connector_id TEXT NOT NULL,
     owner_key TEXT NOT NULL,
     pkce_verifier TEXT NOT NULL,
     issuer TEXT NOT NULL,
     redirect_uri TEXT NOT NULL,
     expires_at INTEGER NOT NULL,
     exchange_state TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS oauth_state ON oauth_transactions (state_digest)`,

  `CREATE TABLE IF NOT EXISTS skills (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     description TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     deleted INTEGER NOT NULL DEFAULT 0,
     current_version INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS skill_versions (
     skill_id TEXT NOT NULL,
     version INTEGER NOT NULL,
     name TEXT NOT NULL,
     description TEXT NOT NULL,
     instructions TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (skill_id, version)
   )`,

  `CREATE TABLE IF NOT EXISTS skill_resources (
     skill_id TEXT NOT NULL,
     version INTEGER NOT NULL,
     path TEXT NOT NULL,
     media_type TEXT NOT NULL,
     artifact_id TEXT NOT NULL,
     PRIMARY KEY (skill_id, version, path)
   )`,

  `CREATE TABLE IF NOT EXISTS conversation_skills (
     conversation_id TEXT NOT NULL,
     skill_id TEXT NOT NULL,
     follow_current INTEGER NOT NULL DEFAULT 1,
     PRIMARY KEY (conversation_id, skill_id)
   )`,

  `CREATE TABLE IF NOT EXISTS context_snapshots (
     id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL,
     run_id TEXT NOT NULL,
     turn_number INTEGER NOT NULL,
     model_profile_json TEXT NOT NULL,
     skill_versions_json TEXT NOT NULL,
     tool_catalog_json TEXT NOT NULL,
     system_sections_json TEXT NOT NULL,
     history_first INTEGER NOT NULL,
     history_last INTEGER NOT NULL,
     summary_entry_id TEXT,
     digest TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS attempt_resolutions (
     id TEXT PRIMARY KEY,
     attempt_id TEXT NOT NULL,
     action TEXT NOT NULL,
     explanation TEXT NOT NULL,
     evidence_json TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS repository_instructions (
     id TEXT PRIMARY KEY,
     workspace_root TEXT NOT NULL,
     path TEXT NOT NULL,
     directory TEXT NOT NULL,
     artifact_id TEXT NOT NULL,
     digest TEXT NOT NULL,
     present INTEGER NOT NULL DEFAULT 1,
     fetched_at INTEGER NOT NULL,
     UNIQUE (workspace_root, path)
   )`,
];

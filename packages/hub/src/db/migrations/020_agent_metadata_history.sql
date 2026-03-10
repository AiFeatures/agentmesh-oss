CREATE TABLE IF NOT EXISTS agent_metadata_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  metadata TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_metadata_history_agent ON agent_metadata_history(agent_id, workspace_id);

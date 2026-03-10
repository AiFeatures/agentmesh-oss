CREATE TABLE IF NOT EXISTS metrics_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  agent_count INTEGER NOT NULL DEFAULT 0,
  active_claims INTEGER NOT NULL DEFAULT 0,
  pending_handoffs INTEGER NOT NULL DEFAULT 0,
  open_blockers INTEGER NOT NULL DEFAULT 0,
  snapshot_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_metrics_history_ws ON metrics_history(workspace_id, snapshot_at);

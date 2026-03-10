CREATE TABLE IF NOT EXISTS blocker_watchers (
  blocker_id TEXT NOT NULL REFERENCES blockers(blocker_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (blocker_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_blocker_watchers_blocker ON blocker_watchers(blocker_id);

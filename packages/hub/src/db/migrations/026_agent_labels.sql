CREATE TABLE IF NOT EXISTS agent_labels (
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  label_key TEXT NOT NULL,
  label_value TEXT NOT NULL,
  PRIMARY KEY (agent_id, label_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_labels_key ON agent_labels(label_key, label_value);

CREATE TABLE IF NOT EXISTS claim_transfer_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_claim_transfer_history_claim ON claim_transfer_history(claim_id);

CREATE TABLE IF NOT EXISTS claim_scope_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  old_scope TEXT NOT NULL,
  new_scope TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_claim_scope_history_claim ON claim_scope_history(claim_id);

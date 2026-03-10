CREATE TABLE IF NOT EXISTS claim_renewal_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  renewed_by TEXT NOT NULL,
  old_expires_at DATETIME NOT NULL,
  new_expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_claim_renewal_history_claim ON claim_renewal_history(claim_id);

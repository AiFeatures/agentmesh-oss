CREATE TABLE IF NOT EXISTS handoff_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handoff_id TEXT NOT NULL REFERENCES handoffs(handoff_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_handoff_notes_handoff ON handoff_notes(handoff_id);

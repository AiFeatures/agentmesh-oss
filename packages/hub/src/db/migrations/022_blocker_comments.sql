CREATE TABLE IF NOT EXISTS blocker_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blocker_id TEXT NOT NULL REFERENCES blockers(blocker_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_blocker_comments_blocker ON blocker_comments(blocker_id);

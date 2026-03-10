CREATE TABLE IF NOT EXISTS blocker_dependencies (
  blocker_id TEXT NOT NULL REFERENCES blockers(blocker_id) ON DELETE CASCADE,
  depends_on_blocker_id TEXT NOT NULL REFERENCES blockers(blocker_id) ON DELETE CASCADE,
  PRIMARY KEY (blocker_id, depends_on_blocker_id)
);

CREATE INDEX IF NOT EXISTS idx_blocker_deps_blocker ON blocker_dependencies(blocker_id);

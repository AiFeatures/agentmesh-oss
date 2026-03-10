CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_paths_unique ON claim_paths(claim_id, path_pattern);
CREATE INDEX IF NOT EXISTS idx_blockers_deadline ON blockers(deadline_at) WHERE deadline_at IS NOT NULL;

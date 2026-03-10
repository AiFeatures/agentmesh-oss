CREATE TABLE IF NOT EXISTS claim_dependencies (
  claim_id TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
  depends_on_claim_id TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
  PRIMARY KEY (claim_id, depends_on_claim_id)
);

CREATE INDEX IF NOT EXISTS idx_claim_deps_claim ON claim_dependencies(claim_id);
CREATE INDEX IF NOT EXISTS idx_claim_deps_dep ON claim_dependencies(depends_on_claim_id);

-- Add 'cancelled' to handoff status enum.
-- SQLite doesn't support ALTER COLUMN, so we recreate the table.

CREATE TABLE IF NOT EXISTS handoffs_new (
  handoff_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT,
  route_mode TEXT NOT NULL DEFAULT 'direct',
  capability_tag TEXT,
  summary TEXT NOT NULL,
  context TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  timeout_seconds INTEGER,
  expires_at DATETIME,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 0,
  parent_handoff_id TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  sla_deadline DATETIME
);

INSERT OR IGNORE INTO handoffs_new
  SELECT handoff_id, workspace_id, from_agent_id, to_agent_id, route_mode,
         capability_tag, summary, context, status, created_at, updated_at,
         timeout_seconds, expires_at, retry_count, max_retries,
         parent_handoff_id, priority, sla_deadline
  FROM handoffs;

DROP TABLE IF EXISTS handoffs;
ALTER TABLE handoffs_new RENAME TO handoffs;

CREATE INDEX IF NOT EXISTS idx_handoffs_workspace_status ON handoffs(workspace_id, status);

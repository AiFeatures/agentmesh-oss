ALTER TABLE handoffs ADD COLUMN parent_handoff_id TEXT REFERENCES handoffs(handoff_id);

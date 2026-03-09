ALTER TABLE handoffs ADD COLUMN timeout_seconds INTEGER;
ALTER TABLE handoffs ADD COLUMN expires_at DATETIME;

import { db } from "../db/index.js";

export function runPresenceSweep(): { stale: string[]; evicted: string[] } {
  const staleRows = db
    .prepare(
      `
        SELECT agent_id FROM agents
        WHERE status IN ('online', 'idle')
          AND last_heartbeat_at <= datetime('now', '-45 seconds')
      `,
    )
    .all() as Array<{ agent_id: string }>;

  const evictedRows = db
    .prepare(
      `
        SELECT agent_id FROM agents
        WHERE status = 'stale'
          AND last_heartbeat_at <= datetime('now', '-120 seconds')
      `,
    )
    .all() as Array<{ agent_id: string }>;

  db.prepare(
    `
      UPDATE agents SET status = 'stale', updated_at = CURRENT_TIMESTAMP
      WHERE status IN ('online', 'idle')
        AND last_heartbeat_at <= datetime('now', '-45 seconds')
    `,
  ).run();

  db.prepare(
    `
      UPDATE agents SET status = 'evicted', updated_at = CURRENT_TIMESTAMP
      WHERE status = 'stale'
        AND last_heartbeat_at <= datetime('now', '-120 seconds')
    `,
  ).run();

  return {
    stale: staleRows.map((row) => row.agent_id),
    evicted: evictedRows.map((row) => row.agent_id),
  };
}

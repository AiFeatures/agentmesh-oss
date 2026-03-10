import { db } from "../db/index.js";

const STALE_THRESHOLD_SEC = Number(process.env.AGENTMESH_STALE_THRESHOLD_SEC) || 45;
const EVICT_THRESHOLD_SEC = Number(process.env.AGENTMESH_EVICT_THRESHOLD_SEC) || 120;

export function runPresenceSweep(): { stale: string[]; evicted: string[] } {
  const staleInterval = `-${STALE_THRESHOLD_SEC} seconds`;
  const evictInterval = `-${EVICT_THRESHOLD_SEC} seconds`;

  const sweep = db.transaction(() => {
    const staleRows = db
      .prepare(
        `
          SELECT agent_id FROM agents
          WHERE status IN ('online', 'idle')
            AND last_heartbeat_at <= datetime('now', ?)
        `,
      )
      .all(staleInterval) as Array<{ agent_id: string }>;

    const evictedRows = db
      .prepare(
        `
          SELECT agent_id FROM agents
          WHERE status = 'stale'
            AND last_heartbeat_at <= datetime('now', ?)
        `,
      )
      .all(evictInterval) as Array<{ agent_id: string }>;

    db.prepare(
      `
        UPDATE agents SET status = 'stale', updated_at = CURRENT_TIMESTAMP
        WHERE status IN ('online', 'idle')
          AND last_heartbeat_at <= datetime('now', ?)
      `,
    ).run(staleInterval);

    db.prepare(
      `
        UPDATE agents SET status = 'evicted', updated_at = CURRENT_TIMESTAMP
        WHERE status = 'stale'
          AND last_heartbeat_at <= datetime('now', ?)
      `,
    ).run(evictInterval);

    return {
      stale: staleRows.map((row) => row.agent_id),
      evicted: evictedRows.map((row) => row.agent_id),
    };
  });

  return sweep();
}

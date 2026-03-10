import { db } from "../db/index.js";

const DEFAULT_RETENTION_DAYS = 90;

export function purgeOldAuditLogs(): number {
  const days = Number(process.env.AGENTMESH_AUDIT_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS;
  const result = db
    .prepare("DELETE FROM audit_log WHERE created_at < datetime('now', ?)")
    .run(`-${days} days`);
  return result.changes;
}

export function startAuditRetentionMonitor(): NodeJS.Timeout {
  return setInterval(() => {
    purgeOldAuditLogs();
  }, 3_600_000); // every hour
}

import { getOverdueBlockers } from "../services/blockers.js";
import { broadcast } from "../ws/gateway.js";

const INTERVAL_MS = Number(process.env.AGENTMESH_BLOCKER_SLA_INTERVAL_MS) || 30_000;

export function startBlockerSlaMonitor(): NodeJS.Timeout {
  return setInterval(() => {
    const overdue = getOverdueBlockers();
    if (overdue.length > 0) {
      broadcast("blockers.sla_breached", {
        blockerIds: overdue.map((b) => b.blocker_id),
        count: overdue.length,
      });
    }
  }, INTERVAL_MS);
}

import { getOverdueBlockers } from "../services/blockers.js";
import { broadcast } from "../ws/gateway.js";

export function startBlockerSlaMonitor(): NodeJS.Timeout {
  return setInterval(() => {
    const overdue = getOverdueBlockers();
    if (overdue.length > 0) {
      broadcast("blockers.sla_breached", {
        blockerIds: overdue.map((b) => b.blocker_id),
        count: overdue.length,
      });
    }
  }, 30000);
}

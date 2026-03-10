import { writeAuditLog } from "../services/audit.js";
import { runPresenceSweep } from "../services/presence.js";
import { broadcast } from "../ws/gateway.js";

const INTERVAL_MS = Number(process.env.AGENTMESH_PRESENCE_INTERVAL_MS) || 15_000;

export function startPresenceMonitor(): NodeJS.Timeout {
  return setInterval(() => {
    const result = runPresenceSweep();
    if (result.stale.length > 0 || result.evicted.length > 0) {
      broadcast("presence.updated", result);
      for (const agentId of result.evicted) {
        writeAuditLog({
          actorType: "system",
          action: "agent.evicted",
          entityType: "agent",
          entityId: agentId,
        });
      }
    }
  }, INTERVAL_MS);
}

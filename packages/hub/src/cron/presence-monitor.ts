import { runPresenceSweep } from "../services/presence.js";
import { broadcast } from "../ws/gateway.js";

export function startPresenceMonitor(): NodeJS.Timeout {
  return setInterval(() => {
    const result = runPresenceSweep();
    if (result.stale.length > 0 || result.evicted.length > 0) {
      broadcast("presence.updated", result);
    }
  }, 15000);
}

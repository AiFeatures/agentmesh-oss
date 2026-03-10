import { expireHandoffs } from "../services/handoffs.js";
import { broadcast } from "../ws/gateway.js";

const INTERVAL_MS = Number(process.env.AGENTMESH_HANDOFF_EXPIRY_INTERVAL_MS) || 10_000;

export function startHandoffExpiryMonitor(): NodeJS.Timeout {
  return setInterval(() => {
    const expired = expireHandoffs();
    if (expired.length > 0) {
      broadcast("handoffs.expired", { handoffIds: expired });
    }
  }, INTERVAL_MS);
}

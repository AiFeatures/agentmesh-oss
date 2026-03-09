import { expireHandoffs } from "../services/handoffs.js";
import { broadcast } from "../ws/gateway.js";

export function startHandoffExpiryMonitor(): NodeJS.Timeout {
  return setInterval(() => {
    const expired = expireHandoffs();
    if (expired.length > 0) {
      broadcast("handoffs.expired", { handoffIds: expired });
    }
  }, 10000);
}

import { expireClaims } from "../services/claims.js";
import { broadcast } from "../ws/gateway.js";

export function startClaimExpiryMonitor(): NodeJS.Timeout {
  return setInterval(() => {
    const expired = expireClaims();
    if (expired.length > 0) {
      broadcast("claims.expired", { claimIds: expired });
    }
  }, 10000);
}

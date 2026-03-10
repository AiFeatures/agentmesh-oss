import { expireClaims } from "../services/claims.js";
import { broadcast } from "../ws/gateway.js";

const INTERVAL_MS = Number(process.env.AGENTMESH_CLAIM_EXPIRY_INTERVAL_MS) || 10_000;

export function startClaimExpiryMonitor(): NodeJS.Timeout {
  return setInterval(() => {
    const expired = expireClaims();
    if (expired.length > 0) {
      broadcast("claims.expired", { claimIds: expired });
    }
  }, INTERVAL_MS);
}

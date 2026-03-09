import { startClaimExpiryMonitor } from "./claim-expiry.js";
import { startHandoffExpiryMonitor } from "./handoff-expiry.js";
import { startPresenceMonitor } from "./presence-monitor.js";

export function startSchedulers(): () => void {
  const timers = [startPresenceMonitor(), startClaimExpiryMonitor(), startHandoffExpiryMonitor()];
  return () => {
    for (const timer of timers) {
      clearInterval(timer);
    }
  };
}

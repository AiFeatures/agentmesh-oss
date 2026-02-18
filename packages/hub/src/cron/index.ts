import { startClaimExpiryMonitor } from "./claim-expiry.js";
import { startPresenceMonitor } from "./presence-monitor.js";

export function startSchedulers(): () => void {
  const timers = [startPresenceMonitor(), startClaimExpiryMonitor()];
  return () => {
    for (const timer of timers) {
      clearInterval(timer);
    }
  };
}

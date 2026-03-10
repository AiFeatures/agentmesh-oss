import { getOverdueBlockers } from "../services/blockers.js";
import { broadcast } from "../ws/gateway.js";

const INTERVAL_MS = Number(process.env.AGENTMESH_BLOCKER_SLA_INTERVAL_MS) || 30_000;
const ESCALATION_WEBHOOK = process.env.AGENTMESH_ESCALATION_WEBHOOK_URL || "";

async function notifyEscalationWebhook(
  blockers: Array<{ blocker_id: string; workspace_id: string; severity: string }>,
): Promise<void> {
  if (!ESCALATION_WEBHOOK) return;
  try {
    await fetch(ESCALATION_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "blockers.sla_breached",
        blockers,
        ts: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // best-effort, don't crash the monitor
  }
}

export function startBlockerSlaMonitor(): NodeJS.Timeout {
  return setInterval(() => {
    const overdue = getOverdueBlockers();
    if (overdue.length > 0) {
      broadcast("blockers.sla_breached", {
        blockerIds: overdue.map((b) => b.blocker_id),
        count: overdue.length,
      });
      void notifyEscalationWebhook(overdue);
    }
  }, INTERVAL_MS);
}

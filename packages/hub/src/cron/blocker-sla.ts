import { db } from "../db/index.js";
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
      for (const b of overdue) {
        const watchers = db
          .prepare(
            "SELECT agent_id FROM blocker_watchers WHERE blocker_id = ? AND workspace_id = ?",
          )
          .all(b.blocker_id, b.workspace_id) as Array<{ agent_id: string }>;
        if (watchers.length > 0) {
          broadcast("blocker.watcher_notify", {
            workspace: b.workspace_id,
            blocker_id: b.blocker_id,
            trigger: "sla_breached",
            watchers: watchers.map((w) => w.agent_id),
          });
        }
      }
      void notifyEscalationWebhook(overdue);
    }
  }, INTERVAL_MS);
}

import { db } from "../db/index.js";
import { parseJsonSafe } from "../utils/json.js";
import { routeByCapability } from "./capability-router.js";
import { handoffId } from "./ids.js";

type HandoffInput = {
  workspaceId: string;
  fromAgentId: string;
  toAgentId?: string;
  capabilityTag?: string;
  summary: string;
  context?: Record<string, unknown>;
  timeoutSeconds?: number;
};

export function createHandoff(input: HandoffInput): { id: string; toAgentId: string | null } {
  const routed =
    input.toAgentId ??
    (input.capabilityTag
      ? (routeByCapability(input.workspaceId, input.capabilityTag)?.agent_id ?? null)
      : null);

  const id = handoffId();
  const timeoutSec = input.timeoutSeconds ?? null;
  db.prepare(
    `
      INSERT INTO handoffs (
        handoff_id, workspace_id, from_agent_id, to_agent_id, route_mode, capability_tag, summary, context, status, timeout_seconds, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, CASE WHEN ? IS NOT NULL THEN datetime('now', '+' || ? || ' seconds') ELSE NULL END)
    `,
  ).run(
    id,
    input.workspaceId,
    input.fromAgentId,
    routed,
    input.toAgentId ? "direct" : "capability",
    input.capabilityTag ?? null,
    input.summary,
    input.context ? JSON.stringify(input.context) : null,
    timeoutSec,
    timeoutSec,
    timeoutSec,
  );

  return { id, toAgentId: routed };
}

export function expireHandoffs(): string[] {
  const rows = db
    .prepare(
      "SELECT handoff_id FROM handoffs WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP",
    )
    .all() as Array<{ handoff_id: string }>;
  if (rows.length === 0) {
    return [];
  }
  db.prepare(
    "UPDATE handoffs SET status = 'rejected', updated_at = CURRENT_TIMESTAMP WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP",
  ).run();
  return rows.map((r) => r.handoff_id);
}

export function updateHandoffStatus(
  handoffIdValue: string,
  status: "accepted" | "rejected",
): boolean {
  const result = db
    .prepare("UPDATE handoffs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE handoff_id = ?")
    .run(status, handoffIdValue);
  return result.changes > 0;
}

export function listHandoffs(workspaceId: string): Record<string, unknown>[] {
  const rows = db
    .prepare("SELECT * FROM handoffs WHERE workspace_id = ? ORDER BY created_at DESC")
    .all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    ...row,
    context: parseJsonSafe(String(row.context ?? ""), null),
  }));
}

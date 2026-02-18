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
};

export function createHandoff(input: HandoffInput): { id: string; toAgentId: string | null } {
  const routed =
    input.toAgentId ??
    (input.capabilityTag ? routeByCapability(input.workspaceId, input.capabilityTag) : null);

  const id = handoffId();
  db.prepare(
    `
      INSERT INTO handoffs (
        handoff_id, workspace_id, from_agent_id, to_agent_id, route_mode, capability_tag, summary, context, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
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
  );

  return { id, toAgentId: routed };
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

import { db } from "../db/index.js";
import { blockerId } from "./ids.js";

type BlockerInput = {
  workspaceId: string;
  agentId: string;
  title: string;
  details?: string;
  severity: "low" | "medium" | "high" | "critical";
};

export function createBlocker(input: BlockerInput): string {
  const id = blockerId();
  db.prepare(
    `
      INSERT INTO blockers (blocker_id, workspace_id, agent_id, title, details, severity, status)
      VALUES (?, ?, ?, ?, ?, ?, 'open')
    `,
  ).run(id, input.workspaceId, input.agentId, input.title, input.details ?? null, input.severity);
  return id;
}

export function resolveBlocker(blockerIdValue: string, resolvedBy: string, note?: string): boolean {
  const result = db
    .prepare(
      `
        UPDATE blockers
        SET status = 'resolved', resolved_by = ?, resolution_note = ?, resolved_at = CURRENT_TIMESTAMP
        WHERE blocker_id = ? AND status = 'open'
      `,
    )
    .run(resolvedBy, note ?? null, blockerIdValue);
  return result.changes > 0;
}

export function listBlockers(workspaceId: string): Record<string, unknown>[] {
  return db
    .prepare("SELECT * FROM blockers WHERE workspace_id = ? ORDER BY created_at DESC")
    .all(workspaceId) as Record<string, unknown>[];
}

import { db } from "../db/index.js";
import { parseJsonSafe } from "../utils/json.js";

export function routeByCapability(workspaceId: string, capabilityTag: string): string | null {
  const rows = db
    .prepare(
      `
        SELECT a.agent_id, a.capabilities, COUNT(c.claim_id) AS active_claims
        FROM agents a
        LEFT JOIN claims c ON c.agent_id = a.agent_id AND c.status = 'active'
        WHERE a.workspace_id = ?
          AND a.status IN ('online', 'idle')
        GROUP BY a.agent_id, a.capabilities
      `,
    )
    .all(workspaceId) as Array<{ agent_id: string; active_claims: number; capabilities?: string }>;

  const candidates = rows
    .map((row) => ({
      ...row,
      caps: parseJsonSafe(String(row.capabilities ?? "[]"), [] as string[]),
    }))
    .filter((row) => Array.isArray(row.caps) && row.caps.includes(capabilityTag))
    .sort(
      (a, b) =>
        Number(a.active_claims) - Number(b.active_claims) || a.agent_id.localeCompare(b.agent_id),
    );

  return candidates[0]?.agent_id ?? null;
}

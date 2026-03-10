import { db } from "../db/index.js";
import { parseJsonSafe } from "../utils/json.js";
import { findConflictingPattern } from "./conflict.js";
import { claimId } from "./ids.js";

export type CreateClaimInput = {
  workspaceId: string;
  agentId: string;
  scope: string;
  paths: string[];
  ttlSeconds?: number;
};

export function createClaim(
  input: CreateClaimInput,
): { id: string } | { conflict: Record<string, string> } {
  const ttl = input.ttlSeconds ?? 1800;
  const active = db
    .prepare(
      `
        SELECT cp.path_pattern AS pathPattern, c.claim_id AS claimId, c.agent_id AS agentId
        FROM claim_paths cp
        JOIN claims c ON c.claim_id = cp.claim_id
        WHERE c.workspace_id = ? AND c.status = 'active'
      `,
    )
    .all(input.workspaceId) as Array<{ pathPattern: string; claimId: string; agentId: string }>;

  const conflict = findConflictingPattern(input.paths, active);
  if (conflict && conflict.agentId !== input.agentId) {
    return {
      conflict: {
        claimId: conflict.claimId,
        agentId: conflict.agentId,
        pathPattern: conflict.pathPattern,
      },
    };
  }

  const id = claimId();
  const txn = db.transaction(() => {
    db.prepare(
      `
        INSERT INTO claims (claim_id, workspace_id, agent_id, scope, ttl_seconds, expires_at, status)
        VALUES (?, ?, ?, ?, ?, datetime('now', '+' || ? || ' seconds'), 'active')
      `,
    ).run(id, input.workspaceId, input.agentId, input.scope, ttl, ttl);

    const insertPath = db.prepare("INSERT INTO claim_paths (claim_id, path_pattern) VALUES (?, ?)");
    for (const pattern of input.paths) {
      insertPath.run(id, pattern);
    }
  });
  txn();

  return { id };
}

export function listClaims(workspaceId: string): Record<string, unknown>[] {
  const rows = db
    .prepare(
      `
        SELECT c.claim_id, c.workspace_id, c.agent_id, c.scope, c.status, c.ttl_seconds, c.created_at, c.expires_at, c.released_at,
               json_group_array(cp.path_pattern) AS paths
        FROM claims c
        JOIN claim_paths cp ON cp.claim_id = c.claim_id
        WHERE c.workspace_id = ?
        GROUP BY c.claim_id
        ORDER BY c.created_at DESC
      `,
    )
    .all(workspaceId) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    ...row,
    paths: parseJsonSafe(String(row.paths ?? "[]"), [] as string[]),
  }));
}

export function releaseClaim(id: string, force = false): boolean {
  const status = force ? "force_released" : "released";
  const result = db
    .prepare(
      "UPDATE claims SET status = ?, released_at = CURRENT_TIMESTAMP WHERE claim_id = ? AND status = 'active'",
    )
    .run(status, id);
  return result.changes > 0;
}

export function renewClaim(id: string, ttlSeconds = 1800): boolean {
  const result = db
    .prepare(
      "UPDATE claims SET expires_at = datetime('now', '+' || ? || ' seconds'), ttl_seconds = ?, renewal_count = renewal_count + 1 WHERE claim_id = ? AND status = 'active'",
    )
    .run(ttlSeconds, ttlSeconds, id);
  return result.changes > 0;
}

export function expireClaims(): string[] {
  const rows = db
    .prepare(
      "SELECT claim_id FROM claims WHERE status = 'active' AND expires_at <= CURRENT_TIMESTAMP",
    )
    .all() as Array<{ claim_id: string }>;
  if (rows.length === 0) {
    return [];
  }
  db.prepare(
    "UPDATE claims SET status = 'expired', released_at = CURRENT_TIMESTAMP WHERE status = 'active' AND expires_at <= CURRENT_TIMESTAMP",
  ).run();
  return rows.map((row) => row.claim_id);
}

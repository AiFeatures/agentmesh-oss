import { db } from "../db/index.js";
import { parseJsonSafe } from "../utils/json.js";

export type AgentRegistration = {
  agentId: string;
  workspaceId: string;
  displayName: string;
  model: string;
  capabilities: string[];
  metadata?: Record<string, unknown>;
};

export function registerAgent(input: AgentRegistration): void {
  db.prepare(
    `
      INSERT INTO agents (
        agent_id, workspace_id, display_name, model, capabilities, status, metadata, last_heartbeat_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'online', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(agent_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        display_name = excluded.display_name,
        model = excluded.model,
        capabilities = excluded.capabilities,
        status = 'online',
        metadata = excluded.metadata,
        last_heartbeat_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `,
  ).run(
    input.agentId,
    input.workspaceId,
    input.displayName,
    input.model,
    JSON.stringify(input.capabilities),
    input.metadata ? JSON.stringify(input.metadata) : null,
  );
}

export function heartbeatAgent(agentId: string): boolean {
  const result = db
    .prepare(
      "UPDATE agents SET last_heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, status = 'online' WHERE agent_id = ?",
    )
    .run(agentId);
  return result.changes > 0;
}

export function listAgents(workspaceId: string): Record<string, unknown>[] {
  const rows = db
    .prepare(
      `
        SELECT agent_id, workspace_id, display_name, model, capabilities, status, last_heartbeat_at, metadata, created_at, updated_at
        FROM agents
        WHERE workspace_id = ?
        ORDER BY updated_at DESC
      `,
    )
    .all(workspaceId) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    ...row,
    capabilities: parseJsonSafe(String(row.capabilities ?? "[]"), [] as string[]),
    metadata: parseJsonSafe(String(row.metadata ?? ""), null as Record<string, unknown> | null),
  }));
}

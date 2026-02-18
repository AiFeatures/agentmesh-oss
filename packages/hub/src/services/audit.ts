import { db } from "../db/index.js";
import { broadcast } from "../ws/gateway.js";

type AuditInput = {
  workspaceId?: string;
  actorType: "agent" | "system";
  actorId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  requestId?: string;
  payload?: Record<string, unknown>;
};

export function writeAuditLog(input: AuditInput): void {
  const result = db
    .prepare(
      `
      INSERT INTO audit_log (
        workspace_id, actor_type, actor_id, action, entity_type, entity_id, request_id, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      input.workspaceId ?? null,
      input.actorType,
      input.actorId ?? null,
      input.action,
      input.entityType,
      input.entityId ?? null,
      input.requestId ?? null,
      input.payload ? JSON.stringify(input.payload) : null,
    );

  broadcast("audit.logged", {
    audit_id: result.lastInsertRowid,
    workspace_id: input.workspaceId ?? null,
    actor_type: input.actorType,
    actor_id: input.actorId ?? null,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    request_id: input.requestId ?? null,
    payload: input.payload ?? null,
    created_at: new Date().toISOString(),
  });
}

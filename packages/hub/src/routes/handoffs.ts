import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/index.js";
import { writeAuditLog } from "../services/audit.js";
import { createHandoff, listHandoffs, updateHandoffStatus } from "../services/handoffs.js";
import { parseJsonSafe } from "../utils/json.js";
import { broadcast } from "../ws/gateway.js";

export const handoffRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/api/v1/workspaces/:workspace/handoffs",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["from_agent_id", "summary"],
          additionalProperties: false,
          properties: {
            from_agent_id: { type: "string", minLength: 2, maxLength: 128 },
            to_agent_id: { type: "string", minLength: 2, maxLength: 128 },
            capability_tag: { type: "string", minLength: 1, maxLength: 64 },
            summary: { type: "string", minLength: 1, maxLength: 2000 },
            context: { type: "object", additionalProperties: true, maxProperties: 50 },
            timeout_seconds: { type: "integer", minimum: 60, maximum: 86400 },
            max_retries: { type: "integer", minimum: 0, maximum: 10 },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const body = request.body as {
        from_agent_id: string;
        to_agent_id?: string;
        capability_tag?: string;
        summary: string;
        context?: Record<string, unknown>;
        timeout_seconds?: number;
        max_retries?: number;
      };

      const fromExists = db
        .prepare("SELECT agent_id FROM agents WHERE agent_id = ? AND workspace_id = ?")
        .get(body.from_agent_id, workspace);
      if (!fromExists) {
        return reply.code(404).send({ error: "from_agent_id not found" });
      }
      if (body.to_agent_id) {
        const toExists = db
          .prepare("SELECT agent_id FROM agents WHERE agent_id = ? AND workspace_id = ?")
          .get(body.to_agent_id, workspace);
        if (!toExists) {
          return reply.code(404).send({ error: "to_agent_id not found" });
        }
      }

      const created = createHandoff({
        workspaceId: workspace,
        fromAgentId: body.from_agent_id,
        toAgentId: body.to_agent_id,
        capabilityTag: body.capability_tag,
        summary: body.summary,
        context: body.context,
        timeoutSeconds: body.timeout_seconds,
        maxRetries: body.max_retries,
      });

      writeAuditLog({
        workspaceId: workspace,
        actorType: "agent",
        actorId: body.from_agent_id,
        action: "handoff.create",
        entityType: "handoff",
        entityId: created.id,
        requestId: request.id,
        payload: body,
      });

      broadcast("handoff.received", {
        workspace,
        handoff_id: created.id,
        to_agent_id: created.toAgentId,
      });
      return reply.code(201).send({ handoff_id: created.id, to_agent_id: created.toAgentId });
    },
  );

  app.post(
    "/api/v1/workspaces/:workspace/handoffs/:handoffId/accept",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { handoffId, workspace } = request.params as { handoffId: string; workspace: string };
      const exists = db
        .prepare("SELECT handoff_id FROM handoffs WHERE handoff_id = ? AND workspace_id = ?")
        .get(handoffId, workspace);
      if (!exists) {
        return reply.code(404).send({ error: "Handoff not found" });
      }

      const ok = updateHandoffStatus(handoffId, "accepted");
      if (!ok) {
        return reply.code(404).send({ error: "Handoff not found" });
      }

      writeAuditLog({
        workspaceId: workspace,
        actorType: "agent",
        action: "handoff.accept",
        entityType: "handoff",
        entityId: handoffId,
        requestId: request.id,
      });

      broadcast("handoffs.updated", { workspace, handoff_id: handoffId, status: "accepted" });
      return reply.send({ ok: true });
    },
  );

  app.post(
    "/api/v1/workspaces/:workspace/handoffs/:handoffId/reject",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { handoffId, workspace } = request.params as { handoffId: string; workspace: string };
      const exists = db
        .prepare("SELECT handoff_id FROM handoffs WHERE handoff_id = ? AND workspace_id = ?")
        .get(handoffId, workspace);
      if (!exists) {
        return reply.code(404).send({ error: "Handoff not found" });
      }

      const ok = updateHandoffStatus(handoffId, "rejected");
      if (!ok) {
        return reply.code(404).send({ error: "Handoff not found" });
      }

      writeAuditLog({
        workspaceId: workspace,
        actorType: "agent",
        action: "handoff.reject",
        entityType: "handoff",
        entityId: handoffId,
        requestId: request.id,
      });

      broadcast("handoffs.updated", { workspace, handoff_id: handoffId, status: "rejected" });
      return reply.send({ ok: true });
    },
  );

  /* ── F-54  handoff retry ────────────────────────────────────── */
  app.post(
    "/api/v1/workspaces/:workspace/handoffs/:handoffId/retry",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { handoffId, workspace } = request.params as { handoffId: string; workspace: string };
      const row = db
        .prepare("SELECT * FROM handoffs WHERE handoff_id = ? AND workspace_id = ?")
        .get(handoffId, workspace) as Record<string, unknown> | undefined;
      if (!row) {
        return reply.code(404).send({ error: "Handoff not found" });
      }
      if (row.status !== "rejected") {
        return reply.code(422).send({ error: "Only rejected handoffs can be retried" });
      }
      if (Number(row.retry_count) >= Number(row.max_retries)) {
        return reply.code(422).send({
          error: "Max retries exceeded",
          retry_count: row.retry_count,
          max_retries: row.max_retries,
        });
      }

      db.prepare(
        "UPDATE handoffs SET status = 'pending', retry_count = retry_count + 1, updated_at = CURRENT_TIMESTAMP WHERE handoff_id = ?",
      ).run(handoffId);

      writeAuditLog({
        workspaceId: workspace,
        actorType: "agent",
        action: "handoff.retry",
        entityType: "handoff",
        entityId: handoffId,
        requestId: request.id,
        payload: { retry_count: Number(row.retry_count) + 1 },
      });

      broadcast("handoffs.updated", { workspace, handoff_id: handoffId, status: "pending" });
      return reply.send({ ok: true, retry_count: Number(row.retry_count) + 1 });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/handoffs",
    {
      preHandler: app.authGuard,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: ["pending", "accepted", "rejected"] },
            from_agent_id: { type: "string", maxLength: 128 },
            to_agent_id: { type: "string", maxLength: 128 },
            limit: { type: "string" },
            offset: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { status, from_agent_id, to_agent_id } = request.query as {
        status?: string;
        from_agent_id?: string;
        to_agent_id?: string;
      };
      const data = listHandoffs(workspace).filter(
        (row) =>
          (!status || row.status === status) &&
          (!from_agent_id || row.from_agent_id === from_agent_id) &&
          (!to_agent_id || row.to_agent_id === to_agent_id),
      );
      const start = Math.max(0, Number((request.query as Record<string, string>).offset) || 0);
      const count = Math.min(
        200,
        Math.max(1, Number((request.query as Record<string, string>).limit) || 50),
      );
      return reply.send({ data: data.slice(start, start + count), total: data.length });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/handoffs/:handoffId",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, handoffId } = request.params as {
        workspace: string;
        handoffId: string;
      };
      const row = db
        .prepare("SELECT * FROM handoffs WHERE handoff_id = ? AND workspace_id = ?")
        .get(handoffId, workspace) as Record<string, unknown> | undefined;
      if (!row) {
        return reply.code(404).send({ error: "Handoff not found" });
      }
      row.context = parseJsonSafe(String(row.context ?? ""), null);
      const timeline = db
        .prepare(
          "SELECT action, actor_type, actor_id, payload, created_at FROM audit_log WHERE entity_type = 'handoff' AND entity_id = ? ORDER BY created_at ASC",
        )
        .all(handoffId) as Array<Record<string, unknown>>;
      return reply.send({ ...row, timeline });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/handoffs/stats",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const ws = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const byStatus = db
        .prepare(
          "SELECT status, COUNT(*) as count FROM handoffs WHERE workspace_id = ? GROUP BY status",
        )
        .all(workspace) as Array<{ status: string; count: number }>;
      const byRouteMode = db
        .prepare(
          "SELECT route_mode, COUNT(*) as count FROM handoffs WHERE workspace_id = ? GROUP BY route_mode",
        )
        .all(workspace) as Array<{ route_mode: string; count: number }>;
      const avgAcceptTime = db
        .prepare(
          "SELECT AVG(julianday(updated_at) - julianday(created_at)) * 86400 as avg_seconds FROM handoffs WHERE workspace_id = ? AND status = 'accepted'",
        )
        .get(workspace) as { avg_seconds: number | null };

      return reply.send({
        by_status: Object.fromEntries(byStatus.map((r) => [r.status, r.count])),
        by_route_mode: Object.fromEntries(byRouteMode.map((r) => [r.route_mode, r.count])),
        avg_accept_seconds: avgAcceptTime.avg_seconds
          ? Math.round(avgAcceptTime.avg_seconds)
          : null,
      });
    },
  );
};

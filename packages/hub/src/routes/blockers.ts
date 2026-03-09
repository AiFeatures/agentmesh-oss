import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/index.js";
import { writeAuditLog } from "../services/audit.js";
import { createBlocker, listBlockers, resolveBlocker } from "../services/blockers.js";
import { broadcast } from "../ws/gateway.js";

export const blockerRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/api/v1/workspaces/:workspace/blockers",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["agent_id", "title", "severity"],
          additionalProperties: false,
          properties: {
            agent_id: { type: "string", minLength: 2, maxLength: 128 },
            title: { type: "string", minLength: 1, maxLength: 300 },
            details: { type: "string", maxLength: 5000 },
            severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const body = request.body as {
        agent_id: string;
        title: string;
        details?: string;
        severity: "low" | "medium" | "high" | "critical";
      };

      const agentExists = db
        .prepare("SELECT agent_id FROM agents WHERE agent_id = ? AND workspace_id = ?")
        .get(body.agent_id, workspace);
      if (!agentExists) {
        return reply.code(404).send({ error: "Agent not found" });
      }

      const id = createBlocker({
        workspaceId: workspace,
        agentId: body.agent_id,
        title: body.title,
        details: body.details,
        severity: body.severity,
      });

      writeAuditLog({
        workspaceId: workspace,
        actorType: "agent",
        actorId: body.agent_id,
        action: "blocker.create",
        entityType: "blocker",
        entityId: id,
        requestId: request.id,
        payload: body,
      });

      broadcast("blocker.created", { workspace, blocker_id: id, severity: body.severity });
      return reply.code(201).send({ blocker_id: id });
    },
  );

  app.post(
    "/api/v1/workspaces/:workspace/blockers/:blockerId/resolve",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            option: { type: "string", maxLength: 64 },
            note: { type: "string", maxLength: 2000 },
            resolved_by: { type: "string", maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace, blockerId } = request.params as { workspace: string; blockerId: string };
      const exists = db
        .prepare("SELECT blocker_id FROM blockers WHERE blocker_id = ? AND workspace_id = ?")
        .get(blockerId, workspace);
      if (!exists) {
        return reply.code(404).send({ error: "Open blocker not found" });
      }

      const body = request.body as { option?: string; note?: string; resolved_by?: string };
      const ok = resolveBlocker(
        blockerId,
        body.resolved_by ?? "operator",
        body.note ?? body.option,
      );
      if (!ok) {
        return reply.code(404).send({ error: "Open blocker not found" });
      }

      writeAuditLog({
        workspaceId: workspace,
        actorType: "system",
        action: "blocker.resolve",
        entityType: "blocker",
        entityId: blockerId,
        requestId: request.id,
        payload: body,
      });

      broadcast("blocker.resolved", { workspace, blocker_id: blockerId });
      return reply.send({ ok: true });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/blockers",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { limit, offset } = request.query as {
        limit?: string;
        offset?: string;
      };
      const all = listBlockers(workspace);
      const start = Math.max(0, Number(offset) || 0);
      const count = Math.min(200, Math.max(1, Number(limit) || 50));
      return reply.send({ data: all.slice(start, start + count), total: all.length });
    },
  );
};

import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/index.js";
import { writeAuditLog } from "../services/audit.js";
import { createHandoff, listHandoffs, updateHandoffStatus } from "../services/handoffs.js";
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
      broadcast("handoffs.updated", { workspace, handoff_id: handoffId, status: "accepted" });
      return reply.send({ ok: true });
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
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { status } = request.query as { status?: string };
      const data = listHandoffs(workspace).filter((row) => (status ? row.status === status : true));
      return reply.send({ data });
    },
  );
};

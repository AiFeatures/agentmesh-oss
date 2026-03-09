import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/index.js";
import { writeAuditLog } from "../services/audit.js";
import { heartbeatAgent, listAgents, registerAgent } from "../services/registry.js";
import { broadcast } from "../ws/gateway.js";

export const agentRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/api/v1/workspaces/:workspace/agents/register",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["agent_id", "display_name"],
          additionalProperties: false,
          properties: {
            agent_id: { type: "string", minLength: 2, maxLength: 128 },
            agent_type: { type: "string", minLength: 1, maxLength: 64 },
            display_name: { type: "string", minLength: 1, maxLength: 256 },
            model: { type: "string", minLength: 1, maxLength: 128 },
            capabilities: {
              type: "array",
              items: { type: "string", minLength: 1, maxLength: 64 },
              maxItems: 128,
            },
            metadata: { type: "object", additionalProperties: true, maxProperties: 50 },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const body = request.body as {
        agent_id: string;
        display_name: string;
        model?: string;
        capabilities?: string[];
        metadata?: Record<string, unknown>;
      };

      const exists = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!exists) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      registerAgent({
        agentId: body.agent_id,
        workspaceId: workspace,
        displayName: body.display_name,
        model: body.model ?? "custom",
        capabilities: body.capabilities ?? [],
        metadata: body.metadata,
      });

      writeAuditLog({
        workspaceId: workspace,
        actorType: "agent",
        actorId: body.agent_id,
        action: "agent.register",
        entityType: "agent",
        entityId: body.agent_id,
        requestId: request.id,
        payload: body,
      });

      broadcast("agents.updated", { workspace, agent_id: body.agent_id });
      return reply.code(201).send({ ok: true, agent_id: body.agent_id, workspace_id: workspace });
    },
  );

  app.post(
    "/api/v1/workspaces/:workspace/agents/heartbeat",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["agent_id"],
          additionalProperties: false,
          properties: {
            agent_id: { type: "string", minLength: 2, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { agent_id } = request.body as { agent_id: string };

      const exists = db
        .prepare("SELECT workspace_id FROM agents WHERE agent_id = ? AND workspace_id = ?")
        .get(agent_id, workspace);
      if (!exists) {
        return reply.code(404).send({ error: "Agent not found" });
      }

      heartbeatAgent(agent_id);
      broadcast("agents.heartbeat", { workspace, agent_id });
      return reply.send({ ok: true });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/agents",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      return reply.send({ data: listAgents(workspace) });
    },
  );
};

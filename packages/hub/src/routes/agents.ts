import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/index.js";
import { writeAuditLog } from "../services/audit.js";
import { heartbeatAgent, listAgents, registerAgent } from "../services/registry.js";
import { parseJsonSafe } from "../utils/json.js";
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
    "/api/v1/workspaces/:workspace/agents/bulk-register",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["agents"],
          additionalProperties: false,
          properties: {
            agents: {
              type: "array",
              minItems: 1,
              maxItems: 50,
              items: {
                type: "object",
                required: ["agent_id", "display_name"],
                additionalProperties: false,
                properties: {
                  agent_id: { type: "string", minLength: 2, maxLength: 128 },
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
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { agents } = request.body as {
        agents: Array<{
          agent_id: string;
          display_name: string;
          model?: string;
          capabilities?: string[];
          metadata?: Record<string, unknown>;
        }>;
      };

      const exists = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!exists) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const registered: string[] = [];
      for (const agent of agents) {
        registerAgent({
          agentId: agent.agent_id,
          workspaceId: workspace,
          displayName: agent.display_name,
          model: agent.model ?? "custom",
          capabilities: agent.capabilities ?? [],
          metadata: agent.metadata,
        });
        registered.push(agent.agent_id);
      }

      writeAuditLog({
        workspaceId: workspace,
        actorType: "system",
        action: "agent.bulk_register",
        entityType: "agent",
        entityId: registered.join(","),
        requestId: request.id,
        payload: { count: registered.length },
      });

      broadcast("agents.updated", { workspace, agent_ids: registered });
      return reply.code(201).send({ ok: true, registered, count: registered.length });
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
    {
      preHandler: app.authGuard,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: {
              type: "string",
              enum: ["online", "idle", "stale", "evicted", "blocked"],
            },
            limit: { type: "string" },
            offset: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { limit, offset, status } = request.query as {
        limit?: string;
        offset?: string;
        status?: string;
      };
      let all = listAgents(workspace);
      if (status) {
        all = all.filter((a) => a.status === status);
      }
      const start = Math.max(0, Number(offset) || 0);
      const count = Math.min(200, Math.max(1, Number(limit) || 50));
      return reply.send({ data: all.slice(start, start + count), total: all.length });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/agents/:agentId",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, agentId } = request.params as {
        workspace: string;
        agentId: string;
      };
      const row = db
        .prepare(
          "SELECT agent_id, workspace_id, display_name, model, capabilities, status, last_heartbeat_at, metadata, created_at, updated_at FROM agents WHERE agent_id = ? AND workspace_id = ?",
        )
        .get(agentId, workspace) as Record<string, unknown> | undefined;
      if (!row) {
        return reply.code(404).send({ error: "Agent not found" });
      }
      row.capabilities = parseJsonSafe(String(row.capabilities ?? "[]"), [] as string[]);
      row.metadata = parseJsonSafe(
        String(row.metadata ?? ""),
        null as Record<string, unknown> | null,
      );
      return reply.send(row);
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/capabilities",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const rows = db
        .prepare(
          "SELECT agent_id, capabilities, status FROM agents WHERE workspace_id = ? AND status IN ('online', 'idle')",
        )
        .all(workspace) as Array<{
        agent_id: string;
        capabilities: string;
        status: string;
      }>;

      const capMap = new Map<string, string[]>();
      for (const row of rows) {
        const caps = parseJsonSafe(String(row.capabilities ?? "[]"), [] as string[]);
        for (const cap of caps) {
          const agents = capMap.get(cap) ?? [];
          agents.push(row.agent_id);
          capMap.set(cap, agents);
        }
      }

      const data = Array.from(capMap.entries()).map(([capability, agents]) => ({
        capability,
        agents,
        count: agents.length,
      }));

      return reply.send({ data });
    },
  );

  app.delete(
    "/api/v1/workspaces/:workspace/agents/:agentId",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, agentId } = request.params as {
        workspace: string;
        agentId: string;
      };
      const agent = db
        .prepare("SELECT agent_id FROM agents WHERE agent_id = ? AND workspace_id = ?")
        .get(agentId, workspace);
      if (!agent) {
        return reply.code(404).send({ error: "Agent not found" });
      }

      db.prepare("DELETE FROM agents WHERE agent_id = ? AND workspace_id = ?").run(
        agentId,
        workspace,
      );

      writeAuditLog({
        workspaceId: workspace,
        actorType: "system",
        action: "agent.deregister",
        entityType: "agent",
        entityId: agentId,
        requestId: request.id,
      });

      broadcast("agents.updated", { workspace, agent_id: agentId, status: "deregistered" });
      return reply.send({ ok: true });
    },
  );

  app.patch(
    "/api/v1/workspaces/:workspace/agents/:agentId/status",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["status"],
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: ["online", "idle", "blocked"] },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace, agentId } = request.params as {
        workspace: string;
        agentId: string;
      };
      const { status } = request.body as { status: string };

      const agent = db
        .prepare("SELECT agent_id FROM agents WHERE agent_id = ? AND workspace_id = ?")
        .get(agentId, workspace);
      if (!agent) {
        return reply.code(404).send({ error: "Agent not found" });
      }

      db.prepare(
        "UPDATE agents SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?",
      ).run(status, agentId);

      writeAuditLog({
        workspaceId: workspace,
        actorType: "agent",
        actorId: agentId,
        action: "agent.status_change",
        entityType: "agent",
        entityId: agentId,
        requestId: request.id,
        payload: { status },
      });

      broadcast("agents.updated", { workspace, agent_id: agentId, status });
      return reply.send({ ok: true, status });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/agents/:agentId/history",
    {
      preHandler: app.authGuard,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "string" },
            offset: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace, agentId } = request.params as {
        workspace: string;
        agentId: string;
      };
      const { limit, offset } = request.query as { limit?: string; offset?: string };

      const agent = db
        .prepare("SELECT agent_id FROM agents WHERE agent_id = ? AND workspace_id = ?")
        .get(agentId, workspace);
      if (!agent) {
        return reply.code(404).send({ error: "Agent not found" });
      }

      const count = Math.min(200, Math.max(1, Number(limit) || 50));
      const start = Math.max(0, Number(offset) || 0);

      const rows = db
        .prepare(
          `SELECT action, payload, created_at FROM audit_log
           WHERE workspace_id = ? AND entity_type = 'agent' AND entity_id = ?
           ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        )
        .all(workspace, agentId, count, start) as Array<{
        action: string;
        payload: string | null;
        created_at: string;
      }>;

      const data = rows.map((row) => ({
        action: row.action,
        payload: parseJsonSafe(row.payload ?? "", null as Record<string, unknown> | null),
        created_at: row.created_at,
      }));

      return reply.send({ data, total: data.length });
    },
  );

  app.patch(
    "/api/v1/workspaces/:workspace/agents/:agentId/capabilities",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["capabilities"],
          additionalProperties: false,
          properties: {
            capabilities: {
              type: "array",
              minItems: 1,
              maxItems: 128,
              items: { type: "string", minLength: 1, maxLength: 128 },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace, agentId } = request.params as {
        workspace: string;
        agentId: string;
      };
      const { capabilities } = request.body as { capabilities: string[] };

      const agent = db
        .prepare("SELECT agent_id FROM agents WHERE agent_id = ? AND workspace_id = ?")
        .get(agentId, workspace);
      if (!agent) {
        return reply.code(404).send({ error: "Agent not found" });
      }

      db.prepare(
        "UPDATE agents SET capabilities = ?, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?",
      ).run(JSON.stringify(capabilities), agentId);

      writeAuditLog({
        workspaceId: workspace,
        actorType: "agent",
        actorId: agentId,
        action: "agent.capabilities_update",
        entityType: "agent",
        entityId: agentId,
        requestId: request.id,
        payload: { capabilities },
      });

      broadcast("agents.updated", { workspace, agent_id: agentId, capabilities });
      return reply.send({ ok: true, capabilities });
    },
  );

  app.patch(
    "/api/v1/workspaces/:workspace/agents/:agentId/metadata",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["metadata"],
          additionalProperties: false,
          properties: {
            metadata: { type: "object", additionalProperties: true, maxProperties: 50 },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace, agentId } = request.params as {
        workspace: string;
        agentId: string;
      };
      const { metadata } = request.body as { metadata: Record<string, unknown> };

      const agent = db
        .prepare("SELECT agent_id, metadata FROM agents WHERE agent_id = ? AND workspace_id = ?")
        .get(agentId, workspace) as { agent_id: string; metadata: string | null } | undefined;
      if (!agent) {
        return reply.code(404).send({ error: "Agent not found" });
      }

      const existing = agent.metadata ? JSON.parse(agent.metadata) : {};
      const merged = { ...existing, ...metadata };

      db.prepare(
        "UPDATE agents SET metadata = ?, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?",
      ).run(JSON.stringify(merged), agentId);

      writeAuditLog({
        workspaceId: workspace,
        actorType: "agent",
        actorId: agentId,
        action: "agent.metadata_update",
        entityType: "agent",
        entityId: agentId,
        requestId: request.id,
        payload: { metadata },
      });

      broadcast("agents.updated", { workspace, agent_id: agentId });
      return reply.send({ ok: true, metadata: merged });
    },
  );
};

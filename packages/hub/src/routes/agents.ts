import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/index.js";
import { writeAuditLog } from "../services/audit.js";
import { taskId } from "../services/ids.js";
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
            tags: {
              type: "array",
              items: { type: "string", minLength: 1, maxLength: 64 },
              maxItems: 50,
            },
            group: { type: "string", minLength: 1, maxLength: 64 },
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
        tags?: string[];
        group?: string;
      };

      const ws = db
        .prepare("SELECT workspace_id, settings FROM workspaces WHERE workspace_id = ?")
        .get(workspace) as { workspace_id: string; settings: string } | undefined;
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const settings = JSON.parse(ws.settings || "{}");
      if (settings.max_agents) {
        const agentCount = db
          .prepare("SELECT COUNT(*) as count FROM agents WHERE workspace_id = ?")
          .get(workspace) as { count: number };
        if (agentCount.count >= settings.max_agents) {
          return reply.code(422).send({
            error: "Agent limit reached",
            max_agents: settings.max_agents,
            current: agentCount.count,
          });
        }
      }

      registerAgent({
        agentId: body.agent_id,
        workspaceId: workspace,
        displayName: body.display_name,
        model: body.model ?? "custom",
        capabilities: body.capabilities ?? [],
        metadata: body.metadata,
        tags: body.tags,
        group: body.group,
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
            capability: { type: "string", maxLength: 64 },
            tag: { type: "string", maxLength: 64 },
            group: { type: "string", maxLength: 64 },
            limit: { type: "string" },
            offset: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { limit, offset, status, capability, tag, group } = request.query as {
        limit?: string;
        offset?: string;
        status?: string;
        capability?: string;
        tag?: string;
        group?: string;
      };
      let all = listAgents(workspace);
      if (status) {
        all = all.filter((a) => a.status === status);
      }
      if (capability) {
        all = all.filter(
          (a) => Array.isArray(a.capabilities) && a.capabilities.includes(capability),
        );
      }
      if (tag) {
        all = all.filter((a) => Array.isArray(a.tags) && a.tags.includes(tag));
      }
      if (group) {
        all = all.filter((a) => a.group === group);
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
      row.tags = parseJsonSafe(String(row.tags ?? "[]"), [] as string[]);
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

      // Force-release active claims before cascade delete
      const activeClaims = db
        .prepare(
          "SELECT claim_id FROM claims WHERE agent_id = ? AND workspace_id = ? AND status = 'active'",
        )
        .all(agentId, workspace) as Array<{ claim_id: string }>;
      if (activeClaims.length > 0) {
        db.prepare(
          "UPDATE claims SET status = 'force_released', released_at = CURRENT_TIMESTAMP WHERE agent_id = ? AND workspace_id = ? AND status = 'active'",
        ).run(agentId, workspace);
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
        payload: { released_claims: activeClaims.length },
      });

      broadcast("agents.updated", { workspace, agent_id: agentId, status: "deregistered" });
      return reply.send({ ok: true });
    },
  );

  /* ── F-76  bulk deregister ──────────────────────────────────── */
  app.post(
    "/api/v1/workspaces/:workspace/agents/bulk-deregister",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["agent_ids"],
          additionalProperties: false,
          properties: {
            agent_ids: {
              type: "array",
              minItems: 1,
              maxItems: 50,
              items: { type: "string", minLength: 1, maxLength: 128 },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { agent_ids } = request.body as { agent_ids: string[] };

      const removed: string[] = [];
      const notFound: string[] = [];

      for (const aid of agent_ids) {
        const agent = db
          .prepare("SELECT agent_id FROM agents WHERE agent_id = ? AND workspace_id = ?")
          .get(aid, workspace);
        if (!agent) {
          notFound.push(aid);
          continue;
        }
        db.prepare(
          "UPDATE claims SET status = 'force_released', released_at = CURRENT_TIMESTAMP WHERE agent_id = ? AND workspace_id = ? AND status = 'active'",
        ).run(aid, workspace);
        db.prepare("DELETE FROM agents WHERE agent_id = ? AND workspace_id = ?").run(
          aid,
          workspace,
        );
        removed.push(aid);
      }

      if (removed.length > 0) {
        writeAuditLog({
          workspaceId: workspace,
          actorType: "system",
          action: "agent.bulk_deregister",
          entityType: "agent",
          entityId: removed.join(","),
          requestId: request.id,
          payload: { removed, not_found: notFound },
        });
        broadcast("agents.updated", { workspace, deregistered: removed });
      }

      return reply.send({ removed, not_found: notFound });
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
        .prepare(
          "SELECT agent_id, status as current_status FROM agents WHERE agent_id = ? AND workspace_id = ?",
        )
        .get(agentId, workspace) as { agent_id: string; current_status: string } | undefined;
      if (!agent) {
        return reply.code(404).send({ error: "Agent not found" });
      }

      db.prepare(
        "UPDATE agents SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?",
      ).run(status, agentId);

      db.prepare(
        "INSERT INTO agent_status_history (agent_id, workspace_id, old_status, new_status) VALUES (?, ?, ?, ?)",
      ).run(agentId, workspace, agent.current_status, status);

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

      db.prepare(
        "INSERT INTO agent_metadata_history (agent_id, workspace_id, metadata) VALUES (?, ?, ?)",
      ).run(agentId, workspace, JSON.stringify(merged));

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

  /* ── F-72  agent metadata history ───────────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/agents/:agentId/metadata-history",
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
      const agent = db
        .prepare("SELECT agent_id FROM agents WHERE agent_id = ? AND workspace_id = ?")
        .get(agentId, workspace);
      if (!agent) {
        return reply.code(404).send({ error: "Agent not found" });
      }
      const { limit, offset } = request.query as { limit?: string; offset?: string };
      const count = Math.min(200, Math.max(1, Number(limit) || 50));
      const start = Math.max(0, Number(offset) || 0);
      const rows = db
        .prepare(
          "SELECT metadata, created_at FROM agent_metadata_history WHERE agent_id = ? AND workspace_id = ? ORDER BY id DESC LIMIT ? OFFSET ?",
        )
        .all(agentId, workspace, count, start) as Array<Record<string, unknown>>;
      for (const row of rows) {
        row.metadata = JSON.parse(String(row.metadata ?? "{}"));
      }
      return reply.send({ data: rows });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/agents/:agentId/activity",
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

      const claims = db
        .prepare(
          "SELECT status, COUNT(*) as count FROM claims WHERE agent_id = ? AND workspace_id = ? GROUP BY status",
        )
        .all(agentId, workspace) as Array<{ status: string; count: number }>;
      const handoffsFrom = db
        .prepare(
          "SELECT status, COUNT(*) as count FROM handoffs WHERE from_agent_id = ? AND workspace_id = ? GROUP BY status",
        )
        .all(agentId, workspace) as Array<{ status: string; count: number }>;
      const handoffsTo = db
        .prepare(
          "SELECT status, COUNT(*) as count FROM handoffs WHERE to_agent_id = ? AND workspace_id = ? GROUP BY status",
        )
        .all(agentId, workspace) as Array<{ status: string; count: number }>;
      const blockers = db
        .prepare(
          "SELECT status, COUNT(*) as count FROM blockers WHERE agent_id = ? AND workspace_id = ? GROUP BY status",
        )
        .all(agentId, workspace) as Array<{ status: string; count: number }>;
      const auditCount = db
        .prepare("SELECT COUNT(*) as count FROM audit_log WHERE actor_id = ? AND workspace_id = ?")
        .get(agentId, workspace) as { count: number };

      return reply.send({
        agent_id: agentId,
        claims: Object.fromEntries(claims.map((r) => [r.status, r.count])),
        handoffs_initiated: Object.fromEntries(handoffsFrom.map((r) => [r.status, r.count])),
        handoffs_received: Object.fromEntries(handoffsTo.map((r) => [r.status, r.count])),
        blockers: Object.fromEntries(blockers.map((r) => [r.status, r.count])),
        audit_events: auditCount.count,
      });
    },
  );

  /* ── F-63  agent status history ─────────────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/agents/:agentId/status-history",
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
      const agent = db
        .prepare("SELECT agent_id FROM agents WHERE agent_id = ? AND workspace_id = ?")
        .get(agentId, workspace);
      if (!agent) {
        return reply.code(404).send({ error: "Agent not found" });
      }

      const { limit, offset } = request.query as { limit?: string; offset?: string };
      const count = Math.min(200, Math.max(1, Number(limit) || 50));
      const start = Math.max(0, Number(offset) || 0);

      const rows = db
        .prepare(
          "SELECT old_status, new_status, created_at FROM agent_status_history WHERE agent_id = ? AND workspace_id = ? ORDER BY id DESC LIMIT ? OFFSET ?",
        )
        .all(agentId, workspace, count, start) as Array<Record<string, unknown>>;
      const total = db
        .prepare(
          "SELECT COUNT(*) as c FROM agent_status_history WHERE agent_id = ? AND workspace_id = ?",
        )
        .get(agentId, workspace) as { c: number };

      return reply.send({ data: rows, total: total.c });
    },
  );

  /* ── F-67  agent capability search ──────────────────────────── */
  app.post(
    "/api/v1/workspaces/:workspace/agents/search",
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
              maxItems: 50,
              items: { type: "string", minLength: 1, maxLength: 64 },
            },
            status: { type: "string", enum: ["online", "idle", "stale", "evicted", "blocked"] },
            tag: { type: "string", minLength: 1, maxLength: 64 },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const body = request.body as {
        capabilities: string[];
        status?: string;
        tag?: string;
      };

      let agents = listAgents(workspace);
      // filter to agents that have ALL requested capabilities
      agents = agents.filter((a) => {
        const caps = a.capabilities as string[];
        return body.capabilities.every((c) => caps.includes(c));
      });
      if (body.status) {
        agents = agents.filter((a) => a.status === body.status);
      }
      if (body.tag) {
        agents = agents.filter((a) => {
          const tags = a.tags as string[];
          return tags.includes(body.tag!);
        });
      }
      return reply.send({ data: agents, total: agents.length });
    },
  );

  /* ── F-78  agent group list ─────────────────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/agents/groups",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const rows = db
        .prepare(
          `SELECT "group", COUNT(*) as agent_count, GROUP_CONCAT(agent_id) as agent_ids
           FROM agents WHERE workspace_id = ? AND "group" IS NOT NULL AND "group" != ''
           GROUP BY "group" ORDER BY agent_count DESC`,
        )
        .all(workspace) as Array<{ group: string; agent_count: number; agent_ids: string }>;
      const data = rows.map((r) => ({
        group: r.group,
        agent_count: r.agent_count,
        agent_ids: r.agent_ids.split(","),
      }));
      return reply.send({ data, total: data.length });
    },
  );

  /* ── F-85  agent heartbeat stats ────────────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/agents/heartbeat-stats",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const rows = db
        .prepare(
          `SELECT agent_id, status, last_heartbeat_at,
           CAST((julianday('now') - julianday(last_heartbeat_at)) * 86400 AS INTEGER) as seconds_since_heartbeat
           FROM agents WHERE workspace_id = ? ORDER BY last_heartbeat_at DESC`,
        )
        .all(workspace) as Array<{
        agent_id: string;
        status: string;
        last_heartbeat_at: string;
        seconds_since_heartbeat: number;
      }>;
      return reply.send({ data: rows, total: rows.length });
    },
  );

  /* ── F-88  agent labels ─────────────────────────────────────── */
  app.put(
    "/api/v1/workspaces/:workspace/agents/:agentId/labels",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          additionalProperties: { type: "string", maxLength: 256 },
          maxProperties: 50,
        },
      },
    },
    async (request, reply) => {
      const { workspace, agentId } = request.params as { workspace: string; agentId: string };
      const labels = request.body as Record<string, string>;
      const agent = db
        .prepare("SELECT agent_id FROM agents WHERE agent_id = ? AND workspace_id = ?")
        .get(agentId, workspace);
      if (!agent) {
        return reply.code(404).send({ error: "Agent not found" });
      }
      const txn = db.transaction(() => {
        db.prepare("DELETE FROM agent_labels WHERE agent_id = ?").run(agentId);
        const insert = db.prepare(
          "INSERT INTO agent_labels (agent_id, label_key, label_value) VALUES (?, ?, ?)",
        );
        for (const [key, value] of Object.entries(labels)) {
          insert.run(agentId, key, value);
        }
      });
      txn();
      return reply.send({ ok: true });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/agents/:agentId/labels",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, agentId } = request.params as { workspace: string; agentId: string };
      const agent = db
        .prepare("SELECT agent_id FROM agents WHERE agent_id = ? AND workspace_id = ?")
        .get(agentId, workspace);
      if (!agent) {
        return reply.code(404).send({ error: "Agent not found" });
      }
      const rows = db
        .prepare("SELECT label_key, label_value FROM agent_labels WHERE agent_id = ?")
        .all(agentId) as Array<{ label_key: string; label_value: string }>;
      const labels: Record<string, string> = {};
      for (const r of rows) {
        labels[r.label_key] = r.label_value;
      }
      return reply.send({ labels });
    },
  );

  /* ── F-92  agent health score ───────────────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/agents/:agentId/health",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, agentId } = request.params as { workspace: string; agentId: string };
      const agent = db
        .prepare(
          "SELECT status, last_heartbeat_at FROM agents WHERE agent_id = ? AND workspace_id = ?",
        )
        .get(agentId, workspace) as { status: string; last_heartbeat_at: string } | undefined;
      if (!agent) {
        return reply.code(404).send({ error: "Agent not found" });
      }

      const secsSinceHb = (
        db
          .prepare("SELECT CAST((julianday('now') - julianday(?)) * 86400 AS INTEGER) as secs")
          .get(agent.last_heartbeat_at) as { secs: number }
      ).secs;

      const activeClaims = (
        db
          .prepare(
            "SELECT COUNT(*) as c FROM claims WHERE agent_id = ? AND workspace_id = ? AND status = 'active'",
          )
          .get(agentId, workspace) as { c: number }
      ).c;

      const openBlockers = (
        db
          .prepare(
            "SELECT COUNT(*) as c FROM blockers WHERE agent_id = ? AND workspace_id = ? AND status = 'open'",
          )
          .get(agentId, workspace) as { c: number }
      ).c;

      // score: 100 base, -10 per 60s since heartbeat, -20 if stale/evicted, -5 per blocker
      let score = 100;
      score -= Math.floor(secsSinceHb / 60) * 10;
      if (agent.status === "stale" || agent.status === "evicted") score -= 20;
      score -= openBlockers * 5;
      score = Math.max(0, Math.min(100, score));

      return reply.send({
        agent_id: agentId,
        status: agent.status,
        health_score: score,
        seconds_since_heartbeat: secsSinceHb,
        active_claims: activeClaims,
        open_blockers: openBlockers,
      });
    },
  );

  /* ── F-95  agent online streak ──────────────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/agents/:agentId/online-streak",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, agentId } = request.params as { workspace: string; agentId: string };
      const agent = db
        .prepare("SELECT status, created_at FROM agents WHERE agent_id = ? AND workspace_id = ?")
        .get(agentId, workspace) as { status: string; created_at: string } | undefined;
      if (!agent) {
        return reply.code(404).send({ error: "Agent not found" });
      }

      // Find the most recent status change away from 'online'
      const lastNonOnline = db
        .prepare(
          "SELECT created_at FROM agent_status_history WHERE agent_id = ? AND new_status != 'online' ORDER BY id DESC LIMIT 1",
        )
        .get(agentId) as { created_at: string } | undefined;

      const sinceDate = lastNonOnline ? lastNonOnline.created_at : agent.created_at;
      const streakSecs = (
        db
          .prepare("SELECT CAST((julianday('now') - julianday(?)) * 86400 AS INTEGER) as secs")
          .get(sinceDate) as { secs: number }
      ).secs;

      return reply.send({
        agent_id: agentId,
        current_status: agent.status,
        online_since: sinceDate,
        streak_seconds: Math.max(0, streakSecs),
      });
    },
  );

  /* ── F-101  agent uptime report ──────────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/agents/uptime-report",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const agents = db
        .prepare(
          "SELECT agent_id, display_name, status, created_at FROM agents WHERE workspace_id = ?",
        )
        .all(workspace) as Array<{
        agent_id: string;
        display_name: string;
        status: string;
        created_at: string;
      }>;

      const report = agents.map((a) => {
        const totalSecs = (
          db
            .prepare("SELECT CAST((julianday('now') - julianday(?)) * 86400 AS INTEGER) as secs")
            .get(a.created_at) as { secs: number }
        ).secs;
        // Count seconds in non-online statuses from status history
        const offlineRows = db
          .prepare(
            "SELECT old_status, new_status, created_at FROM agent_status_history WHERE agent_id = ? ORDER BY id ASC",
          )
          .all(a.agent_id) as Array<{ old_status: string; new_status: string; created_at: string }>;
        // Simple estimate: agent was online for totalSecs minus offline transitions
        // For now, we approximate based on current status
        const onlinePct = a.status === "online" ? 100 : a.status === "idle" ? 80 : 0;
        return {
          agent_id: a.agent_id,
          display_name: a.display_name,
          status: a.status,
          total_seconds: Math.max(0, totalSecs),
          uptime_pct: onlinePct,
        };
      });
      return reply.send({ data: report });
    },
  );

  /* ── F-98  agent capability matrix ──────────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/agents/capability-matrix",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const agents = db
        .prepare("SELECT agent_id, display_name, capabilities FROM agents WHERE workspace_id = ?")
        .all(workspace) as Array<{ agent_id: string; display_name: string; capabilities: string }>;

      const capSet = new Set<string>();
      const parsed = agents.map((a) => {
        const caps: string[] = JSON.parse(a.capabilities);
        for (const c of caps) capSet.add(c);
        return { agent_id: a.agent_id, display_name: a.display_name, capabilities: caps };
      });

      const allCaps = [...capSet].sort();
      const matrix = parsed.map((a) => ({
        agent_id: a.agent_id,
        display_name: a.display_name,
        ...Object.fromEntries(allCaps.map((c) => [c, a.capabilities.includes(c)])),
      }));

      return reply.send({ capabilities: allCaps, matrix });
    },
  );

  /* ── F-104  agent task queue ────────────────────────────────── */
  app.post(
    "/api/v1/workspaces/:workspace/agents/:agentId/tasks",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["title"],
          additionalProperties: false,
          properties: {
            title: { type: "string", minLength: 1, maxLength: 256 },
            description: { type: "string", maxLength: 2000 },
            priority: { type: "string", enum: ["low", "normal", "high", "critical"] },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace, agentId } = request.params as { workspace: string; agentId: string };
      const body = request.body as { title: string; description?: string; priority?: string };
      const agent = db
        .prepare("SELECT agent_id FROM agents WHERE agent_id = ? AND workspace_id = ?")
        .get(agentId, workspace);
      if (!agent) return reply.code(404).send({ error: "Agent not found" });

      const id = taskId();
      db.prepare(
        "INSERT INTO agent_tasks (task_id, workspace_id, agent_id, title, description, priority) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        workspace,
        agentId,
        body.title,
        body.description ?? null,
        body.priority ?? "normal",
      );
      return reply.code(201).send({ task_id: id });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/agents/:agentId/tasks",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, agentId } = request.params as { workspace: string; agentId: string };
      const { status } = request.query as { status?: string };
      let sql = "SELECT * FROM agent_tasks WHERE workspace_id = ? AND agent_id = ?";
      const params: unknown[] = [workspace, agentId];
      if (status) {
        sql += " AND status = ?";
        params.push(status);
      }
      sql += " ORDER BY created_at DESC";
      const rows = db.prepare(sql).all(...params);
      return reply.send({ data: rows });
    },
  );

  /* ── F-525  update agent task status ────────────────────── */
  app.patch(
    "/api/v1/workspaces/:workspace/agents/:agentId/tasks/:taskId",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
            title: { type: "string", minLength: 1, maxLength: 256 },
            description: { type: "string", maxLength: 2000 },
            priority: { type: "string", enum: ["low", "normal", "high", "critical"] },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace, agentId, taskId } = request.params as {
        workspace: string;
        agentId: string;
        taskId: string;
      };
      const body = request.body as {
        status?: string;
        title?: string;
        description?: string;
        priority?: string;
      };
      const existing = db
        .prepare(
          "SELECT task_id FROM agent_tasks WHERE task_id = ? AND agent_id = ? AND workspace_id = ?",
        )
        .get(taskId, agentId, workspace);
      if (!existing) return reply.code(404).send({ error: "Task not found" });

      const sets: string[] = [];
      const params: unknown[] = [];
      if (body.status) {
        sets.push("status = ?");
        params.push(body.status);
      }
      if (body.title) {
        sets.push("title = ?");
        params.push(body.title);
      }
      if (body.description !== undefined) {
        sets.push("description = ?");
        params.push(body.description);
      }
      if (body.priority) {
        sets.push("priority = ?");
        params.push(body.priority);
      }
      if (sets.length === 0) return reply.code(400).send({ error: "No fields to update" });
      sets.push("updated_at = CURRENT_TIMESTAMP");
      params.push(taskId, agentId, workspace);
      db.prepare(
        `UPDATE agent_tasks SET ${sets.join(", ")} WHERE task_id = ? AND agent_id = ? AND workspace_id = ?`,
      ).run(...params);

      writeAuditLog({
        workspaceId: workspace,
        actorType: "agent",
        actorId: agentId,
        action: "task.update",
        entityType: "task",
        entityId: taskId,
        requestId: request.id,
      });
      broadcast("task.updated", { workspace, agentId, taskId, ...body });
      return reply.send({ ok: true });
    },
  );

  /* ── F-526  delete agent task ───────────────────────────── */
  app.delete(
    "/api/v1/workspaces/:workspace/agents/:agentId/tasks/:taskId",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, agentId, taskId } = request.params as {
        workspace: string;
        agentId: string;
        taskId: string;
      };
      const existing = db
        .prepare(
          "SELECT task_id FROM agent_tasks WHERE task_id = ? AND agent_id = ? AND workspace_id = ?",
        )
        .get(taskId, agentId, workspace);
      if (!existing) return reply.code(404).send({ error: "Task not found" });

      db.prepare(
        "DELETE FROM agent_tasks WHERE task_id = ? AND agent_id = ? AND workspace_id = ?",
      ).run(taskId, agentId, workspace);
      writeAuditLog({
        workspaceId: workspace,
        actorType: "agent",
        actorId: agentId,
        action: "task.delete",
        entityType: "task",
        entityId: taskId,
        requestId: request.id,
      });
      broadcast("task.deleted", { workspace, agentId, taskId });
      return reply.send({ ok: true });
    },
  );

  /* ── F-108  agent dependency graph ──────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/agents/dependency-graph",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const ws = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      const edges = db
        .prepare(
          `SELECT from_agent_id, to_agent_id, COUNT(*) as handoff_count
           FROM handoffs
           WHERE workspace_id = ? AND to_agent_id IS NOT NULL
           GROUP BY from_agent_id, to_agent_id
           ORDER BY handoff_count DESC`,
        )
        .all(workspace) as Array<{
        from_agent_id: string;
        to_agent_id: string;
        handoff_count: number;
      }>;
      const nodeSet = new Set<string>();
      for (const e of edges) {
        nodeSet.add(e.from_agent_id);
        nodeSet.add(e.to_agent_id);
      }
      return reply.send({
        nodes: [...nodeSet],
        edges: edges.map((e) => ({
          from: e.from_agent_id,
          to: e.to_agent_id,
          weight: e.handoff_count,
        })),
      });
    },
  );

  /* ── F-112  agent workload distribution ─────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/agents/workload",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const ws = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      const rows = db
        .prepare(
          `SELECT a.agent_id, a.display_name, a.status,
                  (SELECT COUNT(*) FROM claims c WHERE c.agent_id = a.agent_id AND c.status = 'active') as active_claims,
                  (SELECT COUNT(*) FROM blockers b WHERE b.agent_id = a.agent_id AND b.status = 'open') as open_blockers,
                  (SELECT COUNT(*) FROM handoffs h WHERE h.to_agent_id = a.agent_id AND h.status = 'pending') as pending_handoffs
           FROM agents a
           WHERE a.workspace_id = ?
           ORDER BY active_claims DESC`,
        )
        .all(workspace);
      return reply.send({ data: rows });
    },
  );

  /* ── F-115  agent idle time report ────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/agents/idle-report",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const ws = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      const rows = db
        .prepare(
          `SELECT agent_id, display_name, status, last_heartbeat_at,
                  ROUND((julianday('now') - julianday(last_heartbeat_at)) * 86400) as idle_seconds
           FROM agents
           WHERE workspace_id = ? AND status IN ('idle', 'stale')
           ORDER BY idle_seconds DESC`,
        )
        .all(workspace);
      return reply.send({ data: rows });
    },
  );

  /* ── F-118  agent capability gap analysis ─────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/agents/capability-gaps",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const ws = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      // capability tags requested in handoffs
      const requested = db
        .prepare(
          "SELECT DISTINCT capability_tag FROM handoffs WHERE workspace_id = ? AND route_mode = 'capability' AND capability_tag IS NOT NULL",
        )
        .all(workspace) as Array<{ capability_tag: string }>;
      // capabilities available in agents
      const agentRows = db
        .prepare("SELECT capabilities FROM agents WHERE workspace_id = ?")
        .all(workspace) as Array<{ capabilities: string }>;
      const available = new Set<string>();
      for (const row of agentRows) {
        try {
          const caps = JSON.parse(row.capabilities);
          if (Array.isArray(caps)) {
            for (const c of caps) available.add(c);
          }
        } catch {}
      }
      const gaps = requested.map((r) => r.capability_tag).filter((tag) => !available.has(tag));
      return reply.send({
        gaps,
        available: [...available],
        requested: requested.map((r) => r.capability_tag),
      });
    },
  );

  /* ── F-121  agent collaboration matrix ──────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/agents/collaboration-matrix",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const ws = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      const rows = db
        .prepare(
          `SELECT
             CASE WHEN from_agent_id < to_agent_id THEN from_agent_id ELSE to_agent_id END as agent_a,
             CASE WHEN from_agent_id < to_agent_id THEN to_agent_id ELSE from_agent_id END as agent_b,
             COUNT(*) as interactions
           FROM handoffs
           WHERE workspace_id = ? AND to_agent_id IS NOT NULL
           GROUP BY agent_a, agent_b
           ORDER BY interactions DESC`,
        )
        .all(workspace);
      return reply.send({ data: rows });
    },
  );

  /* ── F-124  agent registration history ───────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/agents/registration-history",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const qs = request.query as { limit?: string };
      const limit = Math.min(Math.max(Number.parseInt(qs.limit || "50", 10) || 50, 1), 200);
      const ws = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      const rows = db
        .prepare(
          `SELECT * FROM audit_log
           WHERE workspace_id = ? AND (action = 'agent.register' OR action = 'agent.deregister')
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(workspace, limit);
      return reply.send({ data: rows });
    },
  );

  /* ── F-127  agent peer ranking ─────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/agents/peer-ranking",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const ws = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      const rows = db
        .prepare(
          `SELECT a.agent_id, a.display_name,
                  (SELECT COUNT(*) FROM handoffs h WHERE h.from_agent_id = a.agent_id AND h.status = 'accepted') as completed_handoffs,
                  (SELECT COUNT(*) FROM blockers b WHERE b.agent_id = a.agent_id AND b.status = 'resolved') as resolved_blockers,
                  (SELECT COUNT(*) FROM handoffs h WHERE h.from_agent_id = a.agent_id AND h.status = 'accepted') +
                  (SELECT COUNT(*) FROM blockers b WHERE b.agent_id = a.agent_id AND b.status = 'resolved') as score
           FROM agents a
           WHERE a.workspace_id = ?
           ORDER BY score DESC`,
        )
        .all(workspace);
      return reply.send({ data: rows });
    },
  );

  /* ── F-130  agent status transitions ────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/agents/:agentId/status-transitions",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, agentId } = request.params as { workspace: string; agentId: string };
      const agent = db
        .prepare("SELECT agent_id FROM agents WHERE agent_id = ? AND workspace_id = ?")
        .get(agentId, workspace);
      if (!agent) {
        return reply.code(404).send({ error: "Agent not found" });
      }
      const rows = db
        .prepare(
          `SELECT old_status, new_status, COUNT(*) as count
           FROM agent_status_history
           WHERE agent_id = ?
           GROUP BY old_status, new_status
           ORDER BY count DESC`,
        )
        .all(agentId);
      return reply.send({ agent_id: agentId, data: rows });
    },
  );

  /* ── F-133  agent capability utilization ─────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/agents/capability-utilization",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const ws = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      const handoffCaps = db
        .prepare(
          "SELECT capability_tag, COUNT(*) as usage_count FROM handoffs WHERE workspace_id = ? AND route_mode = 'capability' AND capability_tag IS NOT NULL GROUP BY capability_tag ORDER BY usage_count DESC",
        )
        .all(workspace) as Array<{ capability_tag: string; usage_count: number }>;
      return reply.send({ data: handoffCaps });
    },
  );

  /* ── F-136  agent tag summary ───────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/agents/tag-summary",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const ws = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      const agents = db
        .prepare("SELECT tags FROM agents WHERE workspace_id = ? AND tags IS NOT NULL")
        .all(workspace) as Array<{ tags: string }>;
      const tagCounts: Record<string, number> = {};
      for (const a of agents) {
        try {
          const arr = JSON.parse(a.tags);
          if (Array.isArray(arr)) {
            for (const t of arr) {
              tagCounts[t] = (tagCounts[t] || 0) + 1;
            }
          }
        } catch {
          /* skip malformed */
        }
      }
      const data = Object.entries(tagCounts)
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count);
      return reply.send({ data });
    },
  );

  /* ── F-138  agent capability overlap ─────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/agents/capability-overlap",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const ws = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      const agents = db
        .prepare(
          "SELECT agent_id, capabilities FROM agents WHERE workspace_id = ? AND capabilities IS NOT NULL",
        )
        .all(workspace) as Array<{ agent_id: string; capabilities: string }>;
      const capMap: Record<string, string[]> = {};
      for (const a of agents) {
        try {
          const caps = JSON.parse(a.capabilities);
          if (Array.isArray(caps)) {
            for (const c of caps) {
              if (!capMap[c]) capMap[c] = [];
              capMap[c].push(a.agent_id);
            }
          }
        } catch {
          /* skip */
        }
      }
      const overlaps = Object.entries(capMap)
        .filter(([, ids]) => ids.length > 1)
        .map(([capability, agent_ids]) => ({ capability, agent_ids, count: agent_ids.length }))
        .sort((a, b) => b.count - a.count);
      return reply.send({ data: overlaps });
    },
  );

  /* ── F-144  agent workload balancing ─────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/agents/recommend",
    {
      preHandler: app.authGuard,
      schema: {
        querystring: {
          type: "object",
          properties: {
            capability: { type: "string" },
          },
          required: ["capability"],
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { capability } = request.query as { capability: string };

      const agents = db
        .prepare(
          "SELECT agent_id, display_name, capabilities, status FROM agents WHERE workspace_id = ? AND status = 'online'",
        )
        .all(workspace) as Array<{
        agent_id: string;
        display_name: string;
        capabilities: string;
        status: string;
      }>;

      const candidates = agents.filter((a) => {
        try {
          const caps = JSON.parse(a.capabilities) as string[];
          return caps.includes(capability);
        } catch {
          return false;
        }
      });

      if (candidates.length === 0) {
        return reply.send({
          recommended: null,
          reason: "No online agents with the required capability",
          candidates: [],
        });
      }

      // Score each candidate: lower load = better
      const scored = candidates.map((agent) => {
        const activeClaims = (
          db
            .prepare(
              "SELECT COUNT(*) as c FROM claims WHERE agent_id = ? AND workspace_id = ? AND status = 'active'",
            )
            .get(agent.agent_id, workspace) as { c: number }
        ).c;
        const pendingHandoffs = (
          db
            .prepare(
              "SELECT COUNT(*) as c FROM handoffs WHERE workspace_id = ? AND status = 'pending' AND (to_agent_id = ? OR from_agent_id = ?)",
            )
            .get(workspace, agent.agent_id, agent.agent_id) as { c: number }
        ).c;
        const openBlockers = (
          db
            .prepare(
              "SELECT COUNT(*) as c FROM blockers WHERE agent_id = ? AND workspace_id = ? AND status = 'open'",
            )
            .get(agent.agent_id, workspace) as { c: number }
        ).c;

        const load = activeClaims * 2 + pendingHandoffs + openBlockers * 3;
        return {
          agent_id: agent.agent_id,
          display_name: agent.display_name,
          active_claims: activeClaims,
          pending_handoffs: pendingHandoffs,
          open_blockers: openBlockers,
          load_score: load,
        };
      });

      scored.sort((a, b) => a.load_score - b.load_score);

      return reply.send({
        recommended: scored[0].agent_id,
        reason: `Lowest load score (${scored[0].load_score})`,
        candidates: scored,
      });
    },
  );

  /* ── F-153  agent performance score ────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/agents/:agent_id/performance",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, agent_id } = request.params as {
        workspace: string;
        agent_id: string;
      };

      const agent = db
        .prepare(
          "SELECT agent_id, display_name, status FROM agents WHERE agent_id = ? AND workspace_id = ?",
        )
        .get(agent_id, workspace) as
        | { agent_id: string; display_name: string; status: string }
        | undefined;
      if (!agent) return reply.code(404).send({ error: "Agent not found" });

      const claimStats = db
        .prepare(
          `SELECT
             COUNT(*) as total_claims,
             SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_claims,
             SUM(CASE WHEN status = 'released' THEN 1 ELSE 0 END) as released_claims,
             AVG(renewal_count) as avg_renewals
           FROM claims WHERE agent_id = ? AND workspace_id = ?`,
        )
        .get(agent_id, workspace) as {
        total_claims: number;
        active_claims: number;
        released_claims: number;
        avg_renewals: number;
      };

      const handoffStats = db
        .prepare(
          `SELECT
             COUNT(*) as total_handoffs_created,
             SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as accepted,
             SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired,
             SUM(CASE WHEN to_agent_id = ? AND status = 'accepted' THEN 1 ELSE 0 END) as received_accepted
           FROM handoffs WHERE (from_agent_id = ? OR to_agent_id = ?) AND workspace_id = ?`,
        )
        .get(agent_id, agent_id, agent_id, workspace) as {
        total_handoffs_created: number;
        accepted: number;
        expired: number;
        received_accepted: number;
      };

      const blockerStats = db
        .prepare(
          `SELECT
             COUNT(*) as total_blockers,
             SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_blockers,
             SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved_blockers
           FROM blockers WHERE agent_id = ? AND workspace_id = ?`,
        )
        .get(agent_id, workspace) as {
        total_blockers: number;
        open_blockers: number;
        resolved_blockers: number;
      };

      const completionRate =
        claimStats.total_claims > 0
          ? +(claimStats.released_claims / claimStats.total_claims).toFixed(3)
          : 0;
      const handoffSuccessRate =
        handoffStats.total_handoffs_created > 0
          ? +(handoffStats.accepted / handoffStats.total_handoffs_created).toFixed(3)
          : 0;
      const blockerResolutionRate =
        blockerStats.total_blockers > 0
          ? +(blockerStats.resolved_blockers / blockerStats.total_blockers).toFixed(3)
          : 0;

      // composite score: weighted average of rates (0-100)
      const score = +(
        completionRate * 30 +
        handoffSuccessRate * 40 +
        blockerResolutionRate * 30
      ).toFixed(1);

      return reply.send({
        agent_id,
        agent_name: agent.display_name,
        status: agent.status,
        score,
        claims: claimStats,
        handoffs: handoffStats,
        blockers: blockerStats,
        rates: {
          completion: completionRate,
          handoff_success: handoffSuccessRate,
          blocker_resolution: blockerResolutionRate,
        },
      });
    },
  );

  /* ── F-161  agent load forecast ─────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/agents/load-forecast",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const agents = db
        .prepare("SELECT agent_id, display_name, status FROM agents WHERE workspace_id = ?")
        .all(workspace) as Array<{
        agent_id: string;
        display_name: string;
        status: string;
      }>;

      const forecast = agents.map((a) => {
        const activeClaims = (
          db
            .prepare("SELECT COUNT(*) as c FROM claims WHERE agent_id = ? AND status = 'active'")
            .get(a.agent_id) as { c: number }
        ).c;
        const pendingHandoffs = (
          db
            .prepare(
              "SELECT COUNT(*) as c FROM handoffs WHERE (from_agent_id = ? OR to_agent_id = ?) AND status = 'pending'",
            )
            .get(a.agent_id, a.agent_id) as { c: number }
        ).c;
        const openBlockers = (
          db
            .prepare("SELECT COUNT(*) as c FROM blockers WHERE agent_id = ? AND status = 'open'")
            .get(a.agent_id) as { c: number }
        ).c;

        const currentLoad = activeClaims * 2 + pendingHandoffs + openBlockers * 3;
        // Simple forecast: if agent has expiring claims, load will decrease
        const expiringIn1h = (
          db
            .prepare(
              `SELECT COUNT(*) as c FROM claims
               WHERE agent_id = ? AND status = 'active'
                 AND expires_at IS NOT NULL
                 AND datetime(expires_at) < datetime('now', '+1 hour')`,
            )
            .get(a.agent_id) as { c: number }
        ).c;

        const forecastLoad = Math.max(0, currentLoad - expiringIn1h * 2);

        return {
          agent_id: a.agent_id,
          display_name: a.display_name,
          status: a.status,
          current_load: currentLoad,
          forecast_load_1h: forecastLoad,
          active_claims: activeClaims,
          pending_handoffs: pendingHandoffs,
          open_blockers: openBlockers,
          expiring_claims_1h: expiringIn1h,
        };
      });

      forecast.sort((a, b) => b.current_load - a.current_load);

      return reply.send({
        agent_count: forecast.length,
        forecast,
      });
    },
  );

  // F-167: Agent response time analytics
  app.get(
    "/api/v1/workspaces/:workspace/agents/response-times",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const agents = db
        .prepare(`SELECT agent_id, display_name FROM agents WHERE workspace_id = ?`)
        .all(workspace) as Array<{ agent_id: string; display_name: string }>;

      const responseTimes = agents.map((a) => {
        const stats = db
          .prepare(
            `SELECT
               COUNT(*) as total_accepted,
               AVG((julianday(updated_at) - julianday(created_at)) * 86400) as avg_seconds,
               MIN((julianday(updated_at) - julianday(created_at)) * 86400) as min_seconds,
               MAX((julianday(updated_at) - julianday(created_at)) * 86400) as max_seconds
             FROM handoffs
             WHERE workspace_id = ? AND to_agent_id = ? AND status = 'accepted'`,
          )
          .get(workspace, a.agent_id) as {
          total_accepted: number;
          avg_seconds: number | null;
          min_seconds: number | null;
          max_seconds: number | null;
        };

        return {
          agent_id: a.agent_id,
          display_name: a.display_name,
          total_accepted: stats.total_accepted,
          avg_response_seconds: stats.avg_seconds ? Math.round(stats.avg_seconds * 100) / 100 : 0,
          min_response_seconds: stats.min_seconds ? Math.round(stats.min_seconds * 100) / 100 : 0,
          max_response_seconds: stats.max_seconds ? Math.round(stats.max_seconds * 100) / 100 : 0,
        };
      });

      responseTimes.sort((a, b) => a.avg_response_seconds - b.avg_response_seconds);

      return reply.send({
        agent_count: responseTimes.length,
        response_times: responseTimes,
      });
    },
  );

  // F-173: Agent availability summary
  app.get(
    "/api/v1/workspaces/:workspace/agents/availability-summary",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const agents = db
        .prepare(
          `SELECT agent_id, display_name, status, last_heartbeat_at, created_at
           FROM agents WHERE workspace_id = ?`,
        )
        .all(workspace) as Array<{
        agent_id: string;
        display_name: string;
        status: string;
        last_heartbeat_at: string;
        created_at: string;
      }>;

      const statusCounts: Record<string, number> = {};
      for (const a of agents) {
        statusCounts[a.status] = (statusCounts[a.status] ?? 0) + 1;
      }

      const summary = agents.map((a) => {
        const uptimeHours =
          Math.round(((Date.now() - new Date(a.created_at).getTime()) / 3600000) * 10) / 10;
        const lastSeenMinutes =
          Math.round(((Date.now() - new Date(a.last_heartbeat_at).getTime()) / 60000) * 10) / 10;
        return {
          agent_id: a.agent_id,
          display_name: a.display_name,
          status: a.status,
          uptime_hours: uptimeHours,
          last_seen_minutes_ago: lastSeenMinutes,
        };
      });

      return reply.send({
        agent_count: agents.length,
        status_distribution: statusCounts,
        agents: summary,
      });
    },
  );

  // F-178: Agent stale detection
  app.get(
    "/api/v1/workspaces/:workspace/agents/stale-detection",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { minutes = "10" } = request.query as { minutes?: string };
      const threshold = Math.max(Number.parseInt(minutes, 10) || 10, 1);

      const agents = db
        .prepare(
          `SELECT agent_id, display_name, status, last_heartbeat_at,
                  ROUND((julianday('now') - julianday(last_heartbeat_at)) * 1440, 1) as minutes_since_heartbeat
           FROM agents
           WHERE workspace_id = ?`,
        )
        .all(workspace) as Array<{
        agent_id: string;
        display_name: string;
        status: string;
        last_heartbeat_at: string;
        minutes_since_heartbeat: number;
      }>;

      const staleAgents = agents.filter((a) => a.minutes_since_heartbeat > threshold);
      const healthyAgents = agents.filter((a) => a.minutes_since_heartbeat <= threshold);

      return reply.send({
        threshold_minutes: threshold,
        total_agents: agents.length,
        healthy_count: healthyAgents.length,
        stale_count: staleAgents.length,
        stale_agents: staleAgents.map((a) => ({
          agent_id: a.agent_id,
          display_name: a.display_name,
          status: a.status,
          minutes_since_heartbeat: a.minutes_since_heartbeat,
        })),
      });
    },
  );

  // F-181: Agent pair affinity
  app.get(
    "/api/v1/workspaces/:workspace/agents/pair-affinity",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const pairs = db
        .prepare(
          `SELECT from_agent_id, to_agent_id, COUNT(*) as handoff_count,
                  SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as accepted_count
           FROM handoffs
           WHERE workspace_id = ? AND to_agent_id IS NOT NULL
           GROUP BY from_agent_id, to_agent_id
           ORDER BY handoff_count DESC
           LIMIT 50`,
        )
        .all(workspace) as Array<{
        from_agent_id: string;
        to_agent_id: string;
        handoff_count: number;
        accepted_count: number;
      }>;

      const affinities = pairs.map((p) => ({
        from_agent_id: p.from_agent_id,
        to_agent_id: p.to_agent_id,
        handoff_count: p.handoff_count,
        accepted_count: p.accepted_count,
        acceptance_rate:
          p.handoff_count > 0 ? Math.round((p.accepted_count / p.handoff_count) * 10000) / 100 : 0,
      }));

      return reply.send({
        pair_count: affinities.length,
        pairs: affinities,
      });
    },
  );

  // F-186: Agent capability coverage
  app.get(
    "/api/v1/workspaces/:workspace/agents/capability-coverage",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const agents = db
        .prepare(
          `SELECT agent_id, display_name, capabilities, status
           FROM agents WHERE workspace_id = ?`,
        )
        .all(workspace) as Array<{
        agent_id: string;
        display_name: string;
        capabilities: string;
        status: string;
      }>;

      const allCaps = new Set<string>();
      const onlineCaps = new Set<string>();
      const capAgentCount: Record<string, { total: number; online: number }> = {};

      for (const a of agents) {
        const caps = JSON.parse(a.capabilities) as string[];
        for (const cap of caps) {
          allCaps.add(cap);
          if (!capAgentCount[cap]) capAgentCount[cap] = { total: 0, online: 0 };
          capAgentCount[cap].total++;
          if (a.status === "online") {
            onlineCaps.add(cap);
            capAgentCount[cap].online++;
          }
        }
      }

      const uncovered = [...allCaps].filter((c) => !onlineCaps.has(c));
      const coverageRate =
        allCaps.size > 0 ? Math.round((onlineCaps.size / allCaps.size) * 10000) / 100 : 100;

      return reply.send({
        total_capabilities: allCaps.size,
        covered_capabilities: onlineCaps.size,
        uncovered_capabilities: uncovered,
        coverage_rate: coverageRate,
        capability_details: Object.entries(capAgentCount).map(([cap, counts]) => ({
          capability: cap,
          total_agents: counts.total,
          online_agents: counts.online,
        })),
      });
    },
  );

  // F-191: Agent utilization timeline — activity buckets over time
  app.get(
    "/api/v1/workspaces/:workspace/agents/utilization-timeline",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { hours = "24", bucket_hours = "1" } = request.query as {
        hours?: string;
        bucket_hours?: string;
      };
      const totalHours = Math.min(Number.parseInt(hours, 10) || 24, 720);
      const bucketH = Math.max(Number.parseInt(bucket_hours, 10) || 1, 1);
      const now = new Date();
      const since = new Date(now.getTime() - totalHours * 3600000).toISOString();

      // Gather handoff activity per bucket
      const handoffs = db
        .prepare(`SELECT created_at FROM handoffs WHERE workspace_id = ? AND created_at >= ?`)
        .all(workspace, since) as { created_at: string }[];

      const claims = db
        .prepare(`SELECT created_at FROM claims WHERE workspace_id = ? AND created_at >= ?`)
        .all(workspace, since) as { created_at: string }[];

      const buckets: {
        start: string;
        end: string;
        handoffs: number;
        claims: number;
        total: number;
      }[] = [];
      for (let i = 0; i < totalHours; i += bucketH) {
        const bStart = new Date(now.getTime() - (totalHours - i) * 3600000);
        const bEnd = new Date(bStart.getTime() + bucketH * 3600000);
        const hCount = handoffs.filter((h) => {
          const t = new Date(h.created_at).getTime();
          return t >= bStart.getTime() && t < bEnd.getTime();
        }).length;
        const cCount = claims.filter((c) => {
          const t = new Date(c.created_at).getTime();
          return t >= bStart.getTime() && t < bEnd.getTime();
        }).length;
        buckets.push({
          start: bStart.toISOString(),
          end: bEnd.toISOString(),
          handoffs: hCount,
          claims: cCount,
          total: hCount + cCount,
        });
      }

      const peakBucket = buckets.reduce(
        (max, b) => (b.total > max.total ? b : max),
        buckets[0] || { start: "", end: "", handoffs: 0, claims: 0, total: 0 },
      );
      return reply.send({
        workspace,
        period_hours: totalHours,
        bucket_hours: bucketH,
        buckets,
        peak_bucket: peakBucket,
        total_activity: handoffs.length + claims.length,
      });
    },
  );

  // F-196: Heartbeat health analysis
  app.get(
    "/api/v1/workspaces/:workspace/agents/heartbeat-health",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { stale_minutes = "5" } = request.query as { stale_minutes?: string };
      const staleMs = (Number.parseInt(stale_minutes, 10) || 5) * 60000;
      const now = Date.now();

      const agents = db
        .prepare(
          `SELECT agent_id, display_name, status, last_heartbeat_at FROM agents WHERE workspace_id = ?`,
        )
        .all(workspace) as {
        agent_id: string;
        display_name: string;
        status: string;
        last_heartbeat_at: string | null;
      }[];

      const results = agents.map((a) => {
        const lastHb = a.last_heartbeat_at ? new Date(a.last_heartbeat_at).getTime() : 0;
        const ageMs = lastHb > 0 ? now - lastHb : -1;
        const isStale = lastHb === 0 || ageMs > staleMs;
        return {
          agent_id: a.agent_id,
          display_name: a.display_name,
          status: a.status,
          last_heartbeat_at: a.last_heartbeat_at,
          heartbeat_age_seconds: ageMs >= 0 ? Math.round(ageMs / 1000) : null,
          is_stale: isStale,
        };
      });

      const healthy = results.filter((r) => !r.is_stale).length;
      const stale = results.filter((r) => r.is_stale).length;

      return reply.send({
        workspace,
        stale_threshold_minutes: Number.parseInt(stale_minutes, 10) || 5,
        total_agents: agents.length,
        healthy,
        stale,
        agents: results,
      });
    },
  );

  // F-201: Agent collaboration score
  app.get(
    "/api/v1/workspaces/:workspace/agents/collaboration-score",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const agents = db
        .prepare(`SELECT agent_id, display_name FROM agents WHERE workspace_id = ?`)
        .all(workspace) as { agent_id: string; display_name: string }[];

      const handoffs = db
        .prepare(`SELECT from_agent_id, to_agent_id, status FROM handoffs WHERE workspace_id = ?`)
        .all(workspace) as { from_agent_id: string; to_agent_id: string; status: string }[];

      const scores = agents.map((a) => {
        const sent = handoffs.filter((h) => h.from_agent_id === a.agent_id).length;
        const received = handoffs.filter((h) => h.to_agent_id === a.agent_id).length;
        const accepted = handoffs.filter(
          (h) => h.to_agent_id === a.agent_id && h.status === "accepted",
        ).length;
        const uniquePartners = new Set([
          ...handoffs.filter((h) => h.from_agent_id === a.agent_id).map((h) => h.to_agent_id),
          ...handoffs.filter((h) => h.to_agent_id === a.agent_id).map((h) => h.from_agent_id),
        ]).size;
        // Score: sent + received + 2*accepted + 3*uniquePartners
        const score = sent + received + 2 * accepted + 3 * uniquePartners;
        return {
          agent_id: a.agent_id,
          display_name: a.display_name,
          sent,
          received,
          accepted,
          unique_partners: uniquePartners,
          collaboration_score: score,
        };
      });

      scores.sort((a, b) => b.collaboration_score - a.collaboration_score);
      return reply.send({ workspace, agents: scores });
    },
  );

  // F-206: Agent task completion rate
  app.get(
    "/api/v1/workspaces/:workspace/agents/task-completion-rate",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const tasks = db
        .prepare(`SELECT agent_id, status FROM agent_tasks WHERE workspace_id = ?`)
        .all(workspace) as { agent_id: string; status: string }[];

      const byAgent: Record<
        string,
        {
          total: number;
          completed: number;
          cancelled: number;
          pending: number;
          in_progress: number;
        }
      > = {};
      for (const t of tasks) {
        if (!byAgent[t.agent_id])
          byAgent[t.agent_id] = {
            total: 0,
            completed: 0,
            cancelled: 0,
            pending: 0,
            in_progress: 0,
          };
        byAgent[t.agent_id].total++;
        if (t.status === "completed") byAgent[t.agent_id].completed++;
        else if (t.status === "cancelled") byAgent[t.agent_id].cancelled++;
        else if (t.status === "pending") byAgent[t.agent_id].pending++;
        else if (t.status === "in_progress") byAgent[t.agent_id].in_progress++;
      }

      const agents = Object.entries(byAgent)
        .map(([agent_id, stats]) => ({
          agent_id,
          ...stats,
          completion_rate:
            stats.total > 0 ? Math.round((stats.completed / stats.total) * 10000) / 100 : 0,
        }))
        .sort((a, b) => b.completion_rate - a.completion_rate);

      const totalTasks = tasks.length;
      const totalCompleted = tasks.filter((t) => t.status === "completed").length;

      return reply.send({
        workspace,
        total_tasks: totalTasks,
        total_completed: totalCompleted,
        overall_completion_rate:
          totalTasks > 0 ? Math.round((totalCompleted / totalTasks) * 10000) / 100 : 0,
        agents,
      });
    },
  );

  // F-211: Agent model distribution
  app.get(
    "/api/v1/workspaces/:workspace/agents/model-distribution",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const rows = db
        .prepare(
          `SELECT COALESCE(model, 'unknown') as model, status, COUNT(*) as count
           FROM agents WHERE workspace_id = ?
           GROUP BY model, status`,
        )
        .all(workspace) as { model: string; status: string; count: number }[];

      const byModel: Record<string, { total: number; by_status: Record<string, number> }> = {};
      for (const r of rows) {
        if (!byModel[r.model]) byModel[r.model] = { total: 0, by_status: {} };
        byModel[r.model].total += r.count;
        byModel[r.model].by_status[r.status] = r.count;
      }

      const distribution = Object.entries(byModel)
        .map(([model, data]) => ({ model, ...data }))
        .sort((a, b) => b.total - a.total);

      const total = distribution.reduce((s, d) => s + d.total, 0);
      return reply.send({ workspace, total, distribution });
    },
  );

  // F-216: Agent inactive report
  app.get(
    "/api/v1/workspaces/:workspace/agents/inactive-report",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { hours = "24" } = request.query as { hours?: string };
      const threshold = (Number.parseInt(hours, 10) || 24) * 3600000;
      const since = new Date(Date.now() - threshold).toISOString();

      const agents = db
        .prepare(
          `SELECT agent_id, display_name, status, created_at FROM agents WHERE workspace_id = ?`,
        )
        .all(workspace) as {
        agent_id: string;
        display_name: string;
        status: string;
        created_at: string;
      }[];

      // Agents with recent handoffs or claims
      const activeFromHandoffs = db
        .prepare(
          `SELECT DISTINCT from_agent_id as agent_id FROM handoffs WHERE workspace_id = ? AND created_at >= ?
           UNION SELECT DISTINCT to_agent_id as agent_id FROM handoffs WHERE workspace_id = ? AND created_at >= ? AND to_agent_id IS NOT NULL`,
        )
        .all(workspace, since, workspace, since) as { agent_id: string }[];

      const activeFromClaims = db
        .prepare(`SELECT DISTINCT agent_id FROM claims WHERE workspace_id = ? AND created_at >= ?`)
        .all(workspace, since) as { agent_id: string }[];

      const activeIds = new Set([
        ...activeFromHandoffs.map((a) => a.agent_id),
        ...activeFromClaims.map((a) => a.agent_id),
      ]);

      const inactive = agents
        .filter((a) => !activeIds.has(a.agent_id))
        .map((a) => ({ agent_id: a.agent_id, display_name: a.display_name, status: a.status }));

      return reply.send({
        workspace,
        threshold_hours: Number.parseInt(hours, 10) || 24,
        total_agents: agents.length,
        active_agents: activeIds.size,
        inactive_agents: inactive.length,
        inactive: inactive,
      });
    },
  );

  // F-223: Agent capability trend
  app.get(
    "/api/v1/workspaces/:workspace/agents/capability-trend",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const agents = db
        .prepare(`SELECT agent_id, capabilities, created_at FROM agents WHERE workspace_id = ?`)
        .all(workspace) as { agent_id: string; capabilities: string; created_at: string }[];

      const capTimeline: Record<string, number> = {};
      for (const a of agents) {
        const caps = JSON.parse(a.capabilities || "[]") as string[];
        const day = a.created_at.slice(0, 10);
        for (const cap of caps) {
          const key = `${day}|${cap}`;
          capTimeline[key] = (capTimeline[key] || 0) + 1;
        }
      }

      const entries = Object.entries(capTimeline)
        .map(([key, count]) => {
          const [day, capability] = key.split("|");
          return { day, capability, count };
        })
        .sort((a, b) => a.day.localeCompare(b.day));

      const allCaps = [...new Set(entries.map((e) => e.capability))];

      return reply.send({
        workspace,
        total_agents: agents.length,
        unique_capabilities: allCaps.length,
        capabilities: allCaps,
        trend: entries,
      });
    },
  );

  // F-228: Agent registration rate
  app.get(
    "/api/v1/workspaces/:workspace/agents/registration-rate",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const agents = db
        .prepare(`SELECT created_at FROM agents WHERE workspace_id = ?`)
        .all(workspace) as { created_at: string }[];

      const daily: Record<string, number> = {};
      for (const a of agents) {
        const day = a.created_at.slice(0, 10);
        daily[day] = (daily[day] || 0) + 1;
      }

      const days = Object.entries(daily)
        .map(([day, count]) => ({ day, count }))
        .sort((a, b) => a.day.localeCompare(b.day));

      const totalDays = days.length;
      const avgPerDay = totalDays > 0 ? Math.round((agents.length / totalDays) * 100) / 100 : 0;
      const peakDay =
        days.length > 0 ? days.reduce((max, d) => (d.count > max.count ? d : max), days[0]) : null;

      return reply.send({
        workspace,
        total_agents: agents.length,
        total_days: totalDays,
        avg_registrations_per_day: avgPerDay,
        peak_day: peakDay,
        daily: days,
      });
    },
  );

  // F-233: Agent capability frequency
  app.get(
    "/api/v1/workspaces/:workspace/agents/capability-frequency",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const agents = db
        .prepare(`SELECT capabilities FROM agents WHERE workspace_id = ?`)
        .all(workspace) as { capabilities: string }[];

      const freq: Record<string, number> = {};
      for (const a of agents) {
        const caps = JSON.parse(a.capabilities || "[]") as string[];
        for (const cap of caps) {
          freq[cap] = (freq[cap] || 0) + 1;
        }
      }

      const capabilities = Object.entries(freq)
        .map(([capability, count]) => ({
          capability,
          count,
          percentage: agents.length > 0 ? Math.round((count / agents.length) * 10000) / 100 : 0,
        }))
        .sort((a, b) => b.count - a.count);

      return reply.send({
        workspace,
        total_agents: agents.length,
        unique_capabilities: capabilities.length,
        capabilities,
      });
    },
  );

  // F-239: Agent status distribution
  app.get(
    "/api/v1/workspaces/:workspace/agents/status-distribution",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const agents = db
        .prepare(`SELECT status FROM agents WHERE workspace_id = ?`)
        .all(workspace) as { status: string }[];

      const distribution: Record<string, number> = {};
      for (const a of agents) {
        distribution[a.status] = (distribution[a.status] || 0) + 1;
      }

      const statuses = Object.entries(distribution)
        .map(([status, count]) => ({
          status,
          count,
          percentage: agents.length > 0 ? Math.round((count / agents.length) * 10000) / 100 : 0,
        }))
        .sort((a, b) => b.count - a.count);

      return reply.send({
        workspace,
        total_agents: agents.length,
        statuses,
      });
    },
  );

  // F-245: Agent last activity
  app.get(
    "/api/v1/workspaces/:workspace/agents/last-activity",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const agents = db
        .prepare(
          `SELECT agent_id, display_name, last_heartbeat_at, updated_at FROM agents WHERE workspace_id = ?`,
        )
        .all(workspace) as {
        agent_id: string;
        display_name: string;
        last_heartbeat_at: string | null;
        updated_at: string;
      }[];

      const now = Date.now();
      const result = agents
        .map((a) => {
          const lastActive = a.last_heartbeat_at || a.updated_at;
          const idleHours = lastActive
            ? Math.round(((now - new Date(lastActive).getTime()) / 3600000) * 100) / 100
            : null;
          return {
            agent_id: a.agent_id,
            display_name: a.display_name,
            last_active: lastActive,
            idle_hours: idleHours,
          };
        })
        .sort((a, b) => (b.idle_hours ?? 0) - (a.idle_hours ?? 0));

      return reply.send({ workspace, agents: result });
    },
  );

  // F-250: Agent workload balance
  app.get(
    "/api/v1/workspaces/:workspace/agents/workload-balance",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const agents = db
        .prepare(`SELECT agent_id, display_name FROM agents WHERE workspace_id = ?`)
        .all(workspace) as { agent_id: string; display_name: string }[];

      const agentWorkloads = agents.map((a) => {
        const claims = (
          db
            .prepare(
              `SELECT COUNT(*) as c FROM claims WHERE workspace_id = ? AND agent_id = ? AND status = 'active'`,
            )
            .get(workspace, a.agent_id) as { c: number }
        ).c;
        const handoffs = (
          db
            .prepare(
              `SELECT COUNT(*) as c FROM handoffs WHERE workspace_id = ? AND to_agent_id = ? AND status = 'pending'`,
            )
            .get(workspace, a.agent_id) as { c: number }
        ).c;
        const blockers = (
          db
            .prepare(
              `SELECT COUNT(*) as c FROM blockers WHERE workspace_id = ? AND agent_id = ? AND status = 'open'`,
            )
            .get(workspace, a.agent_id) as { c: number }
        ).c;
        const total = claims + handoffs + blockers;
        return {
          agent_id: a.agent_id,
          display_name: a.display_name,
          active_claims: claims,
          pending_handoffs: handoffs,
          open_blockers: blockers,
          total_workload: total,
        };
      });

      agentWorkloads.sort((a, b) => b.total_workload - a.total_workload);
      const avg =
        agents.length > 0
          ? Math.round(
              (agentWorkloads.reduce((s, a) => s + a.total_workload, 0) / agents.length) * 100,
            ) / 100
          : 0;
      const max = agentWorkloads.length > 0 ? agentWorkloads[0].total_workload : 0;
      const min =
        agentWorkloads.length > 0 ? agentWorkloads[agentWorkloads.length - 1].total_workload : 0;

      return reply.send({
        workspace,
        total_agents: agents.length,
        avg_workload: avg,
        max_workload: max,
        min_workload: min,
        imbalance: max - min,
        agents: agentWorkloads,
      });
    },
  );

  // F-255: Agent task summary
  app.get(
    "/api/v1/workspaces/:workspace/agents/task-summary",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const tasks = db
        .prepare(`SELECT agent_id, status FROM agent_tasks WHERE workspace_id = ?`)
        .all(workspace) as { agent_id: string; status: string }[];

      const agentMap: Record<string, Record<string, number>> = {};
      for (const t of tasks) {
        if (!agentMap[t.agent_id]) agentMap[t.agent_id] = {};
        agentMap[t.agent_id][t.status] = (agentMap[t.agent_id][t.status] || 0) + 1;
      }

      const agents = Object.entries(agentMap)
        .map(([agent_id, statuses]) => {
          const total = Object.values(statuses).reduce((s, v) => s + v, 0);
          return { agent_id, total_tasks: total, by_status: statuses };
        })
        .sort((a, b) => b.total_tasks - a.total_tasks);

      return reply.send({ workspace, total_tasks: tasks.length, agents });
    },
  );

  // F-259 agent-idle-time
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/idle-time",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params;
      const now = Date.now();
      const agents = db
        .prepare(
          "SELECT agent_id, display_name, status, last_heartbeat_at, created_at FROM agents WHERE workspace_id = ?",
        )
        .all(workspace) as {
        agent_id: string;
        display_name: string;
        status: string;
        last_heartbeat_at: string | null;
        created_at: string;
      }[];

      const result = agents
        .map((a) => {
          const lastActive = a.last_heartbeat_at || a.created_at;
          const idleMs = now - new Date(lastActive).getTime();
          return {
            agent_id: a.agent_id,
            display_name: a.display_name,
            status: a.status,
            idle_seconds: Math.max(0, Math.round(idleMs / 1000)),
            last_active_at: lastActive,
          };
        })
        .sort((a, b) => b.idle_seconds - a.idle_seconds);

      return reply.send({ workspace, agents: result });
    },
  );

  // F-265 agent-heartbeat-gap
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/heartbeat-gap",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params;
      const agents = db
        .prepare(
          "SELECT agent_id, display_name, status, last_heartbeat_at, created_at FROM agents WHERE workspace_id = ?",
        )
        .all(workspace) as {
        agent_id: string;
        display_name: string;
        status: string;
        last_heartbeat_at: string | null;
        created_at: string;
      }[];

      const now = Date.now();
      const result = agents
        .filter((a) => a.last_heartbeat_at)
        .map((a) => {
          const gapMs = now - new Date(a.last_heartbeat_at!).getTime();
          return {
            agent_id: a.agent_id,
            display_name: a.display_name,
            status: a.status,
            gap_seconds: Math.round(gapMs / 1000),
            last_heartbeat_at: a.last_heartbeat_at,
          };
        })
        .sort((a, b) => b.gap_seconds - a.gap_seconds);

      const avgGap =
        result.length > 0
          ? Math.round(result.reduce((s, r) => s + r.gap_seconds, 0) / result.length)
          : 0;

      return reply.send({
        workspace,
        total_agents: result.length,
        avg_gap_seconds: avgGap,
        agents: result,
      });
    },
  );

  // F-270 agent-collaboration-history
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/collaboration-history",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params;
      const rows = db
        .prepare(
          `SELECT from_agent_id, to_agent_id, status, DATE(created_at) AS day
           FROM handoffs WHERE workspace_id = ?
           ORDER BY created_at DESC LIMIT 200`,
        )
        .all(workspace) as {
        from_agent_id: string;
        to_agent_id: string;
        status: string;
        day: string;
      }[];

      const pairs: Record<
        string,
        { total: number; accepted: number; rejected: number; days: Set<string> }
      > = {};
      for (const r of rows) {
        const key = `${r.from_agent_id}->${r.to_agent_id}`;
        if (!pairs[key]) pairs[key] = { total: 0, accepted: 0, rejected: 0, days: new Set() };
        pairs[key].total++;
        if (r.status === "accepted" || r.status === "completed") pairs[key].accepted++;
        if (r.status === "rejected") pairs[key].rejected++;
        pairs[key].days.add(r.day);
      }

      const result = Object.entries(pairs)
        .map(([pair, data]) => ({
          pair,
          total: data.total,
          accepted: data.accepted,
          rejected: data.rejected,
          active_days: data.days.size,
        }))
        .sort((a, b) => b.total - a.total);

      return reply.send({ workspace, total_interactions: rows.length, collaborations: result });
    },
  );

  // F-277 agent-registration-trend
  app.get<{ Params: { workspace: string }; Querystring: { days?: number } }>(
    "/api/v1/workspaces/:workspace/agents/registration-trend",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const days = req.query.days ?? 30;
      const rows = db
        .prepare(
          `SELECT date(created_at) as day, COUNT(*) as count
           FROM agents
           WHERE workspace_id = ? AND created_at >= datetime('now', '-' || ? || ' days')
           GROUP BY day ORDER BY day`,
        )
        .all(req.params.workspace, days) as { day: string; count: number }[];
      const total = rows.reduce((s, r) => s + r.count, 0);
      reply.send({ workspace: req.params.workspace, days, trend: rows, total });
    },
  );

  // F-281 agent-skill-overlap
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/skill-overlap",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT agent_id, display_name, capabilities
           FROM agents
           WHERE workspace_id = ?
           ORDER BY display_name`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        capabilities: string;
      }[];
      const capSet = new Set<string>();
      const matrix = rows.map((r) => {
        const caps: string[] = r.capabilities ? JSON.parse(r.capabilities) : [];
        for (const c of caps) capSet.add(c);
        return { agent_id: r.agent_id, display_name: r.display_name, capabilities: caps };
      });
      reply.send({
        workspace: req.params.workspace,
        agents: matrix,
        all_capabilities: [...capSet].sort(),
      });
    },
  );

  // F-283 agent-model-breakdown
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/model-breakdown",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT COALESCE(model, 'unknown') as model, COUNT(*) as count
           FROM agents
           WHERE workspace_id = ?
           GROUP BY model
           ORDER BY count DESC`,
        )
        .all(req.params.workspace) as { model: string; count: number }[];
      const total = rows.reduce((s, r) => s + r.count, 0);
      reply.send({ workspace: req.params.workspace, distribution: rows, total_agents: total });
    },
  );

  // F-290 agent-session-duration
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/session-duration",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT agent_id, display_name,
                  ROUND((julianday(COALESCE(last_heartbeat_at, created_at)) - julianday(created_at)) * 24, 2) as hours_active
           FROM agents
           WHERE workspace_id = ?
           ORDER BY hours_active DESC`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        hours_active: number;
      }[];
      const avg =
        rows.length > 0
          ? Math.round((rows.reduce((s, r) => s + r.hours_active, 0) / rows.length) * 100) / 100
          : 0;
      reply.send({ workspace: req.params.workspace, agents: rows, avg_hours: avg });
    },
  );

  // F-293 agent-tag-distribution
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/tag-distribution",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const agents = db
        .prepare("SELECT tags FROM agents WHERE workspace_id = ?")
        .all(req.params.workspace) as { tags: string | null }[];

      const tagCounts: Record<string, number> = {};
      for (const a of agents) {
        try {
          const parsed = JSON.parse(a.tags || "[]") as string[];
          for (const t of parsed) {
            tagCounts[t] = (tagCounts[t] || 0) + 1;
          }
        } catch {
          /* skip malformed */
        }
      }

      const tags = Object.entries(tagCounts)
        .map(([tag, agent_count]) => ({ tag, agent_count }))
        .sort((a, b) => b.agent_count - a.agent_count);

      reply.send({ workspace: req.params.workspace, tags });
    },
  );

  // F-295 capability-retirement
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/capability-retirement",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const agents = db
        .prepare("SELECT agent_id, display_name, capabilities FROM agents WHERE workspace_id = ?")
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        capabilities: string | null;
      }[];

      const recentTags = db
        .prepare(
          `SELECT DISTINCT capability_tag FROM handoffs
           WHERE workspace_id = ? AND created_at >= datetime('now', '-7 days')
             AND capability_tag IS NOT NULL`,
        )
        .all(req.params.workspace) as { capability_tag: string }[];

      const usedSet = new Set(recentTags.map((r) => r.capability_tag));

      const results = agents.map((a) => {
        let caps: string[] = [];
        try {
          caps = JSON.parse(a.capabilities || "[]") as string[];
        } catch {
          /* skip */
        }
        const retired = caps.filter((c) => !usedSet.has(c));
        return {
          agent_id: a.agent_id,
          display_name: a.display_name,
          total_capabilities: caps.length,
          retired_capabilities: retired,
          retired_count: retired.length,
        };
      });

      reply.send({
        workspace: req.params.workspace,
        agents: results.filter((r) => r.retired_count > 0),
        total_retired: results.reduce((s, r) => s + r.retired_count, 0),
      });
    },
  );

  // F-300 stale-capabilities
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/stale-capabilities",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const agents = db
        .prepare("SELECT agent_id, display_name, capabilities FROM agents WHERE workspace_id = ?")
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        capabilities: string | null;
      }[];

      const usedTags = db
        .prepare(
          `SELECT DISTINCT capability_tag FROM handoffs
           WHERE workspace_id = ? AND capability_tag IS NOT NULL`,
        )
        .all(req.params.workspace) as { capability_tag: string }[];

      const usedSet = new Set(usedTags.map((r) => r.capability_tag));

      const stale = agents
        .map((a) => {
          let caps: string[] = [];
          try {
            caps = JSON.parse(a.capabilities || "[]") as string[];
          } catch {
            /* skip */
          }
          const unused = caps.filter((c) => !usedSet.has(c));
          return {
            agent_id: a.agent_id,
            display_name: a.display_name,
            stale: unused,
            stale_count: unused.length,
          };
        })
        .filter((r) => r.stale_count > 0);

      reply.send({ workspace: req.params.workspace, agents: stale });
    },
  );

  // F-306 multi-workspace
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/multi-workspace",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT a1.agent_id, a1.display_name, COUNT(DISTINCT a2.workspace_id) as workspace_count
           FROM agents a1
           JOIN agents a2 ON a1.agent_id = a2.agent_id
           WHERE a1.workspace_id = ?
           GROUP BY a1.agent_id
           HAVING workspace_count > 1
           ORDER BY workspace_count DESC`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        workspace_count: number;
      }[];
      reply.send({ workspace: req.params.workspace, agents: rows });
    },
  );

  // F-311 capability-rarity
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/capability-rarity",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const agents = db
        .prepare("SELECT agent_id, capabilities FROM agents WHERE workspace_id = ?")
        .all(req.params.workspace) as {
        agent_id: string;
        capabilities: string | null;
      }[];

      const capCount: Record<string, string[]> = {};
      for (const a of agents) {
        let caps: string[] = [];
        try {
          caps = JSON.parse(a.capabilities || "[]") as string[];
        } catch {
          /* skip */
        }
        for (const c of caps) {
          if (!capCount[c]) capCount[c] = [];
          capCount[c].push(a.agent_id);
        }
      }

      const rare = Object.entries(capCount)
        .map(([capability, agentIds]) => ({
          capability,
          agent_count: agentIds.length,
          agents: agentIds,
        }))
        .sort((a, b) => a.agent_count - b.agent_count);

      reply.send({ workspace: req.params.workspace, capabilities: rare });
    },
  );

  // F-315 recent-deregistrations
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/recent-deregistrations",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT agent_id, display_name, status, updated_at
           FROM agents
           WHERE workspace_id = ? AND status = 'offline'
           ORDER BY updated_at DESC
           LIMIT 20`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        status: string;
        updated_at: string | null;
      }[];
      reply.send({ workspace: req.params.workspace, agents: rows });
    },
  );

  // F-319 capability-load
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/capability-load",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const agents = db
        .prepare("SELECT capabilities FROM agents WHERE workspace_id = ?")
        .all(req.params.workspace) as { capabilities: string | null }[];

      const supply: Record<string, number> = {};
      for (const a of agents) {
        let caps: string[] = [];
        try {
          caps = JSON.parse(a.capabilities || "[]") as string[];
        } catch {
          /* skip */
        }
        for (const c of caps) {
          supply[c] = (supply[c] || 0) + 1;
        }
      }

      const demand = db
        .prepare(
          `SELECT capability_tag, COUNT(*) as request_count
           FROM handoffs
           WHERE workspace_id = ? AND capability_tag IS NOT NULL
           GROUP BY capability_tag`,
        )
        .all(req.params.workspace) as {
        capability_tag: string;
        request_count: number;
      }[];

      const allCaps = new Set([...Object.keys(supply), ...demand.map((d) => d.capability_tag)]);
      const result = [...allCaps]
        .map((cap) => {
          const demandRow = demand.find((d) => d.capability_tag === cap);
          return {
            capability: cap,
            supply: supply[cap] || 0,
            demand: demandRow?.request_count || 0,
          };
        })
        .sort((a, b) => b.demand - b.supply - (a.demand - a.supply));

      reply.send({ workspace: req.params.workspace, capabilities: result });
    },
  );

  // F-324 heartbeat-consistency
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/heartbeat-consistency",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT agent_id, display_name, last_heartbeat_at,
                  (julianday('now') - julianday(last_heartbeat_at)) * 86400 as seconds_since_heartbeat
           FROM agents
           WHERE workspace_id = ? AND last_heartbeat_at IS NOT NULL
           ORDER BY seconds_since_heartbeat ASC`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        last_heartbeat_at: string;
        seconds_since_heartbeat: number;
      }[];
      const avg =
        rows.length > 0 ? rows.reduce((s, r) => s + r.seconds_since_heartbeat, 0) / rows.length : 0;
      reply.send({
        workspace: req.params.workspace,
        agents: rows,
        avg_seconds_since_heartbeat: avg,
      });
    },
  );

  // F-327 task-backlog
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/task-backlog",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT at.agent_id, a.display_name, COUNT(*) as pending_tasks
           FROM agent_tasks at
           JOIN agents a ON a.agent_id = at.agent_id AND a.workspace_id = at.workspace_id
           WHERE at.workspace_id = ? AND at.status = 'pending'
           GROUP BY at.agent_id
           ORDER BY pending_tasks DESC
           LIMIT 20`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        pending_tasks: number;
      }[];
      reply.send({ workspace: req.params.workspace, agents: rows });
    },
  );

  // F-332 idle-duration
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/idle-duration",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT agent_id, display_name, status, last_heartbeat_at,
                  CAST((julianday('now') - julianday(last_heartbeat_at)) * 86400 AS INTEGER) AS idle_seconds
           FROM agents
           WHERE workspace_id = ? AND last_heartbeat_at IS NOT NULL
           ORDER BY idle_seconds DESC
           LIMIT 20`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        status: string;
        last_heartbeat_at: string;
        idle_seconds: number;
      }[];
      reply.send({ workspace: req.params.workspace, agents: rows });
    },
  );

  // F-337 capability-overlap-matrix
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/capability-overlap-matrix",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const agents = db
        .prepare(
          `SELECT agent_id, display_name, capabilities
           FROM agents
           WHERE workspace_id = ? AND status = 'online'`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        capabilities: string;
      }[];

      const pairs: { agent_a: string; agent_b: string; shared: string[] }[] = [];
      for (let i = 0; i < agents.length; i++) {
        const capsA = new Set<string>(JSON.parse(agents[i].capabilities || "[]"));
        for (let j = i + 1; j < agents.length; j++) {
          const capsB: string[] = JSON.parse(agents[j].capabilities || "[]");
          const shared = capsB.filter((c) => capsA.has(c));
          if (shared.length > 0) {
            pairs.push({
              agent_a: agents[i].agent_id,
              agent_b: agents[j].agent_id,
              shared,
            });
          }
        }
      }
      reply.send({ workspace: req.params.workspace, overlaps: pairs });
    },
  );

  // F-342 metadata-size-stats
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/metadata-size-stats",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS total,
                  AVG(LENGTH(metadata)) AS avg_size,
                  MAX(LENGTH(metadata)) AS max_size,
                  MIN(LENGTH(metadata)) AS min_size
           FROM agents
           WHERE workspace_id = ? AND metadata IS NOT NULL`,
        )
        .get(req.params.workspace) as {
        total: number;
        avg_size: number | null;
        max_size: number | null;
        min_size: number | null;
      };
      reply.send({ workspace: req.params.workspace, ...row });
    },
  );

  // F-347 last-activity-summary
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/last-activity-summary",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT a.agent_id, a.display_name,
                  al.action AS last_action,
                  al.created_at AS last_activity_at
           FROM agents a
           LEFT JOIN audit_log al ON al.actor_id = a.agent_id
             AND al.workspace_id = a.workspace_id
             AND al.audit_id = (
               SELECT audit_id FROM audit_log
               WHERE actor_id = a.agent_id AND workspace_id = a.workspace_id
               ORDER BY created_at DESC LIMIT 1
             )
           WHERE a.workspace_id = ?
           ORDER BY al.created_at DESC NULLS LAST
           LIMIT 20`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        last_action: string | null;
        last_activity_at: string | null;
      }[];
      reply.send({ workspace: req.params.workspace, agents: rows });
    },
  );

  // F-351 tag-usage-stats
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/tag-usage-stats",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const agents = db
        .prepare(`SELECT tags FROM agents WHERE workspace_id = ? AND tags IS NOT NULL`)
        .all(req.params.workspace) as { tags: string }[];

      const counts: Record<string, number> = {};
      for (const a of agents) {
        try {
          const arr: string[] = JSON.parse(a.tags);
          for (const t of arr) {
            counts[t] = (counts[t] || 0) + 1;
          }
        } catch {}
      }
      const stats = Object.entries(counts)
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count);
      reply.send({ workspace: req.params.workspace, tags: stats });
    },
  );

  // F-356 capability-count-ranking
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/capability-count-ranking",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const agents = db
        .prepare(
          `SELECT agent_id, display_name, capabilities
           FROM agents
           WHERE workspace_id = ?
           ORDER BY agent_id`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        capabilities: string;
      }[];

      const ranking = agents
        .map((a) => {
          let count = 0;
          try {
            count = JSON.parse(a.capabilities || "[]").length;
          } catch {}
          return { agent_id: a.agent_id, display_name: a.display_name, capability_count: count };
        })
        .sort((a, b) => b.capability_count - a.capability_count);

      reply.send({ workspace: req.params.workspace, ranking });
    },
  );

  // F-361 uptime-leaderboard
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/uptime-leaderboard",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT agent_id, display_name, created_at, last_heartbeat_at,
                  CAST((julianday(COALESCE(last_heartbeat_at, 'now')) - julianday(created_at)) * 86400 AS INTEGER) AS uptime_seconds
           FROM agents
           WHERE workspace_id = ? AND status = 'online'
           ORDER BY uptime_seconds DESC
           LIMIT 20`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        created_at: string;
        last_heartbeat_at: string;
        uptime_seconds: number;
      }[];
      reply.send({ workspace: req.params.workspace, leaderboard: rows });
    },
  );

  // F-365 agent-heartbeat-frequency
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/heartbeat-frequency",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT agent_id, display_name,
                  CAST((julianday(last_heartbeat_at) - julianday(created_at)) * 86400 AS INTEGER) AS total_seconds,
                  last_heartbeat_at, created_at
           FROM agents
           WHERE workspace_id = ? AND last_heartbeat_at IS NOT NULL
           ORDER BY last_heartbeat_at DESC`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        total_seconds: number;
        last_heartbeat_at: string;
        created_at: string;
      }[];
      reply.send({ workspace: req.params.workspace, agents: rows });
    },
  );

  // F-371 agent-registration-age
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/registration-age",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT agent_id, display_name, created_at,
                  CAST((julianday('now') - julianday(created_at)) * 86400 AS INTEGER) AS age_seconds
           FROM agents
           WHERE workspace_id = ?
           ORDER BY age_seconds DESC`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        created_at: string;
        age_seconds: number;
      }[];
      reply.send({ workspace: req.params.workspace, agents: rows });
    },
  );

  // F-376 agent-online-offline-ratio
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/online-offline-ratio",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS online,
                  SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) AS offline
           FROM agents
           WHERE workspace_id = ?`,
        )
        .get(req.params.workspace) as { total: number; online: number; offline: number };
      const ratio = row.offline > 0 ? row.online / row.offline : row.online > 0 ? Infinity : 0;
      reply.send({
        workspace: req.params.workspace,
        ...row,
        ratio: Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : null,
      });
    },
  );

  // F-381 agent-capability-diversity
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/capability-diversity",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT agent_id, display_name, capabilities
           FROM agents
           WHERE workspace_id = ?`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        capabilities: string;
      }[];
      const result = rows.map((r) => {
        let caps: string[] = [];
        try {
          caps = JSON.parse(r.capabilities || "[]");
        } catch {}
        return {
          agent_id: r.agent_id,
          display_name: r.display_name,
          unique_capabilities: caps.length,
        };
      });
      result.sort((a, b) => b.unique_capabilities - a.unique_capabilities);
      reply.send({ workspace: req.params.workspace, agents: result });
    },
  );

  // F-387 agent-task-status-summary
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/task-status-summary",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT a.agent_id, a.display_name, t.status, COUNT(*) AS count
           FROM agent_tasks t
           JOIN agents a ON a.agent_id = t.agent_id
           WHERE t.workspace_id = ?
           GROUP BY a.agent_id, t.status
           ORDER BY count DESC`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        status: string;
        count: number;
      }[];
      reply.send({ workspace: req.params.workspace, summary: rows });
    },
  );

  // F-392 group-member-count
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/group-member-count",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT COALESCE("group", 'ungrouped') AS agent_group, COUNT(*) AS count
           FROM agents
           WHERE workspace_id = ?
           GROUP BY agent_group
           ORDER BY count DESC`,
        )
        .all(req.params.workspace) as { agent_group: string; count: number }[];
      reply.send({ workspace: req.params.workspace, groups: rows });
    },
  );

  // F-397 recently-updated
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/recently-updated",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT agent_id, display_name, status, updated_at
           FROM agents
           WHERE workspace_id = ?
           ORDER BY updated_at DESC
           LIMIT 20`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        status: string;
        updated_at: string;
      }[];
      reply.send({ workspace: req.params.workspace, agents: rows });
    },
  );

  // F-401 heartbeat-gap-analysis
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/heartbeat-gap-analysis",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT agent_id, display_name, status, last_heartbeat_at,
                  CAST((strftime('%s','now') - strftime('%s', last_heartbeat_at)) AS INTEGER) AS gap_seconds
           FROM agents
           WHERE workspace_id = ? AND last_heartbeat_at IS NOT NULL
           ORDER BY gap_seconds DESC
           LIMIT 20`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        status: string;
        last_heartbeat_at: string;
        gap_seconds: number;
      }[];
      reply.send({ workspace: req.params.workspace, agents: rows });
    },
  );

  // F-402 tag-co-occurrence
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/tag-co-occurrence",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const agents = db
        .prepare(
          `SELECT tags FROM agents WHERE workspace_id = ? AND tags IS NOT NULL AND tags != '[]'`,
        )
        .all(req.params.workspace) as { tags: string }[];
      const pairCounts: Record<string, number> = {};
      for (const row of agents) {
        let parsed: string[];
        try {
          parsed = JSON.parse(row.tags);
        } catch {
          continue;
        }
        if (!Array.isArray(parsed)) continue;
        const sorted = [...new Set(parsed)].sort();
        for (let i = 0; i < sorted.length; i++) {
          for (let j = i + 1; j < sorted.length; j++) {
            const key = sorted[i] + " + " + sorted[j];
            pairCounts[key] = (pairCounts[key] || 0) + 1;
          }
        }
      }
      const pairs = Object.entries(pairCounts)
        .map(([pair, count]) => ({ pair, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);
      reply.send({ workspace: req.params.workspace, pairs });
    },
  );

  // F-407 capabilities-per-agent
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/capabilities-per-agent",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const agents = db
        .prepare(`SELECT agent_id, display_name, capabilities FROM agents WHERE workspace_id = ?`)
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        capabilities: string;
      }[];
      const result = agents
        .map((a) => {
          let count = 0;
          try {
            const parsed = JSON.parse(a.capabilities);
            if (Array.isArray(parsed)) count = parsed.length;
          } catch {}
          return { agent_id: a.agent_id, display_name: a.display_name, capability_count: count };
        })
        .sort((a, b) => b.capability_count - a.capability_count);
      reply.send({ workspace: req.params.workspace, agents: result });
    },
  );

  // F-412 idle-time-histogram
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/idle-time-histogram",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT
             CASE
               WHEN last_heartbeat_at IS NULL THEN 'never'
               WHEN (strftime('%s','now') - strftime('%s', last_heartbeat_at)) < 60 THEN '<1m'
               WHEN (strftime('%s','now') - strftime('%s', last_heartbeat_at)) < 300 THEN '1-5m'
               WHEN (strftime('%s','now') - strftime('%s', last_heartbeat_at)) < 3600 THEN '5-60m'
               ELSE '>1h'
             END AS bucket,
             COUNT(*) AS count
           FROM agents
           WHERE workspace_id = ?
           GROUP BY bucket
           ORDER BY count DESC`,
        )
        .all(req.params.workspace) as { bucket: string; count: number }[];
      reply.send({ workspace: req.params.workspace, histogram: rows });
    },
  );

  // F-418 model-version-matrix
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/model-version-matrix",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT model, status, COUNT(*) AS count
           FROM agents
           WHERE workspace_id = ?
           GROUP BY model, status
           ORDER BY count DESC`,
        )
        .all(req.params.workspace) as {
        model: string;
        status: string;
        count: number;
      }[];
      reply.send({ workspace: req.params.workspace, matrix: rows });
    },
  );

  // F-424 agent-uptime-ranking
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/agent-uptime-ranking",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT agent_id, display_name, created_at,
                  CAST((julianday('now') - julianday(created_at)) * 86400 AS INTEGER) AS uptime_seconds
           FROM agents
           WHERE workspace_id = ? AND status = 'online'
           ORDER BY created_at ASC
           LIMIT 20`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        created_at: string;
        uptime_seconds: number;
      }[];
      reply.send({ workspace: req.params.workspace, agents: rows });
    },
  );

  // F-428 agent-display-name-length
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/agent-display-name-length",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS total,
                  AVG(LENGTH(display_name)) AS avg_length,
                  MAX(LENGTH(display_name)) AS max_length,
                  MIN(LENGTH(display_name)) AS min_length
           FROM agents
           WHERE workspace_id = ?`,
        )
        .get(req.params.workspace) as {
        total: number;
        avg_length: number | null;
        max_length: number | null;
        min_length: number | null;
      };
      reply.send({ workspace: req.params.workspace, ...row });
    },
  );

  // F-433 agent-tag-diversity
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/agent-tag-diversity",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const agents = db
        .prepare(`SELECT agent_id, display_name, tags FROM agents WHERE workspace_id = ?`)
        .all(req.params.workspace) as { agent_id: string; display_name: string; tags: string }[];
      const tagSet = new Set<string>();
      const agentTagCounts: { agent_id: string; display_name: string; tag_count: number }[] = [];
      for (const a of agents) {
        let parsed: string[] = [];
        try {
          parsed = JSON.parse(a.tags || "[]");
        } catch {}
        for (const t of parsed) tagSet.add(t);
        agentTagCounts.push({
          agent_id: a.agent_id,
          display_name: a.display_name,
          tag_count: parsed.length,
        });
      }
      reply.send({
        workspace: req.params.workspace,
        unique_tags: tagSet.size,
        agents: agentTagCounts.sort((a, b) => b.tag_count - a.tag_count).slice(0, 20),
      });
    },
  );

  // F-441 agent-status-transition
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/agent-status-transition",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT old_status, new_status, COUNT(*) AS transition_count
           FROM agent_status_history
           WHERE workspace_id = ?
           GROUP BY old_status, new_status
           ORDER BY transition_count DESC
           LIMIT 20`,
        )
        .all(req.params.workspace) as {
        old_status: string;
        new_status: string;
        transition_count: number;
      }[];
      reply.send({ workspace: req.params.workspace, transitions: rows });
    },
  );

  // F-446 agent-model-version
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/agent-model-version",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT COALESCE(model, 'unknown') AS model, COUNT(*) AS agent_count
           FROM agents
           WHERE workspace_id = ?
           GROUP BY model
           ORDER BY agent_count DESC`,
        )
        .all(req.params.workspace) as {
        model: string;
        agent_count: number;
      }[];
      reply.send({ workspace: req.params.workspace, models: rows });
    },
  );

  // F-451 agent-task-completion
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/agent-task-completion",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT agent_id, 
                  COUNT(*) AS total_tasks,
                  SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
                  ROUND(SUM(CASE WHEN status = 'completed' THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 2) AS completion_pct
           FROM agent_tasks
           WHERE workspace_id = ?
           GROUP BY agent_id
           ORDER BY completion_pct DESC
           LIMIT 20`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        total_tasks: number;
        completed: number;
        completion_pct: number;
      }[];
      reply.send({ workspace: req.params.workspace, agents: rows });
    },
  );

  // F-456 agent-metadata-keys
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/agent-metadata-keys",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const agents = db
        .prepare(`SELECT metadata FROM agents WHERE workspace_id = ? AND metadata IS NOT NULL`)
        .all(req.params.workspace) as { metadata: string }[];
      const keyCounts: Record<string, number> = {};
      for (const a of agents) {
        try {
          const parsed = JSON.parse(a.metadata);
          if (parsed && typeof parsed === "object") {
            for (const k of Object.keys(parsed)) {
              keyCounts[k] = (keyCounts[k] || 0) + 1;
            }
          }
        } catch {}
      }
      const keys = Object.entries(keyCounts)
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 30);
      reply.send({ workspace: req.params.workspace, keys });
    },
  );

  // F-462 agent-capability-count
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/agent-capability-count",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const agents = db
        .prepare(`SELECT agent_id, display_name, capabilities FROM agents WHERE workspace_id = ?`)
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        capabilities: string;
      }[];
      const result = agents
        .map((a) => {
          let count = 0;
          try {
            count = JSON.parse(a.capabilities || "[]").length;
          } catch {}
          return { agent_id: a.agent_id, display_name: a.display_name, capability_count: count };
        })
        .sort((a, b) => b.capability_count - a.capability_count)
        .slice(0, 20);
      reply.send({ workspace: req.params.workspace, agents: result });
    },
  );

  // F-466 agent-group-distribution
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/agent-group-distribution",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT COALESCE("group", '(none)') AS agent_group, COUNT(*) AS count
           FROM agents
           WHERE workspace_id = ?
           GROUP BY "group"
           ORDER BY count DESC`,
        )
        .all(req.params.workspace) as {
        agent_group: string;
        count: number;
      }[];
      reply.send({ workspace: req.params.workspace, groups: rows });
    },
  );

  // F-469 agent-last-seen-ranking
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/agent-last-seen-ranking",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT agent_id, display_name, status, last_heartbeat_at,
                  RANK() OVER (ORDER BY last_heartbeat_at DESC) AS rank
           FROM agents
           WHERE workspace_id = ?
           ORDER BY rank
           LIMIT 20`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        status: string;
        last_heartbeat_at: string | null;
        rank: number;
      }[];
      reply.send({ workspace: req.params.workspace, agents: rows });
    },
  );

  // F-477 agent-status-transition-matrix
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/agent-status-transition-matrix",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT old_status, new_status, COUNT(*) AS transition_count
           FROM agent_status_history
           WHERE workspace_id = ?
           GROUP BY old_status, new_status
           ORDER BY transition_count DESC`,
        )
        .all(req.params.workspace) as {
        old_status: string;
        new_status: string;
        transition_count: number;
      }[];
      reply.send({ workspace: req.params.workspace, transitions: rows });
    },
  );

  // F-480 agent-tag-frequency
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/agent-tag-frequency",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const agents = db
        .prepare(
          `SELECT tags FROM agents WHERE workspace_id = ? AND tags IS NOT NULL AND tags != '[]'`,
        )
        .all(req.params.workspace) as { tags: string }[];
      const freq: Record<string, number> = {};
      for (const a of agents) {
        try {
          const arr = JSON.parse(a.tags);
          if (Array.isArray(arr)) {
            for (const t of arr) freq[t] = (freq[t] || 0) + 1;
          }
        } catch {}
      }
      const sorted = Object.entries(freq)
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count);
      reply.send({ workspace: req.params.workspace, tags: sorted });
    },
  );

  // F-484 agent-metadata-key-count
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/agent-metadata-key-count",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const agents = db
        .prepare(
          `SELECT agent_id, display_name, metadata FROM agents WHERE workspace_id = ? AND metadata IS NOT NULL`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        metadata: string;
      }[];
      const result = agents.map((a) => {
        let key_count = 0;
        try {
          const obj = JSON.parse(a.metadata);
          if (obj && typeof obj === "object") key_count = Object.keys(obj).length;
        } catch {}
        return { agent_id: a.agent_id, display_name: a.display_name, key_count };
      });
      result.sort((a, b) => b.key_count - a.key_count);
      reply.send({ workspace: req.params.workspace, agents: result });
    },
  );

  // F-493 agent-task-priority-breakdown
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/agent-task-priority-breakdown",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT at2.agent_id, a.display_name, at2.priority, COUNT(*) AS count
           FROM agent_tasks at2
           JOIN agents a ON a.agent_id = at2.agent_id AND a.workspace_id = at2.workspace_id
           WHERE at2.workspace_id = ?
           GROUP BY at2.agent_id, at2.priority
           ORDER BY at2.agent_id, at2.priority`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        priority: number;
        count: number;
      }[];
      reply.send({ workspace: req.params.workspace, breakdown: rows });
    },
  );

  // F-499 agent-model-capability-matrix
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/agent-model-capability-matrix",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const agents = db
        .prepare(
          `SELECT agent_id, display_name, model, capabilities
           FROM agents
           WHERE workspace_id = ?`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        model: string | null;
        capabilities: string;
      }[];
      const result = agents.map((a) => {
        let caps: string[] = [];
        try {
          const parsed = JSON.parse(a.capabilities);
          if (Array.isArray(parsed)) caps = parsed;
        } catch {}
        return {
          agent_id: a.agent_id,
          display_name: a.display_name,
          model: a.model,
          capabilities: caps,
          capability_count: caps.length,
        };
      });
      reply.send({ workspace: req.params.workspace, matrix: result });
    },
  );

  // F-502 agent-task-completion-trend
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/agents/agent-task-completion-trend",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT DATE(updated_at) AS date, COUNT(*) AS completed_count
           FROM agent_tasks
           WHERE workspace_id = ? AND status = 'completed' AND updated_at IS NOT NULL
           GROUP BY date
           ORDER BY date DESC
           LIMIT 30`,
        )
        .all(req.params.workspace) as { date: string; completed_count: number }[];
      reply.send({ workspace: req.params.workspace, trend: rows });
    },
  );

  // F-511 agent-capability-overlap
  app.get<{ Params: { workspaceId: string } }>(
    "/api/v1/workspaces/:workspaceId/analytics/agent-capability-overlap",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const { workspaceId } = req.params;
      const rows = db
        .prepare("SELECT agent_id, capabilities FROM agents WHERE workspace_id = ?")
        .all(workspaceId) as any[];
      const pairs: { agent_a: string; agent_b: string; shared: string[] }[] = [];
      for (let i = 0; i < rows.length; i++) {
        const capsA = new Set<string>(JSON.parse(rows[i].capabilities || "[]"));
        for (let j = i + 1; j < rows.length; j++) {
          const capsB: string[] = JSON.parse(rows[j].capabilities || "[]");
          const shared = capsB.filter((c: string) => capsA.has(c));
          if (shared.length > 0) {
            pairs.push({ agent_a: rows[i].agent_id, agent_b: rows[j].agent_id, shared });
          }
        }
      }
      return reply.send({ total_pairs: pairs.length, overlaps: pairs });
    },
  );

  // F-519 agent-registration-daily
  app.get<{ Params: { workspaceId: string } }>(
    "/api/v1/workspaces/:workspaceId/analytics/agent-registration-daily",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const { workspaceId } = req.params;
      const rows = db
        .prepare(
          `SELECT DATE(created_at) AS day, COUNT(*) AS registrations
           FROM agents
           WHERE workspace_id = ?
           GROUP BY day
           ORDER BY day DESC
           LIMIT 30`,
        )
        .all(workspaceId) as any[];
      return reply.send(rows);
    },
  );

  // F-524 agent-model-popularity
  app.get<{ Params: { workspaceId: string } }>(
    "/api/v1/workspaces/:workspaceId/analytics/agent-model-popularity",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const { workspaceId } = req.params;
      const rows = db
        .prepare(
          `SELECT COALESCE(model, 'unknown') AS model, COUNT(*) AS agent_count
           FROM agents
           WHERE workspace_id = ?
           GROUP BY model
           ORDER BY agent_count DESC`,
        )
        .all(workspaceId) as any[];
      return reply.send(rows);
    },
  );

  /* ── F-534  agent task batch create ─────────────────────── */
  app.post(
    "/api/v1/workspaces/:workspace/agents/:agentId/tasks/batch",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["tasks"],
          additionalProperties: false,
          properties: {
            tasks: {
              type: "array",
              minItems: 1,
              maxItems: 50,
              items: {
                type: "object",
                required: ["title"],
                additionalProperties: false,
                properties: {
                  title: { type: "string", minLength: 1, maxLength: 256 },
                  description: { type: "string", maxLength: 2000 },
                  priority: { type: "string", enum: ["low", "normal", "high", "critical"] },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace, agentId } = request.params as { workspace: string; agentId: string };
      const { tasks } = request.body as {
        tasks: Array<{ title: string; description?: string; priority?: string }>;
      };
      const agent = db
        .prepare("SELECT agent_id FROM agents WHERE agent_id = ? AND workspace_id = ?")
        .get(agentId, workspace);
      if (!agent) return reply.code(404).send({ error: "Agent not found" });

      const insert = db.prepare(
        "INSERT INTO agent_tasks (task_id, workspace_id, agent_id, title, description, priority) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const created: string[] = [];
      const run = db.transaction(() => {
        for (const t of tasks) {
          const id = taskId();
          insert.run(
            id,
            workspace,
            agentId,
            t.title,
            t.description ?? null,
            t.priority ?? "normal",
          );
          created.push(id);
        }
      });
      run();

      writeAuditLog({
        workspaceId: workspace,
        actorType: "agent",
        actorId: agentId,
        action: "task.batch_create",
        entityType: "task",
        entityId: created[0],
        requestId: request.id,
        payload: { count: created.length },
      });
      broadcast("task.batch_created", { workspace, agentId, task_ids: created });
      return reply.code(201).send({ created: created.length, task_ids: created });
    },
  );

  /* ── F-537  agent capability search ─────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/agents/capability-search",
    {
      preHandler: app.authGuard,
      schema: {
        querystring: {
          type: "object",
          required: ["q"],
          properties: {
            q: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { q } = request.query as { q: string };
      const rows = db
        .prepare(
          "SELECT agent_id, display_name, capabilities, status FROM agents WHERE workspace_id = ?",
        )
        .all(workspace) as Array<{
        agent_id: string;
        display_name: string;
        capabilities: string;
        status: string;
      }>;
      const needle = q.toLowerCase();
      const matches = rows
        .map((r) => {
          const caps: string[] = JSON.parse(r.capabilities || "[]");
          const matched = caps.filter((c) => c.toLowerCase().includes(needle));
          return matched.length > 0
            ? {
                agent_id: r.agent_id,
                display_name: r.display_name,
                status: r.status,
                matched_capabilities: matched,
              }
            : null;
        })
        .filter(Boolean);
      return reply.send({ query: q, total: matches.length, agents: matches });
    },
  );
};

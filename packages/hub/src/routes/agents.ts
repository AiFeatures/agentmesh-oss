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
};

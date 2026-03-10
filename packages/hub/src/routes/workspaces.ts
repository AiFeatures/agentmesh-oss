import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/index.js";
import { writeAuditLog } from "../services/audit.js";
import { workspaceId as generateWorkspaceId } from "../services/ids.js";

export const workspaceRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/api/v1/workspaces",
    {
      preHandler: app.authGuard,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            search: { type: "string", maxLength: 128 },
            archived: { type: "string", enum: ["true", "false"] },
            limit: { type: "string" },
            offset: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const q = request.query as {
        search?: string;
        archived?: string;
        limit?: string;
        offset?: string;
      };

      let sql =
        "SELECT workspace_id, display_name, description, base_path, archived, created_at FROM workspaces WHERE 1=1";
      const params: unknown[] = [];

      if (q.search) {
        sql += " AND (display_name LIKE ? OR workspace_id LIKE ?)";
        const term = `%${q.search}%`;
        params.push(term, term);
      }
      if (q.archived === "true") {
        sql += " AND archived = 1";
      } else if (q.archived === "false") {
        sql += " AND archived = 0";
      }

      const countSql = sql.replace(/^SELECT .+ FROM/, "SELECT COUNT(*) as total FROM");
      const total = (db.prepare(countSql).get(...params) as { total: number }).total;

      sql += " ORDER BY created_at DESC";
      const count = Math.min(200, Math.max(1, Number(q.limit) || 50));
      const start = Math.max(0, Number(q.offset) || 0);
      sql += " LIMIT ? OFFSET ?";
      params.push(count, start);

      const rows = db.prepare(sql).all(...params);
      return reply.send({ data: rows, total });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const row = db
        .prepare(
          "SELECT workspace_id, display_name, description, base_path, created_at FROM workspaces WHERE workspace_id = ?",
        )
        .get(workspace);
      if (!row) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      return reply.send(row);
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/stats",
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
          "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) as online FROM agents WHERE workspace_id = ?",
        )
        .get(workspace) as { total: number; online: number };
      const claims = db
        .prepare(
          "SELECT COUNT(*) as total FROM claims WHERE workspace_id = ? AND status = 'active'",
        )
        .get(workspace) as { total: number };
      const handoffs = db
        .prepare(
          "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending FROM handoffs WHERE workspace_id = ?",
        )
        .get(workspace) as { total: number; pending: number };
      const blockers = db
        .prepare(
          "SELECT COUNT(*) as total, SUM(CASE WHEN status != 'resolved' THEN 1 ELSE 0 END) as open FROM blockers WHERE workspace_id = ?",
        )
        .get(workspace) as { total: number; open: number };

      return reply.send({
        workspace_id: workspace,
        agents: { total: agents.total, online: agents.online },
        claims: { active: claims.total },
        handoffs: { total: handoffs.total, pending: handoffs.pending },
        blockers: { total: blockers.total, open: blockers.open },
      });
    },
  );

  app.patch(
    "/api/v1/workspaces/:workspace",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            display_name: { type: "string", minLength: 1, maxLength: 256 },
            description: { type: "string", maxLength: 2000 },
            base_path: { type: "string", maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const body = request.body as {
        display_name?: string;
        description?: string;
        base_path?: string;
      };

      const ws = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const updates: string[] = [];
      const params: unknown[] = [];
      if (body.display_name !== undefined) {
        updates.push("display_name = ?");
        params.push(body.display_name);
      }
      if (body.base_path !== undefined) {
        updates.push("base_path = ?");
        params.push(body.base_path);
      }
      if (body.description !== undefined) {
        updates.push("description = ?");
        params.push(body.description);
      }
      if (updates.length === 0) {
        return reply.code(400).send({ error: "No fields to update" });
      }

      params.push(workspace);
      db.prepare(`UPDATE workspaces SET ${updates.join(", ")} WHERE workspace_id = ?`).run(
        ...params,
      );

      writeAuditLog({
        workspaceId: workspace,
        actorType: "system",
        action: "workspace.update",
        entityType: "workspace",
        entityId: workspace,
        requestId: request.id,
        payload: body,
      });

      return reply.send({ ok: true });
    },
  );

  app.delete(
    "/api/v1/workspaces/:workspace",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const ws = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      db.prepare("DELETE FROM audit_log WHERE workspace_id = ?").run(workspace);
      db.prepare("DELETE FROM workspaces WHERE workspace_id = ?").run(workspace);

      writeAuditLog({
        actorType: "system",
        action: "workspace.delete",
        entityType: "workspace",
        entityId: workspace,
        requestId: request.id,
      });

      return reply.send({ ok: true });
    },
  );

  /* ── F-59  workspace archive/unarchive ──────────────────────── */
  app.post(
    "/api/v1/workspaces/:workspace/archive",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const ws = db
        .prepare("SELECT workspace_id, archived FROM workspaces WHERE workspace_id = ?")
        .get(workspace) as { workspace_id: string; archived: number } | undefined;
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      if (ws.archived === 1) {
        return reply.code(422).send({ error: "Workspace already archived" });
      }

      db.prepare("UPDATE workspaces SET archived = 1 WHERE workspace_id = ?").run(workspace);

      writeAuditLog({
        workspaceId: workspace,
        actorType: "system",
        action: "workspace.archive",
        entityType: "workspace",
        entityId: workspace,
        requestId: request.id,
      });

      return reply.send({ ok: true });
    },
  );

  app.post(
    "/api/v1/workspaces/:workspace/unarchive",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const ws = db
        .prepare("SELECT workspace_id, archived FROM workspaces WHERE workspace_id = ?")
        .get(workspace) as { workspace_id: string; archived: number } | undefined;
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      if (ws.archived !== 1) {
        return reply.code(422).send({ error: "Workspace is not archived" });
      }

      db.prepare("UPDATE workspaces SET archived = 0 WHERE workspace_id = ?").run(workspace);

      writeAuditLog({
        workspaceId: workspace,
        actorType: "system",
        action: "workspace.unarchive",
        entityType: "workspace",
        entityId: workspace,
        requestId: request.id,
      });

      return reply.send({ ok: true });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/audit",
    {
      preHandler: app.authGuard,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", maxLength: 128 },
            entity_type: { type: "string", maxLength: 64 },
            actor_id: { type: "string", maxLength: 128 },
            created_after: { type: "string", maxLength: 30 },
            created_before: { type: "string", maxLength: 30 },
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const q = request.query as {
        action?: string;
        entity_type?: string;
        actor_id?: string;
        created_after?: string;
        created_before?: string;
        limit: number;
        offset: number;
      };

      const ws = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      let sql = "SELECT * FROM audit_log WHERE workspace_id = ?";
      const params: unknown[] = [workspace];
      if (q.action) {
        sql += " AND action = ?";
        params.push(q.action);
      }
      if (q.entity_type) {
        sql += " AND entity_type = ?";
        params.push(q.entity_type);
      }
      if (q.actor_id) {
        sql += " AND actor_id = ?";
        params.push(q.actor_id);
      }
      if (q.created_after) {
        sql += " AND created_at >= ?";
        params.push(q.created_after);
      }
      if (q.created_before) {
        sql += " AND created_at <= ?";
        params.push(q.created_before);
      }
      sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
      params.push(q.limit, q.offset);

      const rows = db.prepare(sql).all(...params);
      return reply.send({ data: rows });
    },
  );

  app.post(
    "/api/v1/workspaces",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["display_name"],
          additionalProperties: false,
          properties: {
            workspace_id: {
              type: "string",
              minLength: 1,
              maxLength: 128,
              pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$",
            },
            display_name: { type: "string", minLength: 1, maxLength: 256 },
            base_path: { type: "string", maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        workspace_id?: string;
        display_name: string;
        description?: string;
        base_path?: string;
      };
      const id = body.workspace_id ?? generateWorkspaceId();

      try {
        db.prepare(
          "INSERT INTO workspaces (workspace_id, display_name, description, base_path) VALUES (?, ?, ?, ?)",
        ).run(id, body.display_name, body.description ?? null, body.base_path ?? null);
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
          return reply.code(409).send({ error: "Workspace already exists" });
        }
        throw err;
      }

      writeAuditLog({
        workspaceId: id,
        actorType: "system",
        action: "workspace.create",
        entityType: "workspace",
        entityId: id,
        requestId: request.id,
        payload: body,
      });

      return reply.code(201).send({ workspace_id: id });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/metrics",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const ws = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const agentsByStatus = db
        .prepare(
          "SELECT status, COUNT(*) as count FROM agents WHERE workspace_id = ? GROUP BY status",
        )
        .all(workspace) as Array<{ status: string; count: number }>;
      const claimsByStatus = db
        .prepare(
          "SELECT status, COUNT(*) as count FROM claims WHERE workspace_id = ? GROUP BY status",
        )
        .all(workspace) as Array<{ status: string; count: number }>;
      const handoffsByStatus = db
        .prepare(
          "SELECT status, COUNT(*) as count FROM handoffs WHERE workspace_id = ? GROUP BY status",
        )
        .all(workspace) as Array<{ status: string; count: number }>;
      const blockersBySeverity = db
        .prepare(
          "SELECT severity, COUNT(*) as count FROM blockers WHERE workspace_id = ? AND status = 'open' GROUP BY severity",
        )
        .all(workspace) as Array<{ severity: string; count: number }>;
      const auditLast24h = db
        .prepare(
          "SELECT COUNT(*) as count FROM audit_log WHERE workspace_id = ? AND created_at >= datetime('now', '-1 day')",
        )
        .get(workspace) as { count: number };

      return reply.send({
        workspace_id: workspace,
        agents: Object.fromEntries(agentsByStatus.map((r) => [r.status, r.count])),
        claims: Object.fromEntries(claimsByStatus.map((r) => [r.status, r.count])),
        handoffs: Object.fromEntries(handoffsByStatus.map((r) => [r.status, r.count])),
        open_blockers_by_severity: Object.fromEntries(
          blockersBySeverity.map((r) => [r.severity, r.count]),
        ),
        audit_events_24h: auditLast24h.count,
      });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/export",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const ws = db
        .prepare(
          "SELECT workspace_id, display_name, base_path, created_at FROM workspaces WHERE workspace_id = ?",
        )
        .get(workspace) as Record<string, unknown> | undefined;
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      const agents = db
        .prepare(
          "SELECT agent_id, display_name, model, capabilities, status, last_heartbeat_at, created_at FROM agents WHERE workspace_id = ?",
        )
        .all(workspace);
      const claims = db
        .prepare(
          "SELECT claim_id, agent_id, scope, status, ttl_seconds, created_at, expires_at FROM claims WHERE workspace_id = ?",
        )
        .all(workspace);
      const handoffs = db
        .prepare(
          "SELECT handoff_id, from_agent_id, to_agent_id, route_mode, capability_tag, summary, status, created_at FROM handoffs WHERE workspace_id = ?",
        )
        .all(workspace);
      const blockers = db
        .prepare(
          "SELECT blocker_id, agent_id, title, severity, status, deadline_at, created_at, resolved_at FROM blockers WHERE workspace_id = ?",
        )
        .all(workspace);

      return reply.send({
        workspace: ws,
        agents,
        claims,
        handoffs,
        blockers,
        exported_at: new Date().toISOString(),
      });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/settings",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const row = db
        .prepare("SELECT settings FROM workspaces WHERE workspace_id = ?")
        .get(workspace) as { settings: string } | undefined;
      if (!row) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      return reply.send(JSON.parse(row.settings || "{}"));
    },
  );

  app.patch(
    "/api/v1/workspaces/:workspace/settings",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          additionalProperties: true,
          maxProperties: 50,
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const body = request.body as Record<string, unknown>;

      const row = db
        .prepare("SELECT settings FROM workspaces WHERE workspace_id = ?")
        .get(workspace) as { settings: string } | undefined;
      if (!row) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const current = JSON.parse(row.settings || "{}");
      const merged = { ...current, ...body };
      db.prepare("UPDATE workspaces SET settings = ? WHERE workspace_id = ?").run(
        JSON.stringify(merged),
        workspace,
      );

      writeAuditLog({
        workspaceId: workspace,
        actorType: "system",
        action: "workspace.settings_update",
        entityType: "workspace",
        entityId: workspace,
        requestId: request.id,
        payload: body,
      });

      return reply.send(merged);
    },
  );
};

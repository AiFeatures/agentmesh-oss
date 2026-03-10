import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/index.js";
import { writeAuditLog } from "../services/audit.js";
import { workspaceId as generateWorkspaceId } from "../services/ids.js";
import { broadcast } from "../ws/gateway.js";

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
      const claimDependencies = db
        .prepare(
          "SELECT cd.claim_id, cd.depends_on_claim_id FROM claim_dependencies cd JOIN claims c ON c.claim_id = cd.claim_id WHERE c.workspace_id = ?",
        )
        .all(workspace);
      const handoffNotes = db
        .prepare(
          "SELECT handoff_id, author_id, content, created_at FROM handoff_notes WHERE workspace_id = ?",
        )
        .all(workspace);
      const blockerWatchers = db
        .prepare(
          "SELECT blocker_id, agent_id, created_at FROM blocker_watchers WHERE workspace_id = ?",
        )
        .all(workspace);
      const statusHistory = db
        .prepare(
          "SELECT agent_id, old_status, new_status, created_at FROM agent_status_history WHERE workspace_id = ?",
        )
        .all(workspace);

      return reply.send({
        workspace: ws,
        agents,
        claims,
        handoffs,
        blockers,
        claim_dependencies: claimDependencies,
        handoff_notes: handoffNotes,
        blocker_watchers: blockerWatchers,
        agent_status_history: statusHistory,
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

  /* ── F-73  workspace event log summary ──────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/audit/summary",
    {
      preHandler: app.authGuard,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            hours: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { hours } = request.query as { hours?: string };
      const h = Math.min(720, Math.max(1, Number(hours) || 24));
      const rows = db
        .prepare(
          `SELECT action, COUNT(*) as count FROM audit_log WHERE workspace_id = ? AND created_at >= datetime('now', '-${h} hours') GROUP BY action ORDER BY count DESC`,
        )
        .all(workspace) as Array<{ action: string; count: number }>;
      const total = rows.reduce((acc, r) => acc + r.count, 0);
      return reply.send({ hours: h, total, by_action: rows });
    },
  );

  /* ── F-80  metrics history ──────────────────────────────────── */
  app.post(
    "/api/v1/workspaces/:workspace/metrics/snapshot",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const agents = (
        db.prepare("SELECT COUNT(*) as c FROM agents WHERE workspace_id = ?").get(workspace) as {
          c: number;
        }
      ).c;
      const claims = (
        db
          .prepare("SELECT COUNT(*) as c FROM claims WHERE workspace_id = ? AND status = 'active'")
          .get(workspace) as { c: number }
      ).c;
      const handoffs = (
        db
          .prepare(
            "SELECT COUNT(*) as c FROM handoffs WHERE workspace_id = ? AND status = 'pending'",
          )
          .get(workspace) as { c: number }
      ).c;
      const blockers = (
        db
          .prepare("SELECT COUNT(*) as c FROM blockers WHERE workspace_id = ? AND status = 'open'")
          .get(workspace) as { c: number }
      ).c;
      db.prepare(
        "INSERT INTO metrics_history (workspace_id, agent_count, active_claims, pending_handoffs, open_blockers) VALUES (?, ?, ?, ?, ?)",
      ).run(workspace, agents, claims, handoffs, blockers);
      return reply.code(201).send({ ok: true });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/metrics/history",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { limit } = request.query as { limit?: string };
      const lim = Math.min(1000, Math.max(1, Number(limit) || 100));
      const rows = db
        .prepare(
          "SELECT agent_count, active_claims, pending_handoffs, open_blockers, snapshot_at FROM metrics_history WHERE workspace_id = ? ORDER BY id DESC LIMIT ?",
        )
        .all(workspace, lim);
      return reply.send({ data: rows, total: rows.length });
    },
  );

  /* ── F-83  agent idle eviction ──────────────────────────────── */
  app.post(
    "/api/v1/workspaces/:workspace/agents/evict-idle",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const row = db
        .prepare("SELECT settings FROM workspaces WHERE workspace_id = ?")
        .get(workspace) as { settings: string } | undefined;
      if (!row) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      const settings = JSON.parse(row.settings || "{}");
      const idleMinutes = Number(settings.agent_idle_timeout_minutes) || 30;
      const evicted = db
        .prepare(
          `UPDATE agents SET status = 'evicted', updated_at = CURRENT_TIMESTAMP
           WHERE workspace_id = ? AND status IN ('online', 'idle')
           AND last_heartbeat_at < datetime('now', '-' || ? || ' minutes')`,
        )
        .run(workspace, idleMinutes);
      return reply.send({ evicted_count: evicted.changes, idle_threshold_minutes: idleMinutes });
    },
  );

  /* ── F-86  workspace clone ──────────────────────────────────── */
  app.post(
    "/api/v1/workspaces/:workspace/clone",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["new_workspace_id"],
          additionalProperties: false,
          properties: {
            new_workspace_id: { type: "string", minLength: 2, maxLength: 128 },
            display_name: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const body = request.body as { new_workspace_id: string; display_name?: string };

      const source = db.prepare("SELECT * FROM workspaces WHERE workspace_id = ?").get(workspace) as
        | Record<string, unknown>
        | undefined;
      if (!source) {
        return reply.code(404).send({ error: "Source workspace not found" });
      }
      const existing = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(body.new_workspace_id);
      if (existing) {
        return reply.code(409).send({ error: "Target workspace_id already exists" });
      }

      const displayName = body.display_name ?? `${source.display_name} (clone)`;
      db.prepare(
        "INSERT INTO workspaces (workspace_id, display_name, base_path, settings) VALUES (?, ?, ?, ?)",
      ).run(body.new_workspace_id, displayName, source.base_path, source.settings);

      writeAuditLog({
        workspaceId: body.new_workspace_id,
        actorType: "system",
        action: "workspace.clone",
        entityType: "workspace",
        entityId: body.new_workspace_id,
        requestId: request.id,
        payload: { source_workspace: workspace },
      });

      return reply.code(201).send({
        workspace_id: body.new_workspace_id,
        display_name: displayName,
        cloned_from: workspace,
      });
    },
  );

  /* ── F-90  workspace activity feed ──────────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/activity",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { limit, offset } = request.query as { limit?: string; offset?: string };
      const lim = Math.min(200, Math.max(1, Number(limit) || 50));
      const off = Math.max(0, Number(offset) || 0);
      const rows = db
        .prepare(
          "SELECT audit_id, action, entity_type, entity_id, actor_type, actor_id, created_at FROM audit_log WHERE workspace_id = ? ORDER BY audit_id DESC LIMIT ? OFFSET ?",
        )
        .all(workspace, lim, off);
      const total = (
        db.prepare("SELECT COUNT(*) as c FROM audit_log WHERE workspace_id = ?").get(workspace) as {
          c: number;
        }
      ).c;
      return reply.send({ data: rows, total, limit: lim, offset: off });
    },
  );

  /* ── F-97  workspace rate-limit config ──────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/rate-limit",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const row = db
        .prepare("SELECT settings FROM workspaces WHERE workspace_id = ?")
        .get(workspace) as { settings: string } | undefined;
      if (!row) return reply.code(404).send({ error: "Workspace not found" });
      const settings = JSON.parse(row.settings || "{}");
      const config = settings.rate_limit ?? { max_requests_per_minute: 60, burst: 10 };
      return reply.send(config);
    },
  );

  app.patch(
    "/api/v1/workspaces/:workspace/rate-limit",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            max_requests_per_minute: { type: "integer", minimum: 1, maximum: 10000 },
            burst: { type: "integer", minimum: 1, maximum: 1000 },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const body = request.body as { max_requests_per_minute?: number; burst?: number };
      const row = db
        .prepare("SELECT settings FROM workspaces WHERE workspace_id = ?")
        .get(workspace) as { settings: string } | undefined;
      if (!row) return reply.code(404).send({ error: "Workspace not found" });
      const settings = JSON.parse(row.settings || "{}");
      const current = settings.rate_limit ?? { max_requests_per_minute: 60, burst: 10 };
      const merged = { ...current, ...body };
      settings.rate_limit = merged;
      db.prepare("UPDATE workspaces SET settings = ? WHERE workspace_id = ?").run(
        JSON.stringify(settings),
        workspace,
      );
      return reply.send(merged);
    },
  );

  /* ── F-102  workspace dashboard summary ─────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/dashboard",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const cnt = (table: string, extra = "") =>
        (
          db
            .prepare(`SELECT COUNT(*) as c FROM ${table} WHERE workspace_id = ?${extra}`)
            .get(workspace) as { c: number }
        ).c;
      return reply.send({
        agents_total: cnt("agents"),
        agents_online: cnt("agents", " AND status = 'online'"),
        claims_active: cnt("claims", " AND status = 'active'"),
        blockers_open: cnt("blockers", " AND status = 'open'"),
        handoffs_pending: cnt("handoffs", " AND status = 'pending'"),
        handoffs_total: cnt("handoffs"),
      });
    },
  );

  /* ── F-107  workspace notification preferences ──────────── */
  app.get(
    "/api/v1/workspaces/:workspace/notification-preferences",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const row = db
        .prepare("SELECT settings FROM workspaces WHERE workspace_id = ?")
        .get(workspace) as { settings: string | null } | undefined;
      if (!row) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      const settings = JSON.parse(row.settings || "{}");
      return reply.send(
        settings.notifications ?? { sla_breach: true, handoff_timeout: true, agent_evicted: true },
      );
    },
  );

  app.patch(
    "/api/v1/workspaces/:workspace/notification-preferences",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            sla_breach: { type: "boolean" },
            handoff_timeout: { type: "boolean" },
            agent_evicted: { type: "boolean" },
            blocker_created: { type: "boolean" },
            claim_conflict: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const body = request.body as Record<string, boolean>;
      const row = db
        .prepare("SELECT settings FROM workspaces WHERE workspace_id = ?")
        .get(workspace) as { settings: string | null } | undefined;
      if (!row) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      const settings = JSON.parse(row.settings || "{}");
      const current = settings.notifications ?? {
        sla_breach: true,
        handoff_timeout: true,
        agent_evicted: true,
      };
      settings.notifications = { ...current, ...body };
      db.prepare("UPDATE workspaces SET settings = ? WHERE workspace_id = ?").run(
        JSON.stringify(settings),
        workspace,
      );
      return reply.send(settings.notifications);
    },
  );

  /* ── F-109  workspace activity feed ───────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/activity-feed",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const qs = request.query as { limit?: string; since?: string };
      const limit = Math.min(Math.max(Number.parseInt(qs.limit || "50", 10) || 50, 1), 200);
      const ws = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      let sql =
        "SELECT audit_id, action, entity_type, entity_id, actor_type, actor_id, created_at FROM audit_log WHERE workspace_id = ?";
      const params: unknown[] = [workspace];
      if (qs.since) {
        sql += " AND created_at > ?";
        params.push(qs.since);
      }
      sql += " ORDER BY created_at DESC LIMIT ?";
      params.push(limit);
      const rows = db.prepare(sql).all(...params);
      return reply.send({ data: rows });
    },
  );

  /* ── F-114  workspace comparison ─────────────────────── */
  app.get("/api/v1/workspaces/compare", { preHandler: app.authGuard }, async (request, reply) => {
    const qs = request.query as { ids?: string };
    if (!qs.ids) {
      return reply.code(400).send({ error: "ids query parameter required" });
    }
    const ids = qs.ids
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 10);
    if (ids.length < 2) {
      return reply.code(400).send({ error: "At least 2 workspace IDs required" });
    }
    const results: Array<Record<string, unknown>> = [];
    for (const wsId of ids) {
      const agents = (
        db.prepare("SELECT COUNT(*) as c FROM agents WHERE workspace_id = ?").get(wsId) as {
          c: number;
        }
      ).c;
      const claims = (
        db
          .prepare("SELECT COUNT(*) as c FROM claims WHERE workspace_id = ? AND status = 'active'")
          .get(wsId) as { c: number }
      ).c;
      const blockers = (
        db
          .prepare("SELECT COUNT(*) as c FROM blockers WHERE workspace_id = ? AND status = 'open'")
          .get(wsId) as { c: number }
      ).c;
      const handoffs = (
        db.prepare("SELECT COUNT(*) as c FROM handoffs WHERE workspace_id = ?").get(wsId) as {
          c: number;
        }
      ).c;
      results.push({
        workspace_id: wsId,
        agents,
        active_claims: claims,
        open_blockers: blockers,
        total_handoffs: handoffs,
      });
    }
    return reply.send({ data: results });
  });

  /* ── F-120  workspace health score ──────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/health-score",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const ws = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      const totalAgents = (
        db.prepare("SELECT COUNT(*) as c FROM agents WHERE workspace_id = ?").get(workspace) as {
          c: number;
        }
      ).c;
      const onlineAgents = (
        db
          .prepare("SELECT COUNT(*) as c FROM agents WHERE workspace_id = ? AND status = 'online'")
          .get(workspace) as { c: number }
      ).c;
      const openBlockers = (
        db
          .prepare("SELECT COUNT(*) as c FROM blockers WHERE workspace_id = ? AND status = 'open'")
          .get(workspace) as { c: number }
      ).c;
      const pendingHandoffs = (
        db
          .prepare(
            "SELECT COUNT(*) as c FROM handoffs WHERE workspace_id = ? AND status = 'pending'",
          )
          .get(workspace) as { c: number }
      ).c;

      let score = 100;
      if (totalAgents > 0) {
        const onlineRatio = onlineAgents / totalAgents;
        score -= Math.round((1 - onlineRatio) * 30);
      }
      score -= Math.min(openBlockers * 5, 30);
      score -= Math.min(pendingHandoffs * 2, 20);
      score = Math.max(score, 0);

      return reply.send({
        score,
        factors: {
          total_agents: totalAgents,
          online_agents: onlineAgents,
          open_blockers: openBlockers,
          pending_handoffs: pendingHandoffs,
        },
      });
    },
  );

  /* ── F-126  workspace daily digest ─────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/daily-digest",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const ws = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      const since = "datetime('now', '-1 day')";
      const newAgents = (
        db
          .prepare(
            `SELECT COUNT(*) as c FROM agents WHERE workspace_id = ? AND created_at >= ${since}`,
          )
          .get(workspace) as { c: number }
      ).c;
      const newBlockers = (
        db
          .prepare(
            `SELECT COUNT(*) as c FROM blockers WHERE workspace_id = ? AND created_at >= ${since}`,
          )
          .get(workspace) as { c: number }
      ).c;
      const resolvedBlockers = (
        db
          .prepare(
            `SELECT COUNT(*) as c FROM blockers WHERE workspace_id = ? AND resolved_at >= ${since}`,
          )
          .get(workspace) as { c: number }
      ).c;
      const newHandoffs = (
        db
          .prepare(
            `SELECT COUNT(*) as c FROM handoffs WHERE workspace_id = ? AND created_at >= ${since}`,
          )
          .get(workspace) as { c: number }
      ).c;
      const newClaims = (
        db
          .prepare(
            `SELECT COUNT(*) as c FROM claims WHERE workspace_id = ? AND created_at >= ${since}`,
          )
          .get(workspace) as { c: number }
      ).c;
      return reply.send({
        period: "24h",
        new_agents: newAgents,
        new_blockers: newBlockers,
        resolved_blockers: resolvedBlockers,
        new_handoffs: newHandoffs,
        new_claims: newClaims,
      });
    },
  );

  /* ── F-131  workspace resource utilization ───────────── */
  app.get(
    "/api/v1/workspaces/:workspace/resource-utilization",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const ws = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      const activeClaims = (
        db
          .prepare("SELECT COUNT(*) as c FROM claims WHERE workspace_id = ? AND status = 'active'")
          .get(workspace) as { c: number }
      ).c;
      const uniqueScopes = (
        db
          .prepare(
            "SELECT COUNT(DISTINCT scope) as c FROM claims WHERE workspace_id = ? AND status = 'active'",
          )
          .get(workspace) as { c: number }
      ).c;
      const totalAgents = (
        db.prepare("SELECT COUNT(*) as c FROM agents WHERE workspace_id = ?").get(workspace) as {
          c: number;
        }
      ).c;
      const agentsWithClaims = (
        db
          .prepare(
            "SELECT COUNT(DISTINCT agent_id) as c FROM claims WHERE workspace_id = ? AND status = 'active'",
          )
          .get(workspace) as { c: number }
      ).c;
      return reply.send({
        active_claims: activeClaims,
        unique_scopes: uniqueScopes,
        total_agents: totalAgents,
        agents_with_claims: agentsWithClaims,
        utilization_rate: totalAgents > 0 ? Math.round((agentsWithClaims / totalAgents) * 100) : 0,
      });
    },
  );

  /* ── F-132  workspace export diff ──────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/export-diff",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const qs = request.query as { since?: string };
      if (!qs.since) {
        return reply.code(400).send({ error: "since query parameter required" });
      }
      const ws = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      const newAgents = db
        .prepare(
          "SELECT agent_id, display_name, created_at FROM agents WHERE workspace_id = ? AND created_at > ?",
        )
        .all(workspace, qs.since);
      const newBlockers = db
        .prepare(
          "SELECT blocker_id, title, severity, created_at FROM blockers WHERE workspace_id = ? AND created_at > ?",
        )
        .all(workspace, qs.since);
      const newHandoffs = db
        .prepare(
          "SELECT handoff_id, from_agent_id, to_agent_id, status, created_at FROM handoffs WHERE workspace_id = ? AND created_at > ?",
        )
        .all(workspace, qs.since);
      const newClaims = db
        .prepare(
          "SELECT claim_id, agent_id, scope, created_at FROM claims WHERE workspace_id = ? AND created_at > ?",
        )
        .all(workspace, qs.since);
      return reply.send({
        since: qs.since,
        agents: newAgents,
        blockers: newBlockers,
        handoffs: newHandoffs,
        claims: newClaims,
      });
    },
  );

  /* ── F-145  workspace merge ─────────────────────────── */
  app.post(
    "/api/v1/workspaces/:workspace/merge",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["source_workspace_id"],
          properties: {
            source_workspace_id: { type: "string", minLength: 1, maxLength: 128 },
            include_agents: { type: "boolean" },
            include_claims: { type: "boolean" },
            include_blockers: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const body = request.body as {
        source_workspace_id: string;
        include_agents?: boolean;
        include_claims?: boolean;
        include_blockers?: boolean;
      };

      const target = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace) as { workspace_id: string } | undefined;
      if (!target) {
        return reply.code(404).send({ error: "Target workspace not found" });
      }

      const source = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(body.source_workspace_id) as { workspace_id: string } | undefined;
      if (!source) {
        return reply.code(404).send({ error: "Source workspace not found" });
      }

      if (body.source_workspace_id === workspace) {
        return reply.code(422).send({ error: "Cannot merge a workspace into itself" });
      }

      const merged = { agents: 0, claims: 0, blockers: 0 };
      const agentIdMap = new Map<string, string>();

      if (body.include_agents !== false) {
        const agents = db
          .prepare(
            "SELECT agent_id, display_name, model, capabilities, metadata FROM agents WHERE workspace_id = ?",
          )
          .all(body.source_workspace_id) as Array<{
          agent_id: string;
          display_name: string;
          model: string;
          capabilities: string;
          metadata: string | null;
        }>;
        const insertAgent = db.prepare(
          "INSERT OR IGNORE INTO agents (agent_id, workspace_id, display_name, model, capabilities, metadata, status) VALUES (?, ?, ?, ?, ?, ?, 'online')",
        );
        for (const a of agents) {
          // Check if agent_id already exists globally
          const exists = db
            .prepare("SELECT agent_id FROM agents WHERE agent_id = ?")
            .get(a.agent_id);
          const newId = exists ? `${a.agent_id}_merged_${Date.now().toString(36)}` : a.agent_id;
          agentIdMap.set(a.agent_id, newId);
          const r = insertAgent.run(
            newId,
            workspace,
            a.display_name,
            a.model,
            a.capabilities,
            a.metadata,
          );
          if (r.changes > 0) merged.agents++;
        }
      }

      if (body.include_claims !== false) {
        const claims = db
          .prepare(
            "SELECT claim_id, agent_id, scope, ttl_seconds FROM claims WHERE workspace_id = ? AND status = 'active'",
          )
          .all(body.source_workspace_id) as Array<{
          claim_id: string;
          agent_id: string;
          scope: string;
          ttl_seconds: number;
        }>;
        const insertClaim = db.prepare(
          "INSERT OR IGNORE INTO claims (claim_id, workspace_id, agent_id, scope, ttl_seconds, status, expires_at) VALUES (?, ?, ?, ?, ?, 'active', datetime('now', '+' || ? || ' seconds'))",
        );
        const insertPath = db.prepare(
          "INSERT OR IGNORE INTO claim_paths (claim_id, path_pattern) VALUES (?, ?)",
        );
        for (const c of claims) {
          const r = insertClaim.run(
            c.claim_id,
            workspace,
            c.agent_id,
            c.scope,
            c.ttl_seconds,
            c.ttl_seconds,
          );
          if (r.changes > 0) {
            merged.claims++;
            const paths = db
              .prepare("SELECT path_pattern FROM claim_paths WHERE claim_id = ?")
              .all(c.claim_id) as Array<{ path_pattern: string }>;
            for (const p of paths) {
              insertPath.run(c.claim_id, p.path_pattern);
            }
          }
        }
      }

      if (body.include_blockers !== false) {
        const blockers = db
          .prepare(
            "SELECT blocker_id, agent_id, title, severity FROM blockers WHERE workspace_id = ? AND status = 'open'",
          )
          .all(body.source_workspace_id) as Array<{
          blocker_id: string;
          agent_id: string;
          title: string;
          severity: string;
        }>;
        const insertBlocker = db.prepare(
          "INSERT OR IGNORE INTO blockers (blocker_id, workspace_id, agent_id, title, severity, status) VALUES (?, ?, ?, ?, ?, 'open')",
        );
        for (const b of blockers) {
          const r = insertBlocker.run(b.blocker_id, workspace, b.agent_id, b.title, b.severity);
          if (r.changes > 0) merged.blockers++;
        }
      }

      writeAuditLog({
        workspaceId: workspace,
        actorType: "system",
        action: "workspace.merge",
        entityType: "workspace",
        entityId: workspace,
        requestId: request.id,
        payload: {
          source: body.source_workspace_id,
          merged,
        },
      });

      return reply.send({ ok: true, merged });
    },
  );

  /* ── F-149  work queue stats ─────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/work-queue",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const activeClaims = (
        db
          .prepare("SELECT COUNT(*) as c FROM claims WHERE workspace_id = ? AND status = 'active'")
          .get(workspace) as { c: number }
      ).c;

      const pendingHandoffs = (
        db
          .prepare(
            "SELECT COUNT(*) as c FROM handoffs WHERE workspace_id = ? AND status = 'pending'",
          )
          .get(workspace) as { c: number }
      ).c;

      const openBlockers = (
        db
          .prepare("SELECT COUNT(*) as c FROM blockers WHERE workspace_id = ? AND status = 'open'")
          .get(workspace) as { c: number }
      ).c;

      const onlineAgents = (
        db
          .prepare("SELECT COUNT(*) as c FROM agents WHERE workspace_id = ? AND status = 'online'")
          .get(workspace) as { c: number }
      ).c;

      const criticalBlockers = (
        db
          .prepare(
            "SELECT COUNT(*) as c FROM blockers WHERE workspace_id = ? AND status = 'open' AND severity IN ('high', 'critical')",
          )
          .get(workspace) as { c: number }
      ).c;

      const expiringClaims = (
        db
          .prepare(
            "SELECT COUNT(*) as c FROM claims WHERE workspace_id = ? AND status = 'active' AND expires_at <= datetime('now', '+5 minutes')",
          )
          .get(workspace) as { c: number }
      ).c;

      const agentLoad = db
        .prepare(
          `SELECT a.agent_id, a.display_name,
           (SELECT COUNT(*) FROM claims c WHERE c.agent_id = a.agent_id AND c.workspace_id = ? AND c.status = 'active') as claims,
           (SELECT COUNT(*) FROM handoffs h WHERE (h.from_agent_id = a.agent_id OR h.to_agent_id = a.agent_id) AND h.workspace_id = ? AND h.status = 'pending') as handoffs,
           (SELECT COUNT(*) FROM blockers b WHERE b.agent_id = a.agent_id AND b.workspace_id = ? AND b.status = 'open') as blockers
           FROM agents a WHERE a.workspace_id = ? AND a.status = 'online'
           ORDER BY (claims * 2 + handoffs + blockers * 3) DESC
           LIMIT 10`,
        )
        .all(workspace, workspace, workspace, workspace) as Array<{
        agent_id: string;
        display_name: string;
        claims: number;
        handoffs: number;
        blockers: number;
      }>;

      return reply.send({
        summary: {
          active_claims: activeClaims,
          pending_handoffs: pendingHandoffs,
          open_blockers: openBlockers,
          critical_blockers: criticalBlockers,
          online_agents: onlineAgents,
          expiring_claims_5m: expiringClaims,
        },
        agent_load: agentLoad,
      });
    },
  );

  /* ── F-150  workspace snapshot ────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/snapshot",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const ws = db.prepare("SELECT * FROM workspaces WHERE workspace_id = ?").get(workspace) as
        | Record<string, unknown>
        | undefined;
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const agents = db
        .prepare(
          "SELECT agent_id, display_name, status, capabilities FROM agents WHERE workspace_id = ?",
        )
        .all(workspace);
      const claims = db
        .prepare(
          "SELECT claim_id, agent_id, scope, status, expires_at FROM claims WHERE workspace_id = ? AND status = 'active'",
        )
        .all(workspace);
      const blockers = db
        .prepare(
          "SELECT blocker_id, agent_id, title, severity, status FROM blockers WHERE workspace_id = ? AND status = 'open'",
        )
        .all(workspace);
      const handoffs = db
        .prepare(
          "SELECT handoff_id, from_agent_id, to_agent_id, status, summary FROM handoffs WHERE workspace_id = ? AND status = 'pending'",
        )
        .all(workspace);

      return reply.send({
        workspace: ws,
        snapshot_at: new Date().toISOString(),
        agents,
        claims,
        blockers,
        handoffs,
      });
    },
  );

  /* ── F-155  workspace comparison ───────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/compare/:other",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, other } = request.params as {
        workspace: string;
        other: string;
      };

      const statsFor = (wsId: string) => {
        const agents = (
          db.prepare("SELECT COUNT(*) as c FROM agents WHERE workspace_id = ?").get(wsId) as {
            c: number;
          }
        ).c;
        const claims = (
          db
            .prepare(
              "SELECT COUNT(*) as c FROM claims WHERE workspace_id = ? AND status = 'active'",
            )
            .get(wsId) as { c: number }
        ).c;
        const blockers = (
          db
            .prepare(
              "SELECT COUNT(*) as c FROM blockers WHERE workspace_id = ? AND status = 'open'",
            )
            .get(wsId) as { c: number }
        ).c;
        const handoffs = (
          db
            .prepare(
              "SELECT COUNT(*) as c FROM handoffs WHERE workspace_id = ? AND status = 'pending'",
            )
            .get(wsId) as { c: number }
        ).c;

        const capabilities = db
          .prepare(
            `SELECT DISTINCT json_each.value as cap
             FROM agents, json_each(agents.capabilities)
             WHERE agents.workspace_id = ?`,
          )
          .all(wsId)
          .map((r: any) => r.cap);

        return { agents, claims, blockers, handoffs, capabilities };
      };

      const left = statsFor(workspace);
      const right = statsFor(other);

      const sharedCaps = left.capabilities.filter((c: string) => right.capabilities.includes(c));
      const leftOnly = left.capabilities.filter((c: string) => !right.capabilities.includes(c));
      const rightOnly = right.capabilities.filter((c: string) => !left.capabilities.includes(c));

      return reply.send({
        left: { workspace_id: workspace, ...left },
        right: { workspace_id: other, ...right },
        capability_overlap: {
          shared: sharedCaps,
          left_only: leftOnly,
          right_only: rightOnly,
        },
      });
    },
  );

  // F-170: Workspace growth trend
  app.get(
    "/api/v1/workspaces/:workspace/growth-trend",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { days = "7" } = request.query as { days?: string };
      const numDays = Math.max(Number.parseInt(days, 10) || 7, 1);

      const agentsByDay = db
        .prepare(
          `SELECT date(created_at) as day, COUNT(*) as count
           FROM agents WHERE workspace_id = ? AND created_at >= datetime('now', ?)
           GROUP BY date(created_at)
           ORDER BY day`,
        )
        .all(workspace, `-${numDays} days`) as Array<{ day: string; count: number }>;

      const claimsByDay = db
        .prepare(
          `SELECT date(created_at) as day, COUNT(*) as count
           FROM claims WHERE workspace_id = ? AND created_at >= datetime('now', ?)
           GROUP BY date(created_at)
           ORDER BY day`,
        )
        .all(workspace, `-${numDays} days`) as Array<{ day: string; count: number }>;

      const handoffsByDay = db
        .prepare(
          `SELECT date(created_at) as day, COUNT(*) as count
           FROM handoffs WHERE workspace_id = ? AND created_at >= datetime('now', ?)
           GROUP BY date(created_at)
           ORDER BY day`,
        )
        .all(workspace, `-${numDays} days`) as Array<{ day: string; count: number }>;

      const blockersByDay = db
        .prepare(
          `SELECT date(created_at) as day, COUNT(*) as count
           FROM blockers WHERE workspace_id = ? AND created_at >= datetime('now', ?)
           GROUP BY date(created_at)
           ORDER BY day`,
        )
        .all(workspace, `-${numDays} days`) as Array<{ day: string; count: number }>;

      return reply.send({
        workspace_id: workspace,
        period_days: numDays,
        agents: agentsByDay,
        claims: claimsByDay,
        handoffs: handoffsByDay,
        blockers: blockersByDay,
      });
    },
  );

  // F-175: Workspace capacity analysis
  app.get(
    "/api/v1/workspaces/:workspace/capacity",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const agentCount = (
        db.prepare(`SELECT COUNT(*) as c FROM agents WHERE workspace_id = ?`).get(workspace) as {
          c: number;
        }
      ).c;

      const onlineAgents = (
        db
          .prepare(`SELECT COUNT(*) as c FROM agents WHERE workspace_id = ? AND status = 'online'`)
          .get(workspace) as { c: number }
      ).c;

      const activeClaims = (
        db
          .prepare(`SELECT COUNT(*) as c FROM claims WHERE workspace_id = ? AND status = 'active'`)
          .get(workspace) as { c: number }
      ).c;

      const pendingHandoffs = (
        db
          .prepare(
            `SELECT COUNT(*) as c FROM handoffs WHERE workspace_id = ? AND status = 'pending'`,
          )
          .get(workspace) as { c: number }
      ).c;

      const openBlockers = (
        db
          .prepare(
            `SELECT COUNT(*) as c FROM blockers WHERE workspace_id = ? AND status != 'resolved'`,
          )
          .get(workspace) as { c: number }
      ).c;

      const agentUtilization =
        agentCount > 0 ? Math.round((onlineAgents / agentCount) * 10000) / 100 : 0;

      return reply.send({
        workspace_id: workspace,
        total_agents: agentCount,
        online_agents: onlineAgents,
        active_claims: activeClaims,
        pending_handoffs: pendingHandoffs,
        open_blockers: openBlockers,
        agent_utilization: agentUtilization,
      });
    },
  );

  // F-180: Workspace audit stats
  app.get(
    "/api/v1/workspaces/:workspace/audit-stats",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const byAction = db
        .prepare(
          `SELECT action, COUNT(*) as count
           FROM audit_log WHERE workspace_id = ?
           GROUP BY action ORDER BY count DESC`,
        )
        .all(workspace) as Array<{ action: string; count: number }>;

      const byDay = db
        .prepare(
          `SELECT date(created_at) as day, COUNT(*) as count
           FROM audit_log WHERE workspace_id = ?
           GROUP BY date(created_at) ORDER BY day DESC LIMIT 30`,
        )
        .all(workspace) as Array<{ day: string; count: number }>;

      const totalEvents = byAction.reduce((s, a) => s + a.count, 0);

      return reply.send({
        workspace_id: workspace,
        total_events: totalEvents,
        by_action: byAction,
        by_day: byDay,
      });
    },
  );

  // F-185: Workspace anomaly detection
  app.get(
    "/api/v1/workspaces/:workspace/anomaly-detection",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const anomalies: Array<{ type: string; description: string; value: number }> = [];

      // Check for stale agents (no heartbeat in 30 min)
      const staleCount = (
        db
          .prepare(
            `SELECT COUNT(*) as c FROM agents
             WHERE workspace_id = ? AND status = 'online'
                   AND datetime(last_heartbeat_at) < datetime('now', '-30 minutes')`,
          )
          .get(workspace) as { c: number }
      ).c;
      if (staleCount > 0) {
        anomalies.push({
          type: "stale_agents",
          description: "Online agents with no heartbeat in 30 min",
          value: staleCount,
        });
      }

      // Check for high blocker count (relative to agents)
      const agentCount = (
        db.prepare(`SELECT COUNT(*) as c FROM agents WHERE workspace_id = ?`).get(workspace) as {
          c: number;
        }
      ).c;
      const openBlockers = (
        db
          .prepare(
            `SELECT COUNT(*) as c FROM blockers WHERE workspace_id = ? AND status != 'resolved'`,
          )
          .get(workspace) as { c: number }
      ).c;
      if (agentCount > 0 && openBlockers / agentCount > 2) {
        anomalies.push({
          type: "high_blocker_ratio",
          description: "More than 2 open blockers per agent",
          value: openBlockers,
        });
      }

      // Check for high pending handoffs
      const pendingHandoffs = (
        db
          .prepare(
            `SELECT COUNT(*) as c FROM handoffs WHERE workspace_id = ? AND status = 'pending'`,
          )
          .get(workspace) as { c: number }
      ).c;
      if (pendingHandoffs > 10) {
        anomalies.push({
          type: "high_pending_handoffs",
          description: "More than 10 pending handoffs",
          value: pendingHandoffs,
        });
      }

      return reply.send({
        workspace_id: workspace,
        anomaly_count: anomalies.length,
        anomalies,
      });
    },
  );

  // F-190: Workspace risk score
  app.get(
    "/api/v1/workspaces/:workspace/risk-score",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const agentCount = (
        db.prepare(`SELECT COUNT(*) as c FROM agents WHERE workspace_id = ?`).get(workspace) as {
          c: number;
        }
      ).c;
      const staleAgents = (
        db
          .prepare(
            `SELECT COUNT(*) as c FROM agents
             WHERE workspace_id = ? AND status = 'online'
                   AND datetime(last_heartbeat_at) < datetime('now', '-15 minutes')`,
          )
          .get(workspace) as { c: number }
      ).c;
      const openBlockers = (
        db
          .prepare(
            `SELECT COUNT(*) as c FROM blockers WHERE workspace_id = ? AND status != 'resolved'`,
          )
          .get(workspace) as { c: number }
      ).c;
      const criticalBlockers = (
        db
          .prepare(
            `SELECT COUNT(*) as c FROM blockers WHERE workspace_id = ? AND status != 'resolved' AND severity = 'critical'`,
          )
          .get(workspace) as { c: number }
      ).c;
      const pendingHandoffs = (
        db
          .prepare(
            `SELECT COUNT(*) as c FROM handoffs WHERE workspace_id = ? AND status = 'pending'`,
          )
          .get(workspace) as { c: number }
      ).c;

      // Calculate risk score (0-100, higher = more risky)
      let risk = 0;
      if (agentCount > 0) risk += Math.min(30, (staleAgents / agentCount) * 30);
      risk += Math.min(25, criticalBlockers * 10);
      risk += Math.min(20, openBlockers * 2);
      risk += Math.min(25, pendingHandoffs * 3);
      risk = Math.min(100, Math.round(risk));

      const level = risk < 25 ? "low" : risk < 50 ? "medium" : risk < 75 ? "high" : "critical";

      return reply.send({
        workspace_id: workspace,
        risk_score: risk,
        risk_level: level,
        factors: {
          stale_agents: staleAgents,
          open_blockers: openBlockers,
          critical_blockers: criticalBlockers,
          pending_handoffs: pendingHandoffs,
        },
      });
    },
  );

  // F-195: Agent distribution within a workspace
  app.get(
    "/api/v1/workspaces/:workspace/agent-distribution",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const agents = db
        .prepare(`SELECT agent_id, status, model, capabilities FROM agents WHERE workspace_id = ?`)
        .all(workspace) as {
        agent_id: string;
        status: string;
        model: string | null;
        capabilities: string;
      }[];

      const byStatus: Record<string, number> = {};
      const byModel: Record<string, number> = {};
      const byCapability: Record<string, number> = {};

      for (const a of agents) {
        byStatus[a.status] = (byStatus[a.status] || 0) + 1;
        const model = a.model || "unknown";
        byModel[model] = (byModel[model] || 0) + 1;
        try {
          const caps = JSON.parse(a.capabilities || "[]") as string[];
          for (const c of caps) {
            byCapability[c] = (byCapability[c] || 0) + 1;
          }
        } catch {}
      }

      return reply.send({
        workspace,
        total_agents: agents.length,
        by_status: byStatus,
        by_model: byModel,
        by_capability: byCapability,
      });
    },
  );

  // F-200: Workspace throughput metrics
  app.get(
    "/api/v1/workspaces/:workspace/throughput",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { hours = "24" } = request.query as { hours?: string };
      const totalHours = Math.min(Number.parseInt(hours, 10) || 24, 720);
      const since = new Date(Date.now() - totalHours * 3600000).toISOString();

      const handoffCount = (
        db
          .prepare(`SELECT COUNT(*) as c FROM handoffs WHERE workspace_id = ? AND created_at >= ?`)
          .get(workspace, since) as { c: number }
      ).c;

      const claimCount = (
        db
          .prepare(`SELECT COUNT(*) as c FROM claims WHERE workspace_id = ? AND created_at >= ?`)
          .get(workspace, since) as { c: number }
      ).c;

      const blockerCount = (
        db
          .prepare(`SELECT COUNT(*) as c FROM blockers WHERE workspace_id = ? AND created_at >= ?`)
          .get(workspace, since) as { c: number }
      ).c;

      const total = handoffCount + claimCount + blockerCount;

      return reply.send({
        workspace,
        period_hours: totalHours,
        handoffs: handoffCount,
        claims: claimCount,
        blockers: blockerCount,
        total,
        per_hour: totalHours > 0 ? Math.round((total / totalHours) * 100) / 100 : 0,
      });
    },
  );

  // F-205: Blocker trend over time
  app.get(
    "/api/v1/workspaces/:workspace/blocker-trend",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { days = "7" } = request.query as { days?: string };
      const totalDays = Math.min(Number.parseInt(days, 10) || 7, 90);
      const now = new Date();

      const blockers = db
        .prepare(`SELECT created_at, resolved_at, status FROM blockers WHERE workspace_id = ?`)
        .all(workspace) as { created_at: string; resolved_at: string | null; status: string }[];

      const trend: { date: string; opened: number; resolved: number; cumulative_open: number }[] =
        [];
      let cumOpen = 0;
      for (let i = totalDays - 1; i >= 0; i--) {
        const dayStart = new Date(now);
        dayStart.setDate(dayStart.getDate() - i);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);
        const dateStr = dayStart.toISOString().split("T")[0];

        const opened = blockers.filter((b) => {
          const t = new Date(b.created_at).getTime();
          return t >= dayStart.getTime() && t < dayEnd.getTime();
        }).length;

        const resolved = blockers.filter((b) => {
          if (!b.resolved_at) return false;
          const t = new Date(b.resolved_at).getTime();
          return t >= dayStart.getTime() && t < dayEnd.getTime();
        }).length;

        cumOpen += opened - resolved;
        trend.push({ date: dateStr, opened, resolved, cumulative_open: cumOpen });
      }

      return reply.send({ workspace, days: totalDays, trend });
    },
  );
};

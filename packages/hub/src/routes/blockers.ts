import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/index.js";
import { writeAuditLog } from "../services/audit.js";
import { createBlocker, listBlockers, resolveBlocker } from "../services/blockers.js";
import { broadcast } from "../ws/gateway.js";

function notifyWatchers(
  blockerId: string,
  workspace: string,
  event: string,
  extra: Record<string, unknown> = {},
): void {
  const watchers = db
    .prepare("SELECT agent_id FROM blocker_watchers WHERE blocker_id = ? AND workspace_id = ?")
    .all(blockerId, workspace) as Array<{ agent_id: string }>;
  if (watchers.length === 0) return;
  broadcast("blocker.watcher_notify", {
    workspace,
    blocker_id: blockerId,
    trigger: event,
    watchers: watchers.map((w) => w.agent_id),
    ...extra,
  });
}

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
            deadline_seconds: { type: "integer", minimum: 60, maximum: 604800 },
            auto_assign_capability: { type: "string", maxLength: 128 },
            depends_on: {
              type: "array",
              maxItems: 20,
              items: { type: "string", minLength: 1, maxLength: 128 },
            },
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
        deadline_seconds?: number;
        depends_on?: string[];
        auto_assign_capability?: string;
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
        deadlineSeconds: body.deadline_seconds,
      });

      if (body.depends_on?.length) {
        const insertDep = db.prepare(
          "INSERT OR IGNORE INTO blocker_dependencies (blocker_id, depends_on_blocker_id) VALUES (?, ?)",
        );
        for (const depId of body.depends_on) {
          insertDep.run(id, depId);
        }
      }

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

      let assigned_to: string | null = null;
      if (body.auto_assign_capability) {
        const agents = db
          .prepare(
            "SELECT agent_id, capabilities FROM agents WHERE workspace_id = ? AND status = 'online' AND agent_id != ?",
          )
          .all(workspace, body.agent_id) as Array<{
          agent_id: string;
          capabilities: string;
        }>;
        const cap = body.auto_assign_capability;
        const match = agents.find((a) => {
          try {
            return (JSON.parse(a.capabilities) as string[]).includes(cap);
          } catch {
            return false;
          }
        });
        if (match) {
          db.prepare(
            "INSERT OR IGNORE INTO blocker_watchers (blocker_id, agent_id, workspace_id) VALUES (?, ?, ?)",
          ).run(id, match.agent_id, workspace);
          assigned_to = match.agent_id;
          broadcast("blocker.watcher_notify", {
            workspace,
            blocker_id: id,
            trigger: "auto_assigned",
            watchers: [match.agent_id],
          });
        }
      }

      return reply.code(201).send({ blocker_id: id, ...(assigned_to ? { assigned_to } : {}) });
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
      notifyWatchers(blockerId, workspace, "resolved");
      return reply.send({ ok: true });
    },
  );

  /* ── F-58  blocker escalation ───────────────────────────────── */
  app.post(
    "/api/v1/workspaces/:workspace/blockers/:blockerId/escalate",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { blockerId, workspace } = request.params as {
        blockerId: string;
        workspace: string;
      };
      const row = db
        .prepare("SELECT * FROM blockers WHERE blocker_id = ? AND workspace_id = ?")
        .get(blockerId, workspace) as Record<string, unknown> | undefined;
      if (!row) {
        return reply.code(404).send({ error: "Blocker not found" });
      }
      if (row.status === "resolved") {
        return reply.code(422).send({ error: "Cannot escalate resolved blocker" });
      }

      const newLevel = Number(row.escalation_level ?? 0) + 1;
      db.prepare("UPDATE blockers SET escalation_level = ? WHERE blocker_id = ?").run(
        newLevel,
        blockerId,
      );

      writeAuditLog({
        workspaceId: workspace,
        actorType: "system",
        action: "blocker.escalate",
        entityType: "blocker",
        entityId: blockerId,
        payload: { escalation_level: newLevel },
      });

      broadcast("blocker.escalated", {
        workspace,
        blocker_id: blockerId,
        escalation_level: newLevel,
      });
      notifyWatchers(blockerId, workspace, "escalated", {
        escalation_level: newLevel,
      });
      return reply.send({ ok: true, escalation_level: newLevel });
    },
  );

  /* ── F-61  blocker deadline extension ───────────────────────── */
  app.post(
    "/api/v1/workspaces/:workspace/blockers/:blockerId/extend-deadline",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["additional_seconds"],
          additionalProperties: false,
          properties: {
            additional_seconds: { type: "integer", minimum: 60, maximum: 604800 },
          },
        },
      },
    },
    async (request, reply) => {
      const { blockerId, workspace } = request.params as {
        blockerId: string;
        workspace: string;
      };
      const { additional_seconds } = request.body as { additional_seconds: number };

      const row = db
        .prepare("SELECT * FROM blockers WHERE blocker_id = ? AND workspace_id = ?")
        .get(blockerId, workspace) as Record<string, unknown> | undefined;
      if (!row) {
        return reply.code(404).send({ error: "Blocker not found" });
      }
      if (row.status === "resolved") {
        return reply.code(422).send({ error: "Cannot extend resolved blocker" });
      }
      if (!row.deadline_at) {
        return reply.code(422).send({ error: "Blocker has no deadline" });
      }

      db.prepare(
        "UPDATE blockers SET deadline_at = datetime(deadline_at, '+' || ? || ' seconds') WHERE blocker_id = ?",
      ).run(additional_seconds, blockerId);

      const updated = db
        .prepare("SELECT deadline_at FROM blockers WHERE blocker_id = ?")
        .get(blockerId) as { deadline_at: string };

      writeAuditLog({
        workspaceId: workspace,
        actorType: "system",
        action: "blocker.extend_deadline",
        entityType: "blocker",
        entityId: blockerId,
        payload: { additional_seconds, new_deadline: updated.deadline_at },
      });

      return reply.send({ ok: true, new_deadline: updated.deadline_at });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/blockers",
    {
      preHandler: app.authGuard,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: ["open", "resolved"] },
            severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
            agent_id: { type: "string", maxLength: 128 },
            created_after: { type: "string", maxLength: 30 },
            created_before: { type: "string", maxLength: 30 },
            sort_by: { type: "string", enum: ["created_at", "severity"] },
            sort_order: { type: "string", enum: ["asc", "desc"] },
            limit: { type: "string" },
            offset: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const q = request.query as {
        limit?: string;
        offset?: string;
        status?: string;
        severity?: string;
        agent_id?: string;
        created_after?: string;
        created_before?: string;
        sort_by?: string;
        sort_order?: string;
      };
      let all = listBlockers(workspace);
      if (q.status) {
        all = all.filter((b) => b.status === q.status);
      }
      if (q.severity) {
        all = all.filter((b) => b.severity === q.severity);
      }
      if (q.agent_id) {
        all = all.filter((b) => b.agent_id === q.agent_id);
      }
      if (q.created_after) {
        all = all.filter((b) => String(b.created_at) >= q.created_after!);
      }
      if (q.created_before) {
        all = all.filter((b) => String(b.created_at) <= q.created_before!);
      }
      if (q.sort_by) {
        const sevOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
        const dir = q.sort_order === "asc" ? 1 : -1;
        all.sort((a, b) => {
          if (q.sort_by === "severity") {
            return (
              dir * ((sevOrder[String(a.severity)] ?? 2) - (sevOrder[String(b.severity)] ?? 2))
            );
          }
          return dir * String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
        });
      }
      const start = Math.max(0, Number(q.offset) || 0);
      const count = Math.min(200, Math.max(1, Number(q.limit) || 50));
      return reply.send({ data: all.slice(start, start + count), total: all.length });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/blockers/:blockerId",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, blockerId } = request.params as {
        workspace: string;
        blockerId: string;
      };
      const row = db
        .prepare("SELECT * FROM blockers WHERE blocker_id = ? AND workspace_id = ?")
        .get(blockerId, workspace);
      if (!row) {
        return reply.code(404).send({ error: "Blocker not found" });
      }
      const timeline = db
        .prepare(
          "SELECT action, actor_type, actor_id, payload, created_at FROM audit_log WHERE entity_type = 'blocker' AND entity_id = ? ORDER BY created_at ASC",
        )
        .all(blockerId) as Array<Record<string, unknown>>;
      return reply.send({ ...(row as Record<string, unknown>), timeline });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/blockers/stats",
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
          "SELECT status, COUNT(*) as count FROM blockers WHERE workspace_id = ? GROUP BY status",
        )
        .all(workspace) as Array<{ status: string; count: number }>;
      const bySeverity = db
        .prepare(
          "SELECT severity, COUNT(*) as count FROM blockers WHERE workspace_id = ? GROUP BY severity",
        )
        .all(workspace) as Array<{ severity: string; count: number }>;
      const avgResolutionTime = db
        .prepare(
          "SELECT AVG(julianday(resolved_at) - julianday(created_at)) * 86400 as avg_seconds FROM blockers WHERE workspace_id = ? AND status = 'resolved'",
        )
        .get(workspace) as { avg_seconds: number | null };

      return reply.send({
        by_status: Object.fromEntries(byStatus.map((r) => [r.status, r.count])),
        by_severity: Object.fromEntries(bySeverity.map((r) => [r.severity, r.count])),
        avg_resolution_seconds: avgResolutionTime.avg_seconds
          ? Math.round(avgResolutionTime.avg_seconds)
          : null,
      });
    },
  );

  /* ── F-69  blocker watchers ─────────────────────────────────── */
  app.post(
    "/api/v1/workspaces/:workspace/blockers/:blockerId/watchers",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["agent_id"],
          additionalProperties: false,
          properties: {
            agent_id: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace, blockerId } = request.params as {
        workspace: string;
        blockerId: string;
      };
      const blocker = db
        .prepare("SELECT blocker_id FROM blockers WHERE blocker_id = ? AND workspace_id = ?")
        .get(blockerId, workspace);
      if (!blocker) {
        return reply.code(404).send({ error: "Blocker not found" });
      }
      const body = request.body as { agent_id: string };
      db.prepare(
        "INSERT OR IGNORE INTO blocker_watchers (blocker_id, agent_id, workspace_id) VALUES (?, ?, ?)",
      ).run(blockerId, body.agent_id, workspace);
      return reply.code(201).send({ ok: true });
    },
  );

  app.delete(
    "/api/v1/workspaces/:workspace/blockers/:blockerId/watchers/:agentId",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, blockerId, agentId } = request.params as {
        workspace: string;
        blockerId: string;
        agentId: string;
      };
      db.prepare(
        "DELETE FROM blocker_watchers WHERE blocker_id = ? AND agent_id = ? AND workspace_id = ?",
      ).run(blockerId, agentId, workspace);
      return reply.send({ ok: true });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/blockers/:blockerId/watchers",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, blockerId } = request.params as {
        workspace: string;
        blockerId: string;
      };
      const blocker = db
        .prepare("SELECT blocker_id FROM blockers WHERE blocker_id = ? AND workspace_id = ?")
        .get(blockerId, workspace);
      if (!blocker) {
        return reply.code(404).send({ error: "Blocker not found" });
      }
      const watchers = db
        .prepare(
          "SELECT agent_id, created_at FROM blocker_watchers WHERE blocker_id = ? AND workspace_id = ?",
        )
        .all(blockerId, workspace);
      return reply.send({ data: watchers });
    },
  );

  /* ── F-81  blocker comments ─────────────────────────────────── */
  app.post(
    "/api/v1/workspaces/:workspace/blockers/:blockerId/comments",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["author_id", "content"],
          additionalProperties: false,
          properties: {
            author_id: { type: "string", minLength: 1, maxLength: 128 },
            content: { type: "string", minLength: 1, maxLength: 4096 },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace, blockerId } = request.params as { workspace: string; blockerId: string };
      const body = request.body as { author_id: string; content: string };
      const exists = db
        .prepare("SELECT blocker_id FROM blockers WHERE blocker_id = ? AND workspace_id = ?")
        .get(blockerId, workspace);
      if (!exists) {
        return reply.code(404).send({ error: "Blocker not found" });
      }
      db.prepare(
        "INSERT INTO blocker_comments (blocker_id, workspace_id, author_id, content) VALUES (?, ?, ?, ?)",
      ).run(blockerId, workspace, body.author_id, body.content);
      return reply.code(201).send({ ok: true });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/blockers/:blockerId/comments",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, blockerId } = request.params as { workspace: string; blockerId: string };
      const exists = db
        .prepare("SELECT blocker_id FROM blockers WHERE blocker_id = ? AND workspace_id = ?")
        .get(blockerId, workspace);
      if (!exists) {
        return reply.code(404).send({ error: "Blocker not found" });
      }
      const comments = db
        .prepare(
          "SELECT id, author_id, content, created_at FROM blocker_comments WHERE blocker_id = ? AND workspace_id = ? ORDER BY id ASC",
        )
        .all(blockerId, workspace);
      return reply.send({ data: comments });
    },
  );

  /* ── F-87  blocker dependencies GET ─────────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/blockers/:blockerId/dependencies",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, blockerId } = request.params as { workspace: string; blockerId: string };
      const exists = db
        .prepare("SELECT blocker_id FROM blockers WHERE blocker_id = ? AND workspace_id = ?")
        .get(blockerId, workspace);
      if (!exists) {
        return reply.code(404).send({ error: "Blocker not found" });
      }
      const deps = db
        .prepare("SELECT depends_on_blocker_id FROM blocker_dependencies WHERE blocker_id = ?")
        .all(blockerId) as Array<{ depends_on_blocker_id: string }>;
      return reply.send({ data: deps.map((d) => d.depends_on_blocker_id) });
    },
  );

  /* ── F-93  blocker bulk resolve ─────────────────────────────── */
  app.post(
    "/api/v1/workspaces/:workspace/blockers/bulk-resolve",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["blocker_ids"],
          additionalProperties: false,
          properties: {
            blocker_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 },
            resolved_by: { type: "string", maxLength: 128 },
            note: { type: "string", maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { blocker_ids, resolved_by, note } = request.body as {
        blocker_ids: string[];
        resolved_by?: string;
        note?: string;
      };
      const results: Array<{ blocker_id: string; resolved: boolean }> = [];
      for (const bid of blocker_ids) {
        const exists = db
          .prepare("SELECT blocker_id FROM blockers WHERE blocker_id = ? AND workspace_id = ?")
          .get(bid, workspace);
        if (!exists) {
          results.push({ blocker_id: bid, resolved: false });
          continue;
        }
        const ok = resolveBlocker(bid, resolved_by ?? "operator", note);
        results.push({ blocker_id: bid, resolved: ok });
        if (ok) {
          writeAuditLog({
            workspaceId: workspace,
            actorType: "system",
            action: "blocker.resolve",
            entityType: "blocker",
            entityId: bid,
            requestId: request.id,
            payload: { resolved_by, note },
          });
          broadcast("blocker.resolved", { workspace, blocker_id: bid });
          notifyWatchers(bid, workspace, "resolved");
        }
      }
      return reply.send({ results });
    },
  );

  /* ── F-99  blocker severity distribution ─────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/blockers/severity-distribution",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const rows = db
        .prepare(
          "SELECT severity, COUNT(*) as count FROM blockers WHERE workspace_id = ? GROUP BY severity ORDER BY count DESC",
        )
        .all(workspace) as Array<{ severity: string; count: number }>;
      return reply.send({ data: rows });
    },
  );

  /* ── F-105  blocker timeline view ───────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/blockers/:blockerId/timeline",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, blockerId } = request.params as {
        workspace: string;
        blockerId: string;
      };
      const blocker = db
        .prepare(
          "SELECT blocker_id, created_at, resolved_at, status FROM blockers WHERE blocker_id = ? AND workspace_id = ?",
        )
        .get(blockerId, workspace) as
        | { blocker_id: string; created_at: string; resolved_at: string | null; status: string }
        | undefined;
      if (!blocker) {
        return reply.code(404).send({ error: "Blocker not found" });
      }

      const events: Array<{ type: string; timestamp: string; detail: unknown }> = [];

      events.push({
        type: "created",
        timestamp: blocker.created_at,
        detail: { blocker_id: blockerId },
      });

      // escalation info is stored as a column on blockers table (no separate table)
      const b = db
        .prepare("SELECT escalation_level FROM blockers WHERE blocker_id = ?")
        .get(blockerId) as { escalation_level: number } | undefined;
      if (b && b.escalation_level > 0) {
        events.push({
          type: "escalated",
          timestamp: blocker.created_at,
          detail: { level: b.escalation_level },
        });
      }

      const comments = db
        .prepare(
          "SELECT author_id, content, created_at FROM blocker_comments WHERE blocker_id = ? ORDER BY created_at ASC",
        )
        .all(blockerId) as Array<{
        author_id: string;
        content: string;
        created_at: string;
      }>;
      for (const c of comments) {
        events.push({
          type: "comment",
          timestamp: c.created_at,
          detail: { author: c.author_id, content: c.content },
        });
      }

      if (blocker.resolved_at) {
        events.push({
          type: "resolved",
          timestamp: blocker.resolved_at,
          detail: { status: blocker.status },
        });
      }

      events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      return reply.send({ blocker_id: blockerId, timeline: events });
    },
  );

  /* ── F-113  blocker resolution metrics ──────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/blockers/resolution-metrics",
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
          `SELECT severity,
                  COUNT(*) as total,
                  ROUND(AVG(julianday(resolved_at) - julianday(created_at)) * 86400) as avg_seconds,
                  ROUND(MIN(julianday(resolved_at) - julianday(created_at)) * 86400) as min_seconds,
                  ROUND(MAX(julianday(resolved_at) - julianday(created_at)) * 86400) as max_seconds
           FROM blockers
           WHERE workspace_id = ? AND status = 'resolved'
           GROUP BY severity
           ORDER BY severity`,
        )
        .all(workspace) as Array<Record<string, unknown>>;
      return reply.send({ data: rows });
    },
  );

  /* ── F-119  blocker correlation ─────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/blockers/correlation",
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
          `SELECT agent_id, COUNT(*) as blocker_count,
                  GROUP_CONCAT(title, ' | ') as titles
           FROM blockers
           WHERE workspace_id = ?
           GROUP BY agent_id
           HAVING COUNT(*) > 1
           ORDER BY blocker_count DESC`,
        )
        .all(workspace);
      return reply.send({ data: rows });
    },
  );

  /* ── F-125  blocker age distribution ──────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/blockers/age-distribution",
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
             CASE
               WHEN (julianday('now') - julianday(created_at)) * 24 < 1 THEN 'under_1h'
               WHEN (julianday('now') - julianday(created_at)) * 24 < 24 THEN '1h_to_24h'
               WHEN (julianday('now') - julianday(created_at)) < 7 THEN '1d_to_7d'
               ELSE 'over_7d'
             END as bucket,
             COUNT(*) as count
           FROM blockers
           WHERE workspace_id = ? AND status = 'open'
           GROUP BY bucket`,
        )
        .all(workspace);
      return reply.send({ data: rows });
    },
  );

  /* ── F-134  blocker escalation rate ──────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/blockers/escalation-rate",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const ws = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      const total = (
        db.prepare("SELECT COUNT(*) as c FROM blockers WHERE workspace_id = ?").get(workspace) as {
          c: number;
        }
      ).c;
      const escalated = (
        db
          .prepare(
            "SELECT COUNT(*) as c FROM blockers WHERE workspace_id = ? AND escalation_level > 0",
          )
          .get(workspace) as { c: number }
      ).c;
      const rate = total > 0 ? Math.round((escalated / total) * 10000) / 100 : 0;
      return reply.send({ total, escalated, escalation_rate: rate });
    },
  );

  /* ── F-140  blocker severity trend ──────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/blockers/severity-trend",
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
          `SELECT severity,
                  strftime('%Y-%m-%d', created_at) as day,
                  COUNT(*) as count
           FROM blockers WHERE workspace_id = ?
           GROUP BY severity, day
           ORDER BY day DESC, severity ASC
           LIMIT 200`,
        )
        .all(workspace);
      return reply.send({ data: rows });
    },
  );

  /* ── F-151  blocker impact analysis ────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/blockers/impact",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      // Find how many agents are affected by each open blocker
      const blockers = db
        .prepare(
          `SELECT b.blocker_id, b.title, b.severity, b.agent_id,
           (SELECT COUNT(*) FROM blocker_watchers w WHERE w.blocker_id = b.blocker_id) as watcher_count,
           (SELECT COUNT(*) FROM blocker_dependencies d WHERE d.depends_on_blocker_id = b.blocker_id) as dependent_count,
           CAST((julianday('now') - julianday(b.created_at)) * 24 AS INTEGER) as hours_open
           FROM blockers b
           WHERE b.workspace_id = ? AND b.status = 'open'
           ORDER BY (watcher_count + dependent_count) DESC, b.created_at ASC`,
        )
        .all(workspace) as Array<{
        blocker_id: string;
        title: string;
        severity: string;
        agent_id: string;
        watcher_count: number;
        dependent_count: number;
        hours_open: number;
      }>;

      const totalImpact = blockers.reduce((sum, b) => sum + b.watcher_count + b.dependent_count, 0);

      return reply.send({
        total_open: blockers.length,
        total_impact_score: totalImpact,
        blockers,
      });
    },
  );

  /* ── F-158  blocker resolution timeline ────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/blockers/resolution-timeline",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { days = "30" } = request.query as { days?: string };
      const dayCount = Math.min(Math.max(Number.parseInt(days, 10) || 30, 1), 365);

      const timeline = db
        .prepare(
          `SELECT date(resolved_at) as day,
             COUNT(*) as resolved_count,
             AVG(CAST((julianday(resolved_at) - julianday(created_at)) * 24 AS REAL)) as avg_hours_to_resolve,
             MIN(CAST((julianday(resolved_at) - julianday(created_at)) * 24 AS REAL)) as min_hours,
             MAX(CAST((julianday(resolved_at) - julianday(created_at)) * 24 AS REAL)) as max_hours
           FROM blockers
           WHERE workspace_id = ? AND status = 'resolved'
             AND resolved_at >= datetime('now', ?)
           GROUP BY date(resolved_at)
           ORDER BY day ASC`,
        )
        .all(workspace, `-${dayCount} days`) as Array<{
        day: string;
        resolved_count: number;
        avg_hours_to_resolve: number;
        min_hours: number;
        max_hours: number;
      }>;

      const totalResolved = timeline.reduce((s, t) => s + t.resolved_count, 0);
      const avgTime =
        totalResolved > 0
          ? +(
              timeline.reduce((s, t) => s + t.avg_hours_to_resolve * t.resolved_count, 0) /
              totalResolved
            ).toFixed(2)
          : 0;

      return reply.send({
        period_days: dayCount,
        total_resolved: totalResolved,
        avg_hours_to_resolve: avgTime,
        timeline,
      });
    },
  );

  /* ── F-162  blocker bulk severity update ───────────── */
  app.patch(
    "/api/v1/workspaces/:workspace/blockers/bulk-update-severity",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["blocker_ids", "severity"],
          properties: {
            blocker_ids: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: 50,
            },
            severity: {
              type: "string",
              enum: ["low", "medium", "high", "critical"],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { blocker_ids, severity } = request.body as {
        blocker_ids: string[];
        severity: string;
      };

      const placeholders = blocker_ids.map(() => "?").join(",");
      const updated = db
        .prepare(
          `UPDATE blockers SET severity = ?
           WHERE blocker_id IN (${placeholders}) AND workspace_id = ? AND status = 'open'`,
        )
        .run(severity, ...blocker_ids, workspace);

      broadcast("blockers.bulk_severity_updated", {
        workspace,
        blocker_ids,
        severity,
      });

      return reply.send({
        updated: updated.changes,
        severity,
      });
    },
  );

  /* ── F-166  blocker cascade analysis ──────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/blockers/cascade-analysis",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      // Find blockers that have dependencies (blocking other blockers)
      const deps = db
        .prepare(
          `SELECT bd.blocker_id, bd.depends_on_blocker_id,
             b1.title as blocker_title, b1.status as blocker_status,
             b2.title as dependency_title, b2.status as dependency_status
           FROM blocker_dependencies bd
           JOIN blockers b1 ON b1.blocker_id = bd.blocker_id
           JOIN blockers b2 ON b2.blocker_id = bd.depends_on_blocker_id
           WHERE b1.workspace_id = ?`,
        )
        .all(workspace) as Array<{
        blocker_id: string;
        depends_on_blocker_id: string;
        blocker_title: string;
        blocker_status: string;
        dependency_title: string;
        dependency_status: string;
      }>;

      // Find cascade roots: blockers that others depend on but aren't resolved
      const rootBlockers = new Set<string>();
      const blocked = new Map<string, string[]>();
      for (const d of deps) {
        if (d.dependency_status === "open") {
          rootBlockers.add(d.depends_on_blocker_id);
        }
        const list = blocked.get(d.depends_on_blocker_id) ?? [];
        list.push(d.blocker_id);
        blocked.set(d.depends_on_blocker_id, list);
      }

      const cascades = Array.from(rootBlockers).map((rootId) => ({
        root_blocker_id: rootId,
        blocked_count: blocked.get(rootId)?.length ?? 0,
        blocked_ids: blocked.get(rootId) ?? [],
      }));

      cascades.sort((a, b) => b.blocked_count - a.blocked_count);

      return reply.send({
        total_dependencies: deps.length,
        cascade_roots: cascades.length,
        cascades,
      });
    },
  );

  // F-171: Blocker SLA compliance
  app.get(
    "/api/v1/workspaces/:workspace/blockers/sla-compliance",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const resolved = db
        .prepare(
          `SELECT blocker_id, title, severity, deadline_at, resolved_at,
                  CASE WHEN deadline_at IS NOT NULL AND resolved_at IS NOT NULL
                       AND datetime(resolved_at) <= datetime(deadline_at) THEN 1 ELSE 0 END as met_sla
           FROM blockers
           WHERE workspace_id = ? AND status = 'resolved' AND deadline_at IS NOT NULL`,
        )
        .all(workspace) as Array<{
        blocker_id: string;
        title: string;
        severity: string;
        deadline_at: string;
        resolved_at: string;
        met_sla: number;
      }>;

      const overdue = db
        .prepare(
          `SELECT blocker_id, title, severity, deadline_at
           FROM blockers
           WHERE workspace_id = ? AND status != 'resolved'
                 AND deadline_at IS NOT NULL AND datetime(deadline_at) < datetime('now')`,
        )
        .all(workspace) as Array<{
        blocker_id: string;
        title: string;
        severity: string;
        deadline_at: string;
      }>;

      const metCount = resolved.filter((r) => r.met_sla === 1).length;
      const complianceRate =
        resolved.length > 0 ? Math.round((metCount / resolved.length) * 10000) / 100 : 100;

      return reply.send({
        total_with_deadline: resolved.length + overdue.length,
        resolved_with_deadline: resolved.length,
        met_sla: metCount,
        missed_sla: resolved.length - metCount,
        currently_overdue: overdue.length,
        compliance_rate: complianceRate,
        overdue_blockers: overdue,
      });
    },
  );

  // F-176: Blocker creation heatmap
  app.get(
    "/api/v1/workspaces/:workspace/blockers/heatmap",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const rows = db
        .prepare(
          `SELECT strftime('%H', created_at) as hour, strftime('%w', created_at) as dow, COUNT(*) as count
           FROM blockers WHERE workspace_id = ?
           GROUP BY hour, dow
           ORDER BY dow, hour`,
        )
        .all(workspace) as Array<{ hour: string; dow: string; count: number }>;

      const dayNames = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
      ];
      const heatmap = rows.map((r) => ({
        day_of_week: dayNames[Number.parseInt(r.dow, 10)] ?? r.dow,
        hour: Number.parseInt(r.hour, 10),
        count: r.count,
      }));

      const peakHour = rows.reduce((max, r) => (r.count > max.count ? r : max), {
        hour: "0",
        dow: "0",
        count: 0,
      });

      return reply.send({
        total_blockers: rows.reduce((s, r) => s + r.count, 0),
        peak_hour: Number.parseInt(peakHour.hour, 10),
        peak_day: dayNames[Number.parseInt(peakHour.dow, 10)] ?? peakHour.dow,
        heatmap,
      });
    },
  );

  // F-182: Blocker clustering
  app.get(
    "/api/v1/workspaces/:workspace/blockers/clustering",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      // Cluster by agent + severity
      const clusters = db
        .prepare(
          `SELECT agent_id, severity, COUNT(*) as count,
                  MIN(created_at) as earliest, MAX(created_at) as latest
           FROM blockers WHERE workspace_id = ?
           GROUP BY agent_id, severity
           HAVING COUNT(*) > 0
           ORDER BY count DESC`,
        )
        .all(workspace) as Array<{
        agent_id: string;
        severity: string;
        count: number;
        earliest: string;
        latest: string;
      }>;

      const byAgent = db
        .prepare(
          `SELECT agent_id, COUNT(*) as count
           FROM blockers WHERE workspace_id = ?
           GROUP BY agent_id ORDER BY count DESC`,
        )
        .all(workspace) as Array<{ agent_id: string; count: number }>;

      const bySeverity = db
        .prepare(
          `SELECT severity, COUNT(*) as count
           FROM blockers WHERE workspace_id = ?
           GROUP BY severity ORDER BY count DESC`,
        )
        .all(workspace) as Array<{ severity: string; count: number }>;

      return reply.send({
        total_clusters: clusters.length,
        clusters,
        by_agent: byAgent,
        by_severity: bySeverity,
      });
    },
  );

  // F-187: Blocker resolution velocity
  app.get(
    "/api/v1/workspaces/:workspace/blockers/resolution-velocity",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const resolved = db
        .prepare(
          `SELECT blocker_id, severity, created_at, resolved_at,
                  ROUND((julianday(resolved_at) - julianday(created_at)) * 24, 2) as resolution_hours
           FROM blockers
           WHERE workspace_id = ? AND status = 'resolved' AND resolved_at IS NOT NULL`,
        )
        .all(workspace) as Array<{
        blocker_id: string;
        severity: string;
        created_at: string;
        resolved_at: string;
        resolution_hours: number;
      }>;

      const avgHours =
        resolved.length > 0
          ? Math.round(
              (resolved.reduce((s, r) => s + r.resolution_hours, 0) / resolved.length) * 100,
            ) / 100
          : 0;

      // By severity
      const bySeverity: Record<string, { count: number; avg_hours: number }> = {};
      for (const r of resolved) {
        if (!bySeverity[r.severity]) bySeverity[r.severity] = { count: 0, avg_hours: 0 };
        bySeverity[r.severity].count++;
        bySeverity[r.severity].avg_hours += r.resolution_hours;
      }
      for (const key of Object.keys(bySeverity)) {
        bySeverity[key].avg_hours =
          Math.round((bySeverity[key].avg_hours / bySeverity[key].count) * 100) / 100;
      }

      return reply.send({
        total_resolved: resolved.length,
        avg_resolution_hours: avgHours,
        by_severity: Object.entries(bySeverity).map(([severity, stats]) => ({
          severity,
          ...stats,
        })),
        fastest:
          resolved.length > 0
            ? resolved
                .sort((a, b) => a.resolution_hours - b.resolution_hours)
                .slice(0, 5)
                .map((r) => ({
                  blocker_id: r.blocker_id,
                  resolution_hours: r.resolution_hours,
                }))
            : [],
      });
    },
  );
};

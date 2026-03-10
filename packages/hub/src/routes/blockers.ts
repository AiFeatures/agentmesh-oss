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

  // F-192: Blocker dependency depth — analyze chains of blocker dependencies
  app.get(
    "/api/v1/workspaces/:workspace/blockers/dependency-depth",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const blockers = db
        .prepare(`SELECT blocker_id FROM blockers WHERE workspace_id = ?`)
        .all(workspace) as { blocker_id: string }[];

      const deps = db
        .prepare(
          `SELECT bd.blocker_id, bd.depends_on_blocker_id
           FROM blocker_dependencies bd
           JOIN blockers b ON b.blocker_id = bd.blocker_id
           WHERE b.workspace_id = ?`,
        )
        .all(workspace) as { blocker_id: string; depends_on_blocker_id: string }[];

      // Build adjacency: blocker -> depends on
      const adj: Record<string, string[]> = {};
      for (const d of deps) {
        if (!adj[d.blocker_id]) adj[d.blocker_id] = [];
        adj[d.blocker_id].push(d.depends_on_blocker_id);
      }

      // BFS depth for each blocker
      const depths: { blocker_id: string; depth: number }[] = [];
      for (const b of blockers) {
        const visited = new Set<string>();
        let depth = 0;
        let queue = [b.blocker_id];
        while (queue.length > 0) {
          const next: string[] = [];
          for (const id of queue) {
            if (visited.has(id)) continue;
            visited.add(id);
            for (const dep of adj[id] || []) {
              if (!visited.has(dep)) next.push(dep);
            }
          }
          if (next.length > 0) depth++;
          queue = next;
        }
        depths.push({ blocker_id: b.blocker_id, depth });
      }

      const maxDepth = depths.reduce((m, d) => Math.max(m, d.depth), 0);
      const avgDepth =
        depths.length > 0
          ? Math.round((depths.reduce((s, d) => s + d.depth, 0) / depths.length) * 100) / 100
          : 0;
      const deepest = depths.filter((d) => d.depth === maxDepth).map((d) => d.blocker_id);

      return reply.send({
        workspace,
        total_blockers: blockers.length,
        max_depth: maxDepth,
        avg_depth: avgDepth,
        deepest_blockers: deepest,
        depth_distribution: depths.reduce(
          (acc, d) => {
            acc[d.depth] = (acc[d.depth] || 0) + 1;
            return acc;
          },
          {} as Record<number, number>,
        ),
      });
    },
  );

  // F-197: Blocker recurrence rate — detect similar titles that recur
  app.get(
    "/api/v1/workspaces/:workspace/blockers/recurrence-rate",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const allBlockers = db
        .prepare(
          `SELECT blocker_id, title, status, created_at FROM blockers WHERE workspace_id = ? ORDER BY created_at`,
        )
        .all(workspace) as {
        blocker_id: string;
        title: string;
        status: string;
        created_at: string;
      }[];

      // Group by normalized title (lowercase, trimmed)
      const groups: Record<string, typeof allBlockers> = {};
      for (const b of allBlockers) {
        const key = b.title.toLowerCase().trim();
        if (!groups[key]) groups[key] = [];
        groups[key].push(b);
      }

      const recurring = Object.entries(groups)
        .filter(([_, items]) => items.length > 1)
        .map(([title, items]) => ({
          title,
          count: items.length,
          first_seen: items[0].created_at,
          last_seen: items[items.length - 1].created_at,
        }))
        .sort((a, b) => b.count - a.count);

      const totalRecurring = recurring.reduce((s, r) => s + r.count, 0);
      const recurrenceRate =
        allBlockers.length > 0
          ? Math.round((totalRecurring / allBlockers.length) * 10000) / 100
          : 0;

      return reply.send({
        workspace,
        total_blockers: allBlockers.length,
        recurring_groups: recurring.length,
        recurring_blocker_count: totalRecurring,
        recurrence_rate_percent: recurrenceRate,
        top_recurring: recurring.slice(0, 10),
      });
    },
  );

  // F-202: Blocker agent impact — which agents are most impacted
  app.get(
    "/api/v1/workspaces/:workspace/blockers/agent-impact",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const blockers = db
        .prepare(`SELECT agent_id, severity, status FROM blockers WHERE workspace_id = ?`)
        .all(workspace) as { agent_id: string; severity: string; status: string }[];

      const agentImpact: Record<
        string,
        { total: number; open: number; critical: number; high: number }
      > = {};
      for (const b of blockers) {
        if (!agentImpact[b.agent_id])
          agentImpact[b.agent_id] = { total: 0, open: 0, critical: 0, high: 0 };
        agentImpact[b.agent_id].total++;
        if (b.status === "open") agentImpact[b.agent_id].open++;
        if (b.severity === "critical") agentImpact[b.agent_id].critical++;
        if (b.severity === "high") agentImpact[b.agent_id].high++;
      }

      const agents = Object.entries(agentImpact)
        .map(([agent_id, stats]) => ({
          agent_id,
          ...stats,
          impact_score: stats.open + stats.critical * 3 + stats.high * 2,
        }))
        .sort((a, b) => b.impact_score - a.impact_score);

      return reply.send({
        workspace,
        total_blockers: blockers.length,
        agents,
      });
    },
  );

  // F-210: Blocker severity impact analysis
  app.get(
    "/api/v1/workspaces/:workspace/blockers/severity-impact",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const blockers = db
        .prepare(`SELECT severity, status, agent_id FROM blockers WHERE workspace_id = ?`)
        .all(workspace) as { severity: string; status: string; agent_id: string }[];

      const weights: Record<string, number> = { critical: 10, high: 5, medium: 2, low: 1 };

      const bySeverity: Record<
        string,
        { count: number; open: number; resolved: number; weight: number }
      > = {};
      let totalWeight = 0;
      for (const b of blockers) {
        if (!bySeverity[b.severity])
          bySeverity[b.severity] = { count: 0, open: 0, resolved: 0, weight: 0 };
        bySeverity[b.severity].count++;
        const w = weights[b.severity] || 1;
        bySeverity[b.severity].weight += w;
        totalWeight += w;
        if (b.status === "open") bySeverity[b.severity].open++;
        else if (b.status === "resolved") bySeverity[b.severity].resolved++;
      }

      const impactedAgents = new Set(
        blockers.filter((b) => b.status === "open").map((b) => b.agent_id),
      ).size;

      return reply.send({
        workspace,
        total_blockers: blockers.length,
        total_weight: totalWeight,
        impacted_agents: impactedAgents,
        by_severity: Object.entries(bySeverity).map(([severity, stats]) => ({
          severity,
          ...stats,
        })),
      });
    },
  );

  // F-215: Blocker open duration statistics
  app.get(
    "/api/v1/workspaces/:workspace/blockers/open-duration",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const openBlockers = db
        .prepare(
          `SELECT blocker_id, created_at, severity FROM blockers WHERE workspace_id = ? AND status = 'open'`,
        )
        .all(workspace) as { blocker_id: string; created_at: string; severity: string }[];

      const now = Date.now();
      const durations = openBlockers.map((b) => {
        const hours = (now - new Date(b.created_at).getTime()) / 3600000;
        return {
          blocker_id: b.blocker_id,
          severity: b.severity,
          open_hours: Math.round(hours * 100) / 100,
        };
      });

      durations.sort((a, b) => b.open_hours - a.open_hours);
      const hours = durations.map((d) => d.open_hours);
      const avg =
        hours.length > 0
          ? Math.round((hours.reduce((s, h) => s + h, 0) / hours.length) * 100) / 100
          : 0;
      const max = hours.length > 0 ? Math.max(...hours) : 0;

      return reply.send({
        workspace,
        open_blockers: openBlockers.length,
        avg_open_hours: avg,
        max_open_hours: Math.round(max * 100) / 100,
        longest_open: durations.slice(0, 10),
      });
    },
  );

  // F-222: Blocker response time
  app.get(
    "/api/v1/workspaces/:workspace/blockers/response-time",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const resolved = db
        .prepare(
          `SELECT created_at, resolved_at FROM blockers WHERE workspace_id = ? AND resolved_at IS NOT NULL`,
        )
        .all(workspace) as { created_at: string; resolved_at: string }[];

      const responseTimes = resolved.map((b) => {
        const created = new Date(b.created_at).getTime();
        const resolvedAt = new Date(b.resolved_at).getTime();
        return Math.round(((resolvedAt - created) / 3600000) * 100) / 100;
      });

      const total = responseTimes.length;
      const avg =
        total > 0 ? Math.round((responseTimes.reduce((s, v) => s + v, 0) / total) * 100) / 100 : 0;
      const sorted = [...responseTimes].sort((a, b) => a - b);
      const median = total > 0 ? sorted[Math.floor(total / 2)] : 0;
      const p90 = total > 0 ? sorted[Math.floor(total * 0.9)] : 0;
      const fastest = total > 0 ? sorted[0] : 0;
      const slowest = total > 0 ? sorted[total - 1] : 0;

      return reply.send({
        workspace,
        resolved_blockers: total,
        avg_response_hours: avg,
        median_response_hours: median,
        p90_response_hours: p90,
        fastest_hours: fastest,
        slowest_hours: slowest,
      });
    },
  );

  // F-227: Blocker ownership analysis
  app.get(
    "/api/v1/workspaces/:workspace/blockers/ownership",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const blockers = db
        .prepare(
          `SELECT blocker_id, agent_id, status, severity FROM blockers WHERE workspace_id = ?`,
        )
        .all(workspace) as {
        blocker_id: string;
        agent_id: string;
        status: string;
        severity: string;
      }[];

      const agentMap: Record<
        string,
        { total: number; open: number; resolved: number; severities: Record<string, number> }
      > = {};
      for (const b of blockers) {
        if (!agentMap[b.agent_id])
          agentMap[b.agent_id] = { total: 0, open: 0, resolved: 0, severities: {} };
        agentMap[b.agent_id].total++;
        if (b.status === "open") agentMap[b.agent_id].open++;
        if (b.status === "resolved") agentMap[b.agent_id].resolved++;
        agentMap[b.agent_id].severities[b.severity] =
          (agentMap[b.agent_id].severities[b.severity] || 0) + 1;
      }

      const agents = Object.entries(agentMap)
        .map(([agent_id, v]) => ({ agent_id, ...v }))
        .sort((a, b) => b.total - a.total);

      return reply.send({
        workspace,
        total_blockers: blockers.length,
        unique_owners: agents.length,
        agents,
      });
    },
  );

  // F-232: Blocker comment stats
  app.get(
    "/api/v1/workspaces/:workspace/blockers/comment-stats",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const blockers = db
        .prepare(`SELECT blocker_id FROM blockers WHERE workspace_id = ?`)
        .all(workspace) as { blocker_id: string }[];

      const blockerIds = blockers.map((b) => b.blocker_id);
      let totalComments = 0;
      const commentCounts: { blocker_id: string; count: number }[] = [];

      for (const id of blockerIds) {
        const row = db
          .prepare(`SELECT COUNT(*) as c FROM blocker_comments WHERE blocker_id = ?`)
          .get(id) as { c: number };
        totalComments += row.c;
        if (row.c > 0) commentCounts.push({ blocker_id: id, count: row.c });
      }

      commentCounts.sort((a, b) => b.count - a.count);
      const withComments = commentCounts.length;
      const avgComments =
        blockerIds.length > 0 ? Math.round((totalComments / blockerIds.length) * 100) / 100 : 0;

      return reply.send({
        workspace,
        total_blockers: blockerIds.length,
        blockers_with_comments: withComments,
        total_comments: totalComments,
        avg_comments_per_blocker: avgComments,
        most_commented: commentCounts.slice(0, 10),
      });
    },
  );

  // F-237: Blocker deadline compliance
  app.get(
    "/api/v1/workspaces/:workspace/blockers/deadline-compliance",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const blockers = db
        .prepare(
          `SELECT blocker_id, status, deadline_at, resolved_at FROM blockers WHERE workspace_id = ? AND deadline_at IS NOT NULL`,
        )
        .all(workspace) as {
        blocker_id: string;
        status: string;
        deadline_at: string;
        resolved_at: string | null;
      }[];

      let metDeadline = 0;
      let missedDeadline = 0;
      let pendingWithDeadline = 0;

      for (const b of blockers) {
        if (b.status === "resolved" && b.resolved_at) {
          if (b.resolved_at <= b.deadline_at) metDeadline++;
          else missedDeadline++;
        } else if (b.status === "open") {
          pendingWithDeadline++;
        }
      }

      const total = metDeadline + missedDeadline;
      const complianceRate = total > 0 ? Math.round((metDeadline / total) * 10000) / 100 : 100;

      return reply.send({
        workspace,
        blockers_with_deadline: blockers.length,
        met_deadline: metDeadline,
        missed_deadline: missedDeadline,
        pending_with_deadline: pendingWithDeadline,
        compliance_rate_percent: complianceRate,
      });
    },
  );

  // F-242: Blocker age distribution (histogram)
  app.get(
    "/api/v1/workspaces/:workspace/blockers/age-histogram",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const blockers = db
        .prepare(
          `SELECT blocker_id, created_at, status, resolved_at FROM blockers WHERE workspace_id = ?`,
        )
        .all(workspace) as {
        blocker_id: string;
        created_at: string;
        status: string;
        resolved_at: string | null;
      }[];

      const now = Date.now();
      const buckets = {
        "<1h": 0,
        "1-4h": 0,
        "4-12h": 0,
        "12-24h": 0,
        "1-3d": 0,
        "3-7d": 0,
        ">7d": 0,
      };

      for (const b of blockers) {
        const end = b.resolved_at ? new Date(b.resolved_at).getTime() : now;
        const hours = (end - new Date(b.created_at).getTime()) / 3600000;
        if (hours < 1) buckets["<1h"]++;
        else if (hours < 4) buckets["1-4h"]++;
        else if (hours < 12) buckets["4-12h"]++;
        else if (hours < 24) buckets["12-24h"]++;
        else if (hours < 72) buckets["1-3d"]++;
        else if (hours < 168) buckets["3-7d"]++;
        else buckets[">7d"]++;
      }

      return reply.send({
        workspace,
        total_blockers: blockers.length,
        buckets,
      });
    },
  );

  // F-247: Blocker watcher stats
  app.get(
    "/api/v1/workspaces/:workspace/blockers/watcher-stats",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const blockers = db
        .prepare(`SELECT blocker_id FROM blockers WHERE workspace_id = ?`)
        .all(workspace) as { blocker_id: string }[];

      let totalWatchers = 0;
      const watcherCounts: { blocker_id: string; count: number }[] = [];

      for (const b of blockers) {
        const row = db
          .prepare(`SELECT COUNT(*) as c FROM blocker_watchers WHERE blocker_id = ?`)
          .get(b.blocker_id) as { c: number };
        totalWatchers += row.c;
        if (row.c > 0) watcherCounts.push({ blocker_id: b.blocker_id, count: row.c });
      }

      watcherCounts.sort((a, b) => b.count - a.count);
      const withWatchers = watcherCounts.length;
      const avgWatchers =
        blockers.length > 0 ? Math.round((totalWatchers / blockers.length) * 100) / 100 : 0;

      return reply.send({
        workspace,
        total_blockers: blockers.length,
        blockers_with_watchers: withWatchers,
        total_watchers: totalWatchers,
        avg_watchers_per_blocker: avgWatchers,
        most_watched: watcherCounts.slice(0, 10),
      });
    },
  );

  // F-253: Blocker resolution speed
  app.get(
    "/api/v1/workspaces/:workspace/blockers/resolution-speed",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const resolved = db
        .prepare(
          `SELECT severity, created_at, resolved_at FROM blockers WHERE workspace_id = ? AND resolved_at IS NOT NULL`,
        )
        .all(workspace) as { severity: string; created_at: string; resolved_at: string }[];

      const bySeverity: Record<string, number[]> = {};
      for (const b of resolved) {
        const hours =
          (new Date(b.resolved_at).getTime() - new Date(b.created_at).getTime()) / 3600000;
        if (!bySeverity[b.severity]) bySeverity[b.severity] = [];
        bySeverity[b.severity].push(hours);
      }

      const severities = Object.entries(bySeverity).map(([severity, times]) => {
        const avg = Math.round((times.reduce((s, v) => s + v, 0) / times.length) * 100) / 100;
        const sorted = [...times].sort((a, b) => a - b);
        return {
          severity,
          count: times.length,
          avg_hours: avg,
          median_hours: sorted[Math.floor(sorted.length / 2)],
        };
      });

      return reply.send({ workspace, total_resolved: resolved.length, by_severity: severities });
    },
  );

  // F-258 blocker-dependency-stats
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/blockers/dependency-stats",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params;
      const blockers = db
        .prepare("SELECT blocker_id, status FROM blockers WHERE workspace_id = ?")
        .all(workspace) as { blocker_id: string; status: string }[];

      const deps = db
        .prepare(
          `SELECT bd.blocker_id, bd.depends_on_blocker_id
           FROM blocker_dependencies bd
           JOIN blockers b ON b.blocker_id = bd.blocker_id
           WHERE b.workspace_id = ?`,
        )
        .all(workspace) as { blocker_id: string; depends_on_blocker_id: string }[];

      const depCount: Record<string, number> = {};
      const dependentCount: Record<string, number> = {};
      for (const d of deps) {
        depCount[d.blocker_id] = (depCount[d.blocker_id] || 0) + 1;
        dependentCount[d.depends_on_blocker_id] =
          (dependentCount[d.depends_on_blocker_id] || 0) + 1;
      }

      const totalBlockers = blockers.length;
      const withDeps = Object.keys(depCount).length;
      const depTargets = Object.keys(dependentCount).length;
      const maxDepth = deps.length > 0 ? Math.max(...Object.values(depCount)) : 0;

      return reply.send({
        workspace,
        total_blockers: totalBlockers,
        total_dependencies: deps.length,
        blockers_with_dependencies: withDeps,
        blockers_depended_upon: depTargets,
        max_dependency_count: maxDepth,
      });
    },
  );

  // F-263 blocker-creation-rate
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/blockers/creation-rate",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params;
      const rows = db
        .prepare(
          `SELECT DATE(created_at) AS day, COUNT(*) AS cnt
           FROM blockers WHERE workspace_id = ?
           GROUP BY DATE(created_at)
           ORDER BY day DESC LIMIT 30`,
        )
        .all(workspace) as { day: string; cnt: number }[];

      const total = rows.reduce((s, r) => s + r.cnt, 0);
      const avgPerDay = rows.length > 0 ? Math.round((total / rows.length) * 100) / 100 : 0;

      return reply.send({
        workspace,
        total_blockers: total,
        days_tracked: rows.length,
        avg_per_day: avgPerDay,
        daily: rows,
      });
    },
  );

  // F-269 blocker-escalation-chain
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/blockers/escalation-chain",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params;
      const rows = db
        .prepare(
          `SELECT al.entity_id AS blocker_id, al.action, al.created_at, al.payload
           FROM audit_log al
           WHERE al.workspace_id = ? AND al.action LIKE 'blocker.escalat%'
           ORDER BY al.created_at DESC LIMIT 100`,
        )
        .all(workspace) as {
        blocker_id: string;
        action: string;
        created_at: string;
        payload: string | null;
      }[];

      const byBlocker: Record<string, { escalation_count: number; last_escalated_at: string }> = {};
      for (const r of rows) {
        if (!byBlocker[r.blocker_id])
          byBlocker[r.blocker_id] = { escalation_count: 0, last_escalated_at: r.created_at };
        byBlocker[r.blocker_id].escalation_count++;
      }

      const chains = Object.entries(byBlocker)
        .map(([blocker_id, data]) => ({ blocker_id, ...data }))
        .sort((a, b) => b.escalation_count - a.escalation_count);

      return reply.send({ workspace, total_escalations: rows.length, blockers: chains });
    },
  );

  // F-274 blocker-agent-workload
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/blockers/agent-workload",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params;
      const rows = db
        .prepare(
          `SELECT agent_id, COUNT(*) AS total,
                  SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
                  SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved_count
           FROM blockers WHERE workspace_id = ?
           GROUP BY agent_id ORDER BY total DESC`,
        )
        .all(workspace) as {
        agent_id: string;
        total: number;
        open_count: number;
        resolved_count: number;
      }[];

      return reply.send({ workspace, total_agents: rows.length, agents: rows });
    },
  );

  // F-278 blocker-unresolved-aging
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/blockers/unresolved-aging",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT blocker_id, title, severity,
                  ROUND((julianday('now') - julianday(created_at)) * 24, 1) as hours_open
           FROM blockers
           WHERE workspace_id = ? AND status != 'resolved'
           ORDER BY hours_open DESC`,
        )
        .all(req.params.workspace) as { blocker_id: string; title: string; severity: string; hours_open: number }[];
      const avg_hours = rows.length > 0 ? Math.round((rows.reduce((s, r) => s + r.hours_open, 0) / rows.length) * 10) / 10 : 0;
      reply.send({ workspace: req.params.workspace, unresolved: rows.length, avg_hours_open: avg_hours, blockers: rows });
    },
  );

};

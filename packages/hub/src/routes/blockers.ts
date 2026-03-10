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
            deadline_seconds: { type: "integer", minimum: 60, maximum: 604800 },
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
};

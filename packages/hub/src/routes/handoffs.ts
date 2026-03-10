import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/index.js";
import { writeAuditLog } from "../services/audit.js";
import { createHandoff, listHandoffs, updateHandoffStatus } from "../services/handoffs.js";
import { templateId } from "../services/ids.js";
import { parseJsonSafe } from "../utils/json.js";
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
            timeout_seconds: { type: "integer", minimum: 60, maximum: 86400 },
            max_retries: { type: "integer", minimum: 0, maximum: 10 },
            parent_handoff_id: { type: "string", minLength: 1, maxLength: 128 },
            priority: {
              type: "string",
              enum: ["low", "normal", "high", "critical"],
            },
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
        timeout_seconds?: number;
        max_retries?: number;
        parent_handoff_id?: string;
        priority?: string;
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
        timeoutSeconds: body.timeout_seconds,
        maxRetries: body.max_retries,
        parentHandoffId: body.parent_handoff_id,
      });

      if (body.priority && body.priority !== "normal") {
        db.prepare("UPDATE handoffs SET priority = ? WHERE handoff_id = ?").run(
          body.priority,
          created.id,
        );
      }

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
    {
      preHandler: app.authGuard,
    },
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

      const body = (request.body as { note?: string; agent_id?: string }) ?? {};
      if (body.note && body.agent_id) {
        db.prepare(
          "INSERT INTO handoff_notes (handoff_id, workspace_id, author_id, content) VALUES (?, ?, ?, ?)",
        ).run(handoffId, workspace, body.agent_id, body.note);
      }

      writeAuditLog({
        workspaceId: workspace,
        actorType: "agent",
        actorId: body.agent_id,
        action: "handoff.accept",
        entityType: "handoff",
        entityId: handoffId,
        requestId: request.id,
      });

      broadcast("handoffs.updated", { workspace, handoff_id: handoffId, status: "accepted" });
      return reply.send({ ok: true });
    },
  );

  app.post(
    "/api/v1/workspaces/:workspace/handoffs/:handoffId/reject",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { handoffId, workspace } = request.params as { handoffId: string; workspace: string };
      const exists = db
        .prepare("SELECT handoff_id FROM handoffs WHERE handoff_id = ? AND workspace_id = ?")
        .get(handoffId, workspace);
      if (!exists) {
        return reply.code(404).send({ error: "Handoff not found" });
      }

      const ok = updateHandoffStatus(handoffId, "rejected");
      if (!ok) {
        return reply.code(404).send({ error: "Handoff not found" });
      }

      writeAuditLog({
        workspaceId: workspace,
        actorType: "agent",
        action: "handoff.reject",
        entityType: "handoff",
        entityId: handoffId,
        requestId: request.id,
      });

      broadcast("handoffs.updated", { workspace, handoff_id: handoffId, status: "rejected" });
      return reply.send({ ok: true });
    },
  );

  /* ── F-54  handoff retry ────────────────────────────────────── */
  app.post(
    "/api/v1/workspaces/:workspace/handoffs/:handoffId/retry",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { handoffId, workspace } = request.params as { handoffId: string; workspace: string };
      const row = db
        .prepare("SELECT * FROM handoffs WHERE handoff_id = ? AND workspace_id = ?")
        .get(handoffId, workspace) as Record<string, unknown> | undefined;
      if (!row) {
        return reply.code(404).send({ error: "Handoff not found" });
      }
      if (row.status !== "rejected") {
        return reply.code(422).send({ error: "Only rejected handoffs can be retried" });
      }
      if (Number(row.retry_count) >= Number(row.max_retries)) {
        return reply.code(422).send({
          error: "Max retries exceeded",
          retry_count: row.retry_count,
          max_retries: row.max_retries,
        });
      }

      db.prepare(
        "UPDATE handoffs SET status = 'pending', retry_count = retry_count + 1, updated_at = CURRENT_TIMESTAMP WHERE handoff_id = ?",
      ).run(handoffId);

      writeAuditLog({
        workspaceId: workspace,
        actorType: "agent",
        action: "handoff.retry",
        entityType: "handoff",
        entityId: handoffId,
        requestId: request.id,
        payload: { retry_count: Number(row.retry_count) + 1 },
      });

      broadcast("handoffs.updated", { workspace, handoff_id: handoffId, status: "pending" });
      return reply.send({ ok: true, retry_count: Number(row.retry_count) + 1 });
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
            from_agent_id: { type: "string", maxLength: 128 },
            to_agent_id: { type: "string", maxLength: 128 },
            created_after: { type: "string", maxLength: 30 },
            created_before: { type: "string", maxLength: 30 },
            sort_by: { type: "string", enum: ["created_at", "updated_at"] },
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
        status?: string;
        from_agent_id?: string;
        to_agent_id?: string;
        created_after?: string;
        created_before?: string;
        sort_by?: string;
        sort_order?: string;
      };
      let data = listHandoffs(workspace).filter(
        (row) =>
          (!q.status || row.status === q.status) &&
          (!q.from_agent_id || row.from_agent_id === q.from_agent_id) &&
          (!q.to_agent_id || row.to_agent_id === q.to_agent_id),
      );
      if (q.created_after) {
        data = data.filter((r) => String(r.created_at) >= q.created_after!);
      }
      if (q.created_before) {
        data = data.filter((r) => String(r.created_at) <= q.created_before!);
      }
      if (q.sort_by) {
        const dir = q.sort_order === "asc" ? 1 : -1;
        data.sort((a, b) => {
          const av = String(a[q.sort_by!] ?? "");
          const bv = String(b[q.sort_by!] ?? "");
          return dir * av.localeCompare(bv);
        });
      }
      const start = Math.max(0, Number((request.query as Record<string, string>).offset) || 0);
      const count = Math.min(
        200,
        Math.max(1, Number((request.query as Record<string, string>).limit) || 50),
      );
      return reply.send({ data: data.slice(start, start + count), total: data.length });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/handoffs/:handoffId",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, handoffId } = request.params as {
        workspace: string;
        handoffId: string;
      };
      const row = db
        .prepare("SELECT * FROM handoffs WHERE handoff_id = ? AND workspace_id = ?")
        .get(handoffId, workspace) as Record<string, unknown> | undefined;
      if (!row) {
        return reply.code(404).send({ error: "Handoff not found" });
      }
      row.context = parseJsonSafe(String(row.context ?? ""), null);
      const timeline = db
        .prepare(
          "SELECT action, actor_type, actor_id, payload, created_at FROM audit_log WHERE entity_type = 'handoff' AND entity_id = ? ORDER BY created_at ASC",
        )
        .all(handoffId) as Array<Record<string, unknown>>;
      return reply.send({ ...row, timeline });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/handoffs/stats",
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
          "SELECT status, COUNT(*) as count FROM handoffs WHERE workspace_id = ? GROUP BY status",
        )
        .all(workspace) as Array<{ status: string; count: number }>;
      const byRouteMode = db
        .prepare(
          "SELECT route_mode, COUNT(*) as count FROM handoffs WHERE workspace_id = ? GROUP BY route_mode",
        )
        .all(workspace) as Array<{ route_mode: string; count: number }>;
      const avgAcceptTime = db
        .prepare(
          "SELECT AVG(julianday(updated_at) - julianday(created_at)) * 86400 as avg_seconds FROM handoffs WHERE workspace_id = ? AND status = 'accepted'",
        )
        .get(workspace) as { avg_seconds: number | null };

      return reply.send({
        by_status: Object.fromEntries(byStatus.map((r) => [r.status, r.count])),
        by_route_mode: Object.fromEntries(byRouteMode.map((r) => [r.route_mode, r.count])),
        avg_accept_seconds: avgAcceptTime.avg_seconds
          ? Math.round(avgAcceptTime.avg_seconds)
          : null,
      });
    },
  );

  /* ── F-68  handoff notes ────────────────────────────────────── */
  app.post(
    "/api/v1/workspaces/:workspace/handoffs/:handoffId/notes",
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
      const { workspace, handoffId } = request.params as {
        workspace: string;
        handoffId: string;
      };
      const handoff = db
        .prepare("SELECT handoff_id FROM handoffs WHERE handoff_id = ? AND workspace_id = ?")
        .get(handoffId, workspace);
      if (!handoff) {
        return reply.code(404).send({ error: "Handoff not found" });
      }
      const body = request.body as { author_id: string; content: string };
      const info = db
        .prepare(
          "INSERT INTO handoff_notes (handoff_id, workspace_id, author_id, content) VALUES (?, ?, ?, ?)",
        )
        .run(handoffId, workspace, body.author_id, body.content);
      return reply.code(201).send({ note_id: Number(info.lastInsertRowid) });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/handoffs/:handoffId/notes",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, handoffId } = request.params as {
        workspace: string;
        handoffId: string;
      };
      const handoff = db
        .prepare("SELECT handoff_id FROM handoffs WHERE handoff_id = ? AND workspace_id = ?")
        .get(handoffId, workspace);
      if (!handoff) {
        return reply.code(404).send({ error: "Handoff not found" });
      }
      const notes = db
        .prepare(
          "SELECT id, author_id, content, created_at FROM handoff_notes WHERE handoff_id = ? AND workspace_id = ? ORDER BY created_at ASC",
        )
        .all(handoffId, workspace);
      return reply.send({ data: notes });
    },
  );

  /* ── F-70  handoff chain tracking ───────────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/handoffs/:handoffId/chain",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, handoffId } = request.params as {
        workspace: string;
        handoffId: string;
      };
      const chain: Record<string, unknown>[] = [];
      let currentId: string | null = handoffId;
      const seen = new Set<string>();
      while (currentId && !seen.has(currentId)) {
        seen.add(currentId);
        const row = db
          .prepare(
            "SELECT handoff_id, from_agent_id, to_agent_id, status, summary, parent_handoff_id, created_at FROM handoffs WHERE handoff_id = ? AND workspace_id = ?",
          )
          .get(currentId, workspace) as Record<string, unknown> | undefined;
        if (!row) break;
        chain.unshift(row);
        currentId = (row.parent_handoff_id as string) ?? null;
      }
      if (chain.length === 0) {
        return reply.code(404).send({ error: "Handoff not found" });
      }
      // also get children
      const children = db
        .prepare(
          "SELECT handoff_id, from_agent_id, to_agent_id, status, summary, created_at FROM handoffs WHERE parent_handoff_id = ? AND workspace_id = ?",
        )
        .all(handoffId, workspace);
      return reply.send({ chain, children });
    },
  );

  /* ── F-91  handoff templates ────────────────────────────────── */
  app.post(
    "/api/v1/workspaces/:workspace/handoff-templates",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["name", "summary_template"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            summary_template: { type: "string", minLength: 1, maxLength: 2000 },
            default_priority: {
              type: "string",
              enum: ["low", "normal", "high", "critical"],
            },
            default_timeout_seconds: { type: "integer", minimum: 60, maximum: 86400 },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const body = request.body as {
        name: string;
        summary_template: string;
        default_priority?: string;
        default_timeout_seconds?: number;
      };
      const id = templateId();
      db.prepare(
        "INSERT INTO handoff_templates (template_id, workspace_id, name, summary_template, default_priority, default_timeout_seconds) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        workspace,
        body.name,
        body.summary_template,
        body.default_priority ?? "normal",
        body.default_timeout_seconds ?? null,
      );
      return reply.code(201).send({ template_id: id });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/handoff-templates",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const rows = db
        .prepare(
          "SELECT template_id, name, summary_template, default_priority, default_timeout_seconds, created_at FROM handoff_templates WHERE workspace_id = ? ORDER BY created_at DESC",
        )
        .all(workspace);
      return reply.send({ data: rows, total: rows.length });
    },
  );

  /* ── F-96  handoff chain analytics ──────────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/handoffs/chain-analytics",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      // Find root handoffs (no parent) and compute chain depth
      const roots = db
        .prepare(
          "SELECT handoff_id FROM handoffs WHERE workspace_id = ? AND parent_handoff_id IS NULL",
        )
        .all(workspace) as Array<{ handoff_id: string }>;

      let totalChains = 0;
      let maxDepth = 0;
      let totalDepth = 0;

      for (const root of roots) {
        totalChains++;
        let depth = 1;
        let current = root.handoff_id;
        // Walk children
        // biome-ignore lint: loop is intentional
        while (true) {
          const child = db
            .prepare(
              "SELECT handoff_id FROM handoffs WHERE parent_handoff_id = ? AND workspace_id = ? LIMIT 1",
            )
            .get(current, workspace) as { handoff_id: string } | undefined;
          if (!child) break;
          depth++;
          current = child.handoff_id;
        }
        totalDepth += depth;
        if (depth > maxDepth) maxDepth = depth;
      }

      return reply.send({
        total_chains: totalChains,
        max_depth: maxDepth,
        avg_depth: totalChains > 0 ? +(totalDepth / totalChains).toFixed(2) : 0,
      });
    },
  );

  /* ── F-103  handoff SLA breaches ────────────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/handoffs/sla-breaches",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const rows = db
        .prepare(
          "SELECT handoff_id, from_agent_id, to_agent_id, status, sla_deadline, created_at FROM handoffs WHERE workspace_id = ? AND sla_deadline IS NOT NULL AND sla_deadline < datetime('now') AND status = 'pending' ORDER BY sla_deadline ASC",
        )
        .all(workspace);
      return reply.send({ data: rows, total: (rows as unknown[]).length });
    },
  );

  /* ── F-111  handoff SLA compliance report ────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/handoffs/sla-compliance",
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
        db
          .prepare(
            "SELECT COUNT(*) as c FROM handoffs WHERE workspace_id = ? AND sla_deadline IS NOT NULL",
          )
          .get(workspace) as { c: number }
      ).c;
      const breached = (
        db
          .prepare(
            "SELECT COUNT(*) as c FROM handoffs WHERE workspace_id = ? AND sla_deadline IS NOT NULL AND ((status = 'pending' AND sla_deadline < datetime('now')) OR (status = 'accepted' AND updated_at > sla_deadline))",
          )
          .get(workspace) as { c: number }
      ).c;
      const compliant = total - breached;
      const rate = total > 0 ? Math.round((compliant / total) * 10000) / 100 : 100;
      return reply.send({ total, compliant, breached, compliance_rate: rate });
    },
  );

  /* ── F-117  handoff retry stats ─────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/handoffs/retry-stats",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const ws = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      const row = db
        .prepare(
          `SELECT COUNT(*) as total_handoffs,
                  SUM(CASE WHEN retry_count > 0 THEN 1 ELSE 0 END) as retried_handoffs,
                  SUM(retry_count) as total_retries,
                  MAX(retry_count) as max_retries
           FROM handoffs
           WHERE workspace_id = ?`,
        )
        .get(workspace) as Record<string, number>;
      return reply.send(row);
    },
  );

  /* ── F-123  handoff latency percentiles ───────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/handoffs/latency-percentiles",
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
          `SELECT (julianday(updated_at) - julianday(created_at)) * 86400 as latency_seconds
           FROM handoffs
           WHERE workspace_id = ? AND status = 'accepted'
           ORDER BY latency_seconds ASC`,
        )
        .all(workspace) as Array<{ latency_seconds: number }>;
      const n = rows.length;
      if (n === 0) {
        return reply.send({ count: 0, p50: null, p90: null, p99: null });
      }
      const p = (pct: number) => rows[Math.min(Math.floor(n * pct), n - 1)].latency_seconds;
      return reply.send({
        count: n,
        p50: Math.round(p(0.5)),
        p90: Math.round(p(0.9)),
        p99: Math.round(p(0.99)),
      });
    },
  );

  /* ── F-129  handoff throughput ──────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/handoffs/throughput",
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
          `SELECT strftime('%Y-%m-%d %H:00:00', updated_at) as hour,
                  COUNT(*) as completed
           FROM handoffs
           WHERE workspace_id = ? AND status = 'accepted'
             AND updated_at >= datetime('now', '-1 day')
           GROUP BY hour
           ORDER BY hour ASC`,
        )
        .all(workspace);
      return reply.send({ data: rows });
    },
  );

  /* ── F-135  handoff chain depth ─────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/handoffs/chain-depth",
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
          `SELECT h.handoff_id,
                  (SELECT COUNT(*) FROM handoffs c
                   WHERE c.workspace_id = h.workspace_id
                     AND c.from_agent_id = h.to_agent_id
                     AND c.created_at > h.created_at) as downstream_count
           FROM handoffs h WHERE h.workspace_id = ?`,
        )
        .all(workspace) as Array<{ handoff_id: string; downstream_count: number }>;
      const depths = rows.map((r) => r.downstream_count);
      const maxDepth = depths.length > 0 ? Math.max(...depths) : 0;
      const avgDepth =
        depths.length > 0
          ? Math.round((depths.reduce((a, b) => a + b, 0) / depths.length) * 100) / 100
          : 0;
      return reply.send({ total_handoffs: rows.length, max_depth: maxDepth, avg_depth: avgDepth });
    },
  );

  /* ── F-139  handoff rejection rate ──────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/handoffs/rejection-rate",
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
        db.prepare("SELECT COUNT(*) as c FROM handoffs WHERE workspace_id = ?").get(workspace) as {
          c: number;
        }
      ).c;
      const rejected = (
        db
          .prepare(
            "SELECT COUNT(*) as c FROM handoffs WHERE workspace_id = ? AND status IN ('rejected','failed')",
          )
          .get(workspace) as { c: number }
      ).c;
      const rate = total > 0 ? Math.round((rejected / total) * 10000) / 100 : 0;
      return reply.send({ total, rejected, rejection_rate: rate });
    },
  );

  /* ── F-146  handoff SLA countdown ─────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/handoffs/sla-countdown",
    {
      preHandler: app.authGuard,
      schema: {
        querystring: {
          type: "object",
          properties: {
            threshold_minutes: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const qs = request.query as { threshold_minutes?: number };
      const threshold = qs.threshold_minutes ?? 30;

      const rows = db
        .prepare(
          `SELECT handoff_id, from_agent_id, to_agent_id, summary, sla_deadline,
           CAST((julianday(sla_deadline) - julianday('now')) * 1440 AS INTEGER) as minutes_remaining
           FROM handoffs
           WHERE workspace_id = ? AND status = 'pending' AND sla_deadline IS NOT NULL
             AND sla_deadline > datetime('now')
             AND sla_deadline <= datetime('now', '+' || ? || ' minutes')
           ORDER BY sla_deadline ASC`,
        )
        .all(workspace, threshold) as Array<{
        handoff_id: string;
        from_agent_id: string;
        to_agent_id: string | null;
        summary: string;
        sla_deadline: string;
        minutes_remaining: number;
      }>;

      return reply.send({
        threshold_minutes: threshold,
        count: rows.length,
        data: rows,
      });
    },
  );

  /* ── F-147  handoff batch accept ─────────────── */
  app.post(
    "/api/v1/workspaces/:workspace/handoffs/batch-accept",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["handoff_ids", "agent_id"],
          properties: {
            handoff_ids: { type: "array", items: { type: "string" }, maxItems: 50 },
            agent_id: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { handoff_ids, agent_id } = request.body as {
        handoff_ids: string[];
        agent_id: string;
      };

      const results: Array<{ handoff_id: string; accepted: boolean }> = [];
      for (const hid of handoff_ids) {
        const row = db
          .prepare(
            "SELECT handoff_id, status FROM handoffs WHERE handoff_id = ? AND workspace_id = ?",
          )
          .get(hid, workspace) as { handoff_id: string; status: string } | undefined;

        if (!row || row.status !== "pending") {
          results.push({ handoff_id: hid, accepted: false });
          continue;
        }

        const ok = updateHandoffStatus(hid, "accepted");
        if (ok) {
          writeAuditLog({
            workspaceId: workspace,
            actorType: "agent",
            action: "handoff.accept",
            entityType: "handoff",
            entityId: hid,
            requestId: request.id,
            payload: { agent_id },
          });
          broadcast("handoffs.updated", {
            workspace,
            handoff_id: hid,
            status: "accepted",
          });
        }
        results.push({ handoff_id: hid, accepted: ok });
      }

      return reply.send({
        accepted: results.filter((r) => r.accepted).length,
        results,
      });
    },
  );

  /* ── F-154  handoff chain analysis ──────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/handoffs/chain/:handoff_id",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, handoff_id } = request.params as {
        workspace: string;
        handoff_id: string;
      };

      // Walk forward from this handoff: agent_id → target_agent_id, then find handoffs
      // from target_agent_id to build a chain of custody
      const chain: Array<{
        handoff_id: string;
        from_agent: string;
        to_agent: string;
        status: string;
        created_at: string;
      }> = [];

      const allHandoffs = db
        .prepare(
          `SELECT handoff_id, from_agent_id, to_agent_id, status, created_at
           FROM handoffs WHERE workspace_id = ? ORDER BY created_at ASC`,
        )
        .all(workspace) as Array<{
        handoff_id: string;
        from_agent_id: string;
        to_agent_id: string | null;
        status: string;
        created_at: string;
      }>;

      // Build adjacency map
      const byId = new Map(allHandoffs.map((h) => [h.handoff_id, h]));
      const byAgent = new Map<string, typeof allHandoffs>();
      for (const h of allHandoffs) {
        const list = byAgent.get(h.from_agent_id) ?? [];
        list.push(h);
        byAgent.set(h.from_agent_id, list);
      }

      // Start from the requested handoff and follow the chain
      const start = byId.get(handoff_id);
      if (!start) return reply.code(404).send({ error: "Handoff not found" });

      const visited = new Set<string>();
      let current = start;
      while (current && !visited.has(current.handoff_id)) {
        visited.add(current.handoff_id);
        chain.push({
          handoff_id: current.handoff_id,
          from_agent: current.from_agent_id,
          to_agent: current.to_agent_id ?? "any",
          status: current.status,
          created_at: current.created_at,
        });
        // Find the next handoff from target agent
        if (current.to_agent_id) {
          const next = byAgent
            .get(current.to_agent_id)
            ?.find((h) => h.created_at > current!.created_at && !visited.has(h.handoff_id));
          current = next ?? null!;
        } else {
          break;
        }
      }

      return reply.send({
        origin: handoff_id,
        chain_length: chain.length,
        chain,
      });
    },
  );

  /* ── F-160  handoff priority queue ──────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/handoffs/priority-queue",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { limit = "20" } = request.query as { limit?: string };
      const max = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);

      const priorityOrder: Record<string, number> = {
        critical: 0,
        high: 1,
        normal: 2,
        low: 3,
      };

      const pending = db
        .prepare(
          `SELECT handoff_id, from_agent_id, to_agent_id, summary,
             priority, created_at, expires_at,
             CASE WHEN expires_at IS NOT NULL
                  THEN CAST((julianday(expires_at) - julianday('now')) * 24 * 60 AS INTEGER)
                  ELSE NULL END as minutes_until_timeout
           FROM handoffs
           WHERE workspace_id = ? AND status = 'pending'
           ORDER BY
             CASE priority
               WHEN 'critical' THEN 0
               WHEN 'high' THEN 1
               WHEN 'normal' THEN 2
               WHEN 'low' THEN 3
               ELSE 2
             END ASC,
             created_at ASC
           LIMIT ?`,
        )
        .all(workspace, max) as Array<{
        handoff_id: string;
        from_agent_id: string;
        to_agent_id: string | null;
        summary: string;
        priority: string;
        created_at: string;
        expires_at: string | null;
        minutes_until_timeout: number | null;
      }>;

      return reply.send({
        count: pending.length,
        queue: pending,
      });
    },
  );

  /* ── F-164  handoff delegation depth warning ────────── */
  app.get(
    "/api/v1/workspaces/:workspace/handoffs/delegation-depth",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { threshold = "3" } = request.query as { threshold?: string };
      const maxDepth = Math.max(Number.parseInt(threshold, 10) || 3, 1);

      // Find handoff chains that exceed the threshold
      const handoffs = db
        .prepare(
          `SELECT handoff_id, from_agent_id, to_agent_id, status, created_at, parent_handoff_id
           FROM handoffs WHERE workspace_id = ?`,
        )
        .all(workspace) as Array<{
        handoff_id: string;
        from_agent_id: string;
        to_agent_id: string | null;
        status: string;
        created_at: string;
        parent_handoff_id: string | null;
      }>;

      // Build parent map
      const byId = new Map(handoffs.map((h) => [h.handoff_id, h]));
      const childrenOf = new Map<string, string[]>();
      for (const h of handoffs) {
        if (h.parent_handoff_id) {
          const list = childrenOf.get(h.parent_handoff_id) ?? [];
          list.push(h.handoff_id);
          childrenOf.set(h.parent_handoff_id, list);
        }
      }

      // Calculate depth for each root handoff
      const warnings: Array<{ root_handoff_id: string; depth: number; chain: string[] }> = [];

      const getDepth = (id: string, visited: Set<string>): string[] => {
        if (visited.has(id)) return [];
        visited.add(id);
        const children = childrenOf.get(id) ?? [];
        if (children.length === 0) return [id];
        let longest: string[] = [id];
        for (const cid of children) {
          const path = [id, ...getDepth(cid, visited)];
          if (path.length > longest.length) longest = path;
        }
        return longest;
      };

      // Find roots (no parent)
      const roots = handoffs.filter((h) => !h.parent_handoff_id);
      for (const root of roots) {
        const chain = getDepth(root.handoff_id, new Set());
        if (chain.length > maxDepth) {
          warnings.push({
            root_handoff_id: root.handoff_id,
            depth: chain.length,
            chain,
          });
        }
      }

      return reply.send({
        threshold: maxDepth,
        warnings_count: warnings.length,
        warnings,
      });
    },
  );

  // F-169: Handoff bottleneck agents
  app.get(
    "/api/v1/workspaces/:workspace/handoffs/bottleneck-agents",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const agents = db
        .prepare(
          `SELECT a.agent_id, a.display_name,
                  COUNT(CASE WHEN h.status = 'pending' THEN 1 END) as pending_count,
                  COUNT(CASE WHEN h.status = 'accepted' THEN 1 END) as accepted_count,
                  COUNT(CASE WHEN h.status = 'rejected' THEN 1 END) as rejected_count,
                  COUNT(h.handoff_id) as total_received
           FROM agents a
           LEFT JOIN handoffs h ON h.to_agent_id = a.agent_id AND h.workspace_id = a.workspace_id
           WHERE a.workspace_id = ?
           GROUP BY a.agent_id
           ORDER BY pending_count DESC`,
        )
        .all(workspace) as Array<{
        agent_id: string;
        display_name: string;
        pending_count: number;
        accepted_count: number;
        rejected_count: number;
        total_received: number;
      }>;

      const bottlenecks = agents.map((a) => {
        const acceptanceRate =
          a.total_received > 0
            ? Math.round((a.accepted_count / a.total_received) * 10000) / 100
            : 0;
        return {
          agent_id: a.agent_id,
          display_name: a.display_name,
          pending_count: a.pending_count,
          accepted_count: a.accepted_count,
          rejected_count: a.rejected_count,
          total_received: a.total_received,
          acceptance_rate: acceptanceRate,
          is_bottleneck: a.pending_count > 0 && acceptanceRate < 50,
        };
      });

      return reply.send({
        agent_count: bottlenecks.length,
        bottleneck_count: bottlenecks.filter((b) => b.is_bottleneck).length,
        agents: bottlenecks,
      });
    },
  );

  // F-174: Handoff velocity
  app.get(
    "/api/v1/workspaces/:workspace/handoffs/velocity",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { days = "7" } = request.query as { days?: string };
      const numDays = Math.max(Number.parseInt(days, 10) || 7, 1);

      const daily = db
        .prepare(
          `SELECT date(created_at) as day,
                  COUNT(*) as created,
                  SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as accepted,
                  SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected
           FROM handoffs
           WHERE workspace_id = ? AND created_at >= datetime('now', ?)
           GROUP BY date(created_at)
           ORDER BY day`,
        )
        .all(workspace, `-${numDays} days`) as Array<{
        day: string;
        created: number;
        accepted: number;
        rejected: number;
      }>;

      const totalCreated = daily.reduce((s, d) => s + d.created, 0);
      const totalAccepted = daily.reduce((s, d) => s + d.accepted, 0);
      const avgPerDay = daily.length > 0 ? Math.round((totalCreated / daily.length) * 10) / 10 : 0;

      return reply.send({
        period_days: numDays,
        total_created: totalCreated,
        total_accepted: totalAccepted,
        avg_per_day: avgPerDay,
        daily,
      });
    },
  );

  // F-179: Handoff escalation paths
  app.get(
    "/api/v1/workspaces/:workspace/handoffs/escalation-paths",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      // Find handoffs that were rejected and then retried (escalation pattern)
      const handoffs = db
        .prepare(
          `SELECT handoff_id, from_agent_id, to_agent_id, status, created_at, parent_handoff_id
           FROM handoffs WHERE workspace_id = ?`,
        )
        .all(workspace) as Array<{
        handoff_id: string;
        from_agent_id: string;
        to_agent_id: string | null;
        status: string;
        created_at: string;
        parent_handoff_id: string | null;
      }>;

      // Count rejected handoffs per agent pair
      const rejections: Record<string, { from: string; to: string; count: number }> = {};
      for (const h of handoffs) {
        if (h.status === "rejected" && h.to_agent_id) {
          const key = `${h.from_agent_id}->${h.to_agent_id}`;
          if (!rejections[key]) {
            rejections[key] = { from: h.from_agent_id, to: h.to_agent_id, count: 0 };
          }
          rejections[key].count++;
        }
      }

      // Find retry chains (handoffs with parent_handoff_id)
      const retryChains = handoffs.filter((h) => h.parent_handoff_id);

      const escalationPaths = Object.values(rejections)
        .filter((r) => r.count > 0)
        .sort((a, b) => b.count - a.count);

      return reply.send({
        total_handoffs: handoffs.length,
        total_rejections: handoffs.filter((h) => h.status === "rejected").length,
        retry_chains: retryChains.length,
        escalation_paths: escalationPaths,
      });
    },
  );

  // F-184: Handoff completion rate
  app.get(
    "/api/v1/workspaces/:workspace/handoffs/completion-rate",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const stats = db
        .prepare(
          `SELECT COUNT(*) as total,
                  SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as accepted,
                  SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
                  SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
           FROM handoffs WHERE workspace_id = ?`,
        )
        .get(workspace) as { total: number; accepted: number; rejected: number; pending: number };

      const byTarget = db
        .prepare(
          `SELECT to_agent_id,
                  COUNT(*) as total,
                  SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as accepted
           FROM handoffs
           WHERE workspace_id = ? AND to_agent_id IS NOT NULL
           GROUP BY to_agent_id
           ORDER BY total DESC`,
        )
        .all(workspace) as Array<{ to_agent_id: string; total: number; accepted: number }>;

      const completionRate =
        stats.total > 0 ? Math.round((stats.accepted / stats.total) * 10000) / 100 : 0;

      return reply.send({
        total: stats.total,
        accepted: stats.accepted,
        rejected: stats.rejected,
        pending: stats.pending,
        completion_rate: completionRate,
        by_target: byTarget.map((t) => ({
          agent_id: t.to_agent_id,
          total: t.total,
          accepted: t.accepted,
          rate: t.total > 0 ? Math.round((t.accepted / t.total) * 10000) / 100 : 0,
        })),
      });
    },
  );

  // F-189: Handoff SLA forecast
  app.get(
    "/api/v1/workspaces/:workspace/handoffs/sla-forecast",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const pending = db
        .prepare(
          `SELECT handoff_id, from_agent_id, to_agent_id, summary, created_at,
                  sla_deadline, expires_at,
                  ROUND((julianday(COALESCE(sla_deadline, expires_at)) - julianday('now')) * 24, 2) as hours_remaining
           FROM handoffs
           WHERE workspace_id = ? AND status = 'pending'
                 AND (sla_deadline IS NOT NULL OR expires_at IS NOT NULL)
           ORDER BY hours_remaining ASC`,
        )
        .all(workspace) as Array<{
        handoff_id: string;
        from_agent_id: string;
        to_agent_id: string | null;
        summary: string;
        created_at: string;
        sla_deadline: string | null;
        expires_at: string | null;
        hours_remaining: number;
      }>;

      const atRisk = pending.filter((p) => p.hours_remaining < 1 && p.hours_remaining > 0);
      const breached = pending.filter((p) => p.hours_remaining <= 0);

      return reply.send({
        total_pending_with_deadline: pending.length,
        at_risk: atRisk.length,
        already_breached: breached.length,
        handoffs: pending.map((p) => ({
          handoff_id: p.handoff_id,
          from_agent_id: p.from_agent_id,
          to_agent_id: p.to_agent_id,
          hours_remaining: p.hours_remaining,
          status: p.hours_remaining <= 0 ? "breached" : p.hours_remaining < 1 ? "at_risk" : "ok",
        })),
      });
    },
  );

  // F-193: Agent workload from handoffs perspective
  app.get(
    "/api/v1/workspaces/:workspace/handoffs/agent-workload",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const sent = db
        .prepare(
          `SELECT from_agent_id as agent_id, COUNT(*) as count
           FROM handoffs WHERE workspace_id = ?
           GROUP BY from_agent_id`,
        )
        .all(workspace) as { agent_id: string; count: number }[];

      const received = db
        .prepare(
          `SELECT to_agent_id as agent_id, COUNT(*) as count
           FROM handoffs WHERE workspace_id = ? AND to_agent_id IS NOT NULL
           GROUP BY to_agent_id`,
        )
        .all(workspace) as { agent_id: string; count: number }[];

      const pending = db
        .prepare(
          `SELECT to_agent_id as agent_id, COUNT(*) as count
           FROM handoffs WHERE workspace_id = ? AND status = 'pending' AND to_agent_id IS NOT NULL
           GROUP BY to_agent_id`,
        )
        .all(workspace) as { agent_id: string; count: number }[];

      const agentIds = new Set([
        ...sent.map((s) => s.agent_id),
        ...received.map((r) => r.agent_id),
      ]);
      const workload = [...agentIds].map((id) => ({
        agent_id: id,
        sent: sent.find((s) => s.agent_id === id)?.count || 0,
        received: received.find((r) => r.agent_id === id)?.count || 0,
        pending: pending.find((p) => p.agent_id === id)?.count || 0,
      }));

      workload.sort((a, b) => b.pending - a.pending);
      return reply.send({ workspace, agents: workload });
    },
  );
};

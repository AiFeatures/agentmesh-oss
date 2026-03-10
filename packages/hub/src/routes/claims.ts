import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/index.js";
import { writeAuditLog } from "../services/audit.js";
import { createClaim, listClaims, releaseClaim, renewClaim } from "../services/claims.js";
import { findConflictingPattern } from "../services/conflict.js";
import { parseJsonSafe } from "../utils/json.js";
import { broadcast } from "../ws/gateway.js";

export const claimRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/api/v1/workspaces/:workspace/claims",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["agent_id", "scope", "paths"],
          additionalProperties: false,
          properties: {
            agent_id: { type: "string", minLength: 2, maxLength: 128 },
            scope: {
              type: "string",
              minLength: 1,
              maxLength: 128,
              pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$",
            },
            paths: {
              type: "array",
              minItems: 1,
              maxItems: 512,
              items: { type: "string", minLength: 1, maxLength: 512 },
            },
            ttl_seconds: { type: "integer", minimum: 30, maximum: 86400 },
            priority: {
              type: "string",
              enum: ["low", "normal", "high", "critical"],
            },
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
        scope: string;
        paths: string[];
        ttl_seconds?: number;
        priority?: string;
        depends_on?: string[];
      };

      const workspaceExists = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!workspaceExists) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      const agentExists = db
        .prepare("SELECT agent_id FROM agents WHERE agent_id = ? AND workspace_id = ?")
        .get(body.agent_id, workspace);
      if (!agentExists) {
        return reply.code(404).send({ error: "Agent not found" });
      }

      const claim = createClaim({
        workspaceId: workspace,
        agentId: body.agent_id,
        scope: body.scope,
        paths: body.paths,
        ttlSeconds: body.ttl_seconds,
        priority: body.priority,
      });
      if (body.depends_on?.length) {
        const insertDep = db.prepare(
          "INSERT OR IGNORE INTO claim_dependencies (claim_id, depends_on_claim_id) VALUES (?, ?)",
        );
        for (const depId of body.depends_on) {
          insertDep.run(claim.id, depId);
        }
      }

      if ("conflict" in claim) {
        broadcast("claims.conflict", { workspace, ...claim.conflict, requestedBy: body.agent_id });
        return reply.code(409).send({ error: "Claim conflict", ...claim.conflict });
      }

      writeAuditLog({
        workspaceId: workspace,
        actorType: "agent",
        actorId: body.agent_id,
        action: "claim.create",
        entityType: "claim",
        entityId: claim.id,
        requestId: request.id,
        payload: body,
      });

      broadcast("claims.updated", { workspace, claim_id: claim.id, status: "active" });
      return reply.code(201).send({ claim_id: claim.id });
    },
  );

  app.post(
    "/api/v1/workspaces/:workspace/claims/batch",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["claims"],
          additionalProperties: false,
          properties: {
            claims: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: {
                type: "object",
                required: ["agent_id", "scope", "paths"],
                additionalProperties: false,
                properties: {
                  agent_id: { type: "string", minLength: 2, maxLength: 128 },
                  scope: { type: "string", minLength: 1, maxLength: 128 },
                  paths: {
                    type: "array",
                    minItems: 1,
                    maxItems: 512,
                    items: { type: "string", minLength: 1, maxLength: 512 },
                  },
                  ttl_seconds: { type: "integer", minimum: 30, maximum: 86400 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { claims } = request.body as {
        claims: Array<{
          agent_id: string;
          scope: string;
          paths: string[];
          ttl_seconds?: number;
        }>;
      };

      const wsExists = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!wsExists) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const results: Array<{ claim_id: string } | { error: string; index: number }> = [];
      for (let i = 0; i < claims.length; i++) {
        const c = claims[i];
        const result = createClaim({
          workspaceId: workspace,
          agentId: c.agent_id,
          scope: c.scope,
          paths: c.paths,
          ttlSeconds: c.ttl_seconds,
        });
        if ("conflict" in result) {
          results.push({ error: "conflict", index: i });
        } else {
          results.push({ claim_id: result.id });
        }
      }

      return reply.code(201).send({ results, total: results.length });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/claims",
    {
      preHandler: app.authGuard,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: {
              type: "string",
              enum: ["active", "released", "expired", "force_released"],
            },
            scope: { type: "string", maxLength: 128 },
            agent_id: { type: "string", maxLength: 128 },
            priority: {
              type: "string",
              enum: ["low", "normal", "high", "critical"],
            },
            created_after: { type: "string", maxLength: 30 },
            created_before: { type: "string", maxLength: 30 },
            sort_by: {
              type: "string",
              enum: ["created_at", "expires_at", "priority"],
            },
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
        scope?: string;
        agent_id?: string;
        priority?: string;
        created_after?: string;
        created_before?: string;
        sort_by?: string;
        sort_order?: string;
      };
      let all = listClaims(workspace);
      if (q.status) {
        all = all.filter((c) => c.status === q.status);
      }
      if (q.scope) {
        all = all.filter((c) => c.scope === q.scope);
      }
      if (q.agent_id) {
        all = all.filter((c) => c.agent_id === q.agent_id);
      }
      if (q.priority) {
        all = all.filter((c) => c.priority === q.priority);
      }
      if (q.created_after) {
        all = all.filter((c) => String(c.created_at) >= q.created_after!);
      }
      if (q.created_before) {
        all = all.filter((c) => String(c.created_at) <= q.created_before!);
      }
      if (q.sort_by) {
        const priorityOrder: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };
        const dir = q.sort_order === "asc" ? 1 : -1;
        all.sort((a, b) => {
          if (q.sort_by === "priority") {
            return (
              dir *
              ((priorityOrder[String(a.priority)] ?? 2) - (priorityOrder[String(b.priority)] ?? 2))
            );
          }
          const av = String(a[q.sort_by!] ?? "");
          const bv = String(b[q.sort_by!] ?? "");
          return dir * av.localeCompare(bv);
        });
      }
      const start = Math.max(0, Number(q.offset) || 0);
      const count = Math.min(200, Math.max(1, Number(q.limit) || 50));
      return reply.send({ data: all.slice(start, start + count), total: all.length });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/claims/:claimId",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, claimId } = request.params as {
        workspace: string;
        claimId: string;
      };
      const row = db
        .prepare(
          "SELECT c.*, json_group_array(cp.path_pattern) AS paths FROM claims c JOIN claim_paths cp ON cp.claim_id = c.claim_id WHERE c.claim_id = ? AND c.workspace_id = ? GROUP BY c.claim_id",
        )
        .get(claimId, workspace) as Record<string, unknown> | undefined;
      if (!row) {
        return reply.code(404).send({ error: "Claim not found" });
      }
      row.paths = parseJsonSafe(String(row.paths ?? "[]"), [] as string[]);
      const deps = db
        .prepare("SELECT depends_on_claim_id FROM claim_dependencies WHERE claim_id = ?")
        .all(claimId) as Array<{ depends_on_claim_id: string }>;
      row.depends_on = deps.map((d) => d.depends_on_claim_id);
      return reply.send(row);
    },
  );

  app.post(
    "/api/v1/workspaces/:workspace/claims/:claimId/release",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { claimId, workspace } = request.params as { claimId: string; workspace: string };
      const claim = db.prepare("SELECT workspace_id FROM claims WHERE claim_id = ?").get(claimId) as
        | { workspace_id: string }
        | undefined;
      if (!claim || claim.workspace_id !== workspace) {
        return reply.code(404).send({ error: "Active claim not found" });
      }

      const ok = releaseClaim(claimId);
      if (!ok) {
        return reply.code(404).send({ error: "Active claim not found" });
      }

      writeAuditLog({
        workspaceId: workspace,
        actorType: "agent",
        action: "claim.release",
        entityType: "claim",
        entityId: claimId,
        requestId: request.id,
      });

      broadcast("claims.updated", { workspace, claim_id: claimId, status: "released" });
      return reply.send({ ok: true });
    },
  );

  app.post(
    "/api/v1/workspaces/:workspace/claims/:claimId/renew",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            ttl_seconds: { type: "integer", minimum: 30, maximum: 86400 },
          },
        },
      },
    },
    async (request, reply) => {
      const { claimId, workspace } = request.params as { claimId: string; workspace: string };
      const claim = db.prepare("SELECT workspace_id FROM claims WHERE claim_id = ?").get(claimId) as
        | { workspace_id: string }
        | undefined;
      if (!claim || claim.workspace_id !== workspace) {
        return reply.code(404).send({ error: "Active claim not found" });
      }

      const body = request.body as { ttl_seconds?: number };
      // capture old expiry for renewal history
      const claimDetail = db
        .prepare("SELECT agent_id, expires_at FROM claims WHERE claim_id = ? AND status = 'active'")
        .get(claimId) as { agent_id: string; expires_at: string } | undefined;
      const oldExpiry = claimDetail?.expires_at;

      const ok = renewClaim(claimId, body?.ttl_seconds ?? 1800);
      if (!ok) {
        return reply.code(404).send({ error: "Active claim not found" });
      }

      // record renewal history
      if (oldExpiry && claimDetail) {
        const newExpiry = (
          db.prepare("SELECT expires_at FROM claims WHERE claim_id = ?").get(claimId) as {
            expires_at: string;
          }
        ).expires_at;
        db.prepare(
          "INSERT INTO claim_renewal_history (claim_id, workspace_id, renewed_by, old_expires_at, new_expires_at) VALUES (?, ?, ?, ?, ?)",
        ).run(claimId, workspace, claimDetail.agent_id, oldExpiry, newExpiry);
      }

      writeAuditLog({
        workspaceId: workspace,
        actorType: "agent",
        action: "claim.renew",
        entityType: "claim",
        entityId: claimId,
        requestId: request.id,
        payload: { ttl_seconds: body?.ttl_seconds ?? 1800 },
      });

      broadcast("claims.updated", { workspace, claim_id: claimId, status: "active" });
      return reply.send({ ok: true });
    },
  );

  /* ── F-51  batch claim renewal ──────────────────────────────── */
  app.post(
    "/api/v1/workspaces/:workspace/claims/batch-renew",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["claims"],
          additionalProperties: false,
          properties: {
            claims: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: {
                type: "object",
                required: ["claim_id"],
                additionalProperties: false,
                properties: {
                  claim_id: { type: "string", minLength: 1, maxLength: 128 },
                  ttl_seconds: { type: "integer", minimum: 30, maximum: 86400 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { claims } = request.body as {
        claims: Array<{ claim_id: string; ttl_seconds?: number }>;
      };

      const renewed: string[] = [];
      const notFound: string[] = [];
      for (const c of claims) {
        const claim = db
          .prepare("SELECT workspace_id FROM claims WHERE claim_id = ? AND workspace_id = ?")
          .get(c.claim_id, workspace) as { workspace_id: string } | undefined;
        if (!claim) {
          notFound.push(c.claim_id);
          continue;
        }
        if (renewClaim(c.claim_id, c.ttl_seconds ?? 1800)) {
          renewed.push(c.claim_id);
        } else {
          notFound.push(c.claim_id);
        }
      }

      if (renewed.length > 0) {
        broadcast("claims.updated", { workspace, renewed, status: "active" });
      }

      return reply.send({ renewed, not_found: notFound });
    },
  );

  app.post(
    "/api/v1/workspaces/:workspace/claims/:claimId/transfer",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["to_agent_id"],
          additionalProperties: false,
          properties: {
            to_agent_id: { type: "string", minLength: 2, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const { claimId, workspace } = request.params as { claimId: string; workspace: string };
      const { to_agent_id } = request.body as { to_agent_id: string };

      const claim = db
        .prepare(
          "SELECT * FROM claims WHERE claim_id = ? AND workspace_id = ? AND status = 'active'",
        )
        .get(claimId, workspace) as Record<string, unknown> | undefined;
      if (!claim) {
        return reply.code(404).send({ error: "Active claim not found" });
      }

      const toAgent = db
        .prepare("SELECT agent_id FROM agents WHERE agent_id = ? AND workspace_id = ?")
        .get(to_agent_id, workspace);
      if (!toAgent) {
        return reply.code(404).send({ error: "Target agent not found" });
      }

      db.prepare("UPDATE claims SET agent_id = ? WHERE claim_id = ?").run(to_agent_id, claimId);

      // record transfer history
      db.prepare(
        "INSERT INTO claim_transfer_history (claim_id, workspace_id, from_agent_id, to_agent_id) VALUES (?, ?, ?, ?)",
      ).run(claimId, workspace, String(claim.agent_id), to_agent_id);

      writeAuditLog({
        workspaceId: workspace,
        actorType: "agent",
        actorId: String(claim.agent_id),
        action: "claim.transfer",
        entityType: "claim",
        entityId: claimId,
        requestId: request.id,
        payload: { from_agent_id: claim.agent_id, to_agent_id },
      });

      broadcast("claims.updated", {
        workspace,
        claim_id: claimId,
        from_agent_id: claim.agent_id,
        to_agent_id,
      });
      return reply.send({ ok: true, from_agent_id: claim.agent_id, to_agent_id });
    },
  );

  app.post(
    "/api/v1/workspaces/:workspace/claims/batch-release",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["claim_ids"],
          additionalProperties: false,
          properties: {
            claim_ids: {
              type: "array",
              minItems: 1,
              maxItems: 100,
              items: { type: "string", minLength: 1, maxLength: 128 },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { claim_ids } = request.body as { claim_ids: string[] };

      const released: string[] = [];
      const notFound: string[] = [];
      for (const id of claim_ids) {
        const claim = db
          .prepare("SELECT workspace_id FROM claims WHERE claim_id = ? AND workspace_id = ?")
          .get(id, workspace) as { workspace_id: string } | undefined;
        if (!claim) {
          notFound.push(id);
          continue;
        }
        if (releaseClaim(id)) {
          released.push(id);
        } else {
          notFound.push(id);
        }
      }

      if (released.length > 0) {
        broadcast("claims.updated", { workspace, released, status: "released" });
      }

      return reply.send({ released, not_found: notFound });
    },
  );

  app.post(
    "/api/v1/workspaces/:workspace/claims/check-overlap",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["paths"],
          additionalProperties: false,
          properties: {
            paths: {
              type: "array",
              minItems: 1,
              maxItems: 512,
              items: { type: "string", minLength: 1, maxLength: 512 },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { paths } = request.body as { paths: string[] };

      const activePaths = db
        .prepare(
          `SELECT c.claim_id AS claimId, c.agent_id AS agentId, cp.path_pattern AS pathPattern
           FROM claims c JOIN claim_paths cp ON cp.claim_id = c.claim_id
           WHERE c.workspace_id = ? AND c.status = 'active'`,
        )
        .all(workspace) as Array<{
        claimId: string;
        agentId: string;
        pathPattern: string;
      }>;

      const conflict = findConflictingPattern(paths, activePaths);
      if (conflict) {
        return reply.send({
          overlaps: true,
          conflicting_claim_id: conflict.claimId,
          conflicting_agent_id: conflict.agentId,
          conflicting_pattern: conflict.pathPattern,
        });
      }
      return reply.send({ overlaps: false });
    },
  );

  app.post(
    "/api/v1/workspaces/:workspace/claims/gc",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const staleClaims = db
        .prepare(
          `
          SELECT c.claim_id
          FROM claims c
          JOIN agents a ON a.agent_id = c.agent_id
          WHERE c.workspace_id = ?
            AND c.status = 'active'
            AND a.status IN ('stale', 'evicted')
        `,
        )
        .all(workspace) as Array<{ claim_id: string }>;

      const released: string[] = [];
      for (const row of staleClaims) {
        if (releaseClaim(row.claim_id, true)) {
          released.push(row.claim_id);
        }
      }

      if (released.length > 0) {
        broadcast("claims.updated", { workspace, released, status: "force_released" });
      }

      return reply.send({ released_count: released.length, released_ids: released });
    },
  );

  app.post(
    "/api/v1/workspaces/:workspace/claims/force-release-all",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            agent_id: { type: "string", minLength: 1, maxLength: 128 },
            scope: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const body = (request.body ?? {}) as { agent_id?: string; scope?: string };

      const conditions = ["c.workspace_id = ?", "c.status = 'active'"];
      const params: unknown[] = [workspace];

      if (body.agent_id) {
        conditions.push("c.agent_id = ?");
        params.push(body.agent_id);
      }
      if (body.scope) {
        conditions.push("c.scope = ?");
        params.push(body.scope);
      }

      const rows = db
        .prepare(`SELECT c.claim_id FROM claims c WHERE ${conditions.join(" AND ")}`)
        .all(...params) as Array<{ claim_id: string }>;

      const released: string[] = [];
      for (const row of rows) {
        if (releaseClaim(row.claim_id, true)) {
          released.push(row.claim_id);
        }
      }

      if (released.length > 0) {
        writeAuditLog({
          workspaceId: workspace,
          actorType: "system",
          action: "claim.force_release_all",
          entityType: "claim",
          requestId: request.id,
          payload: { ...body, released_count: released.length },
        });
        broadcast("claims.updated", { workspace, released, status: "force_released" });
      }

      return reply.send({ released_count: released.length, released_ids: released });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/claims/stats",
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
          "SELECT status, COUNT(*) as count FROM claims WHERE workspace_id = ? GROUP BY status",
        )
        .all(workspace) as Array<{ status: string; count: number }>;
      const byAgent = db
        .prepare(
          "SELECT agent_id, COUNT(*) as count FROM claims WHERE workspace_id = ? AND status = 'active' GROUP BY agent_id",
        )
        .all(workspace) as Array<{ agent_id: string; count: number }>;
      const avgTtl = db
        .prepare(
          "SELECT AVG(ttl_seconds) as avg_ttl FROM claims WHERE workspace_id = ? AND status = 'active'",
        )
        .get(workspace) as { avg_ttl: number | null };
      const totalRenewals = db
        .prepare("SELECT SUM(renewal_count) as total FROM claims WHERE workspace_id = ?")
        .get(workspace) as { total: number | null };

      return reply.send({
        by_status: Object.fromEntries(byStatus.map((r) => [r.status, r.count])),
        active_by_agent: Object.fromEntries(byAgent.map((r) => [r.agent_id, r.count])),
        avg_ttl_seconds: avgTtl.avg_ttl ?? 0,
        total_renewals: totalRenewals.total ?? 0,
      });
    },
  );

  /* ── F-71  batch claim status check ─────────────────────────── */
  app.post(
    "/api/v1/workspaces/:workspace/claims/batch-status",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["claim_ids"],
          additionalProperties: false,
          properties: {
            claim_ids: {
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
      const body = request.body as { claim_ids: string[] };
      const placeholders = body.claim_ids.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT claim_id, status, agent_id, expires_at FROM claims WHERE workspace_id = ? AND claim_id IN (${placeholders})`,
        )
        .all(workspace, ...body.claim_ids) as Array<Record<string, unknown>>;
      const resultMap: Record<string, Record<string, unknown>> = {};
      for (const row of rows) {
        resultMap[row.claim_id as string] = row;
      }
      // mark missing IDs
      const results = body.claim_ids.map(
        (id) => resultMap[id] ?? { claim_id: id, status: "not_found" },
      );
      return reply.send({ data: results });
    },
  );

  /* ── F-79  claim conflict detection ─────────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/claims/detect-conflicts",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const activeClaims = db
        .prepare(
          "SELECT claim_id, agent_id, scope FROM claims WHERE workspace_id = ? AND status = 'active' ORDER BY scope",
        )
        .all(workspace) as Array<{ claim_id: string; agent_id: string; scope: string }>;

      const conflicts: Array<{
        scope: string;
        claims: Array<{ claim_id: string; agent_id: string }>;
      }> = [];
      const scopeMap = new Map<string, Array<{ claim_id: string; agent_id: string }>>();

      for (const c of activeClaims) {
        const existing = scopeMap.get(c.scope);
        if (existing) {
          existing.push({ claim_id: c.claim_id, agent_id: c.agent_id });
        } else {
          scopeMap.set(c.scope, [{ claim_id: c.claim_id, agent_id: c.agent_id }]);
        }
      }

      for (const [scope, claims] of scopeMap) {
        if (claims.length > 1) {
          conflicts.push({ scope, claims });
        }
      }
      return reply.send({ data: conflicts, total: conflicts.length });
    },
  );

  /* ── F-82  claim renewal history ────────────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/claims/:claimId/renewal-history",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, claimId } = request.params as { workspace: string; claimId: string };
      const exists = db
        .prepare("SELECT claim_id FROM claims WHERE claim_id = ? AND workspace_id = ?")
        .get(claimId, workspace);
      if (!exists) {
        return reply.code(404).send({ error: "Claim not found" });
      }
      const rows = db
        .prepare(
          "SELECT renewed_by, old_expires_at, new_expires_at, created_at FROM claim_renewal_history WHERE claim_id = ? AND workspace_id = ? ORDER BY id ASC",
        )
        .all(claimId, workspace);
      return reply.send({ data: rows });
    },
  );

  /* ── F-89  claim transfer history ───────────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/claims/:claimId/transfer-history",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, claimId } = request.params as { workspace: string; claimId: string };
      const exists = db
        .prepare("SELECT claim_id FROM claims WHERE claim_id = ? AND workspace_id = ?")
        .get(claimId, workspace);
      if (!exists) {
        return reply.code(404).send({ error: "Claim not found" });
      }
      const rows = db
        .prepare(
          "SELECT from_agent_id, to_agent_id, created_at FROM claim_transfer_history WHERE claim_id = ? AND workspace_id = ? ORDER BY id ASC",
        )
        .all(claimId, workspace);
      return reply.send({ data: rows });
    },
  );

  /* ── F-94  claim scope update + scope history ───────────────── */
  app.patch(
    "/api/v1/workspaces/:workspace/claims/:claimId/scope",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["new_scope", "changed_by"],
          additionalProperties: false,
          properties: {
            new_scope: { type: "string", minLength: 1, maxLength: 512 },
            changed_by: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace, claimId } = request.params as { workspace: string; claimId: string };
      const { new_scope, changed_by } = request.body as { new_scope: string; changed_by: string };
      const row = db
        .prepare("SELECT scope FROM claims WHERE claim_id = ? AND workspace_id = ?")
        .get(claimId, workspace) as { scope: string } | undefined;
      if (!row) {
        return reply.code(404).send({ error: "Claim not found" });
      }
      db.prepare(
        "INSERT INTO claim_scope_history (claim_id, workspace_id, old_scope, new_scope, changed_by) VALUES (?, ?, ?, ?, ?)",
      ).run(claimId, workspace, row.scope, new_scope, changed_by);
      db.prepare("UPDATE claims SET scope = ? WHERE claim_id = ?").run(new_scope, claimId);
      return reply.send({ ok: true, old_scope: row.scope, new_scope });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspace/claims/:claimId/scope-history",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace, claimId } = request.params as { workspace: string; claimId: string };
      const exists = db
        .prepare("SELECT claim_id FROM claims WHERE claim_id = ? AND workspace_id = ?")
        .get(claimId, workspace);
      if (!exists) {
        return reply.code(404).send({ error: "Claim not found" });
      }
      const rows = db
        .prepare(
          "SELECT old_scope, new_scope, changed_by, changed_at FROM claim_scope_history WHERE claim_id = ? AND workspace_id = ? ORDER BY id ASC",
        )
        .all(claimId, workspace);
      return reply.send({ data: rows });
    },
  );

  /* ── F-100  claim batch transfer ──────────────────────────── */
  app.post(
    "/api/v1/workspaces/:workspace/claims/batch-transfer",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["claim_ids", "from_agent_id", "to_agent_id"],
          additionalProperties: false,
          properties: {
            claim_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 },
            from_agent_id: { type: "string", minLength: 1, maxLength: 128 },
            to_agent_id: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { claim_ids, from_agent_id, to_agent_id } = request.body as {
        claim_ids: string[];
        from_agent_id: string;
        to_agent_id: string;
      };
      const results: Array<{ claim_id: string; transferred: boolean; reason?: string }> = [];
      for (const cid of claim_ids) {
        const row = db
          .prepare(
            "SELECT agent_id FROM claims WHERE claim_id = ? AND workspace_id = ? AND status = 'active'",
          )
          .get(cid, workspace) as { agent_id: string } | undefined;
        if (!row) {
          results.push({ claim_id: cid, transferred: false, reason: "not found or inactive" });
          continue;
        }
        if (row.agent_id !== from_agent_id) {
          results.push({ claim_id: cid, transferred: false, reason: "not owned by from_agent_id" });
          continue;
        }
        db.prepare("UPDATE claims SET agent_id = ? WHERE claim_id = ?").run(to_agent_id, cid);
        db.prepare(
          "INSERT INTO claim_transfer_history (claim_id, workspace_id, from_agent_id, to_agent_id) VALUES (?, ?, ?, ?)",
        ).run(cid, workspace, from_agent_id, to_agent_id);
        results.push({ claim_id: cid, transferred: true });
      }
      return reply.send({ results });
    },
  );

  /* ── F-106  claim audit trail ────────────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/claims/:claimId/audit",
    {
      preHandler: app.authGuard,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace, claimId } = request.params as {
        workspace: string;
        claimId: string;
      };
      const { limit, offset } = request.query as { limit: number; offset: number };
      const claim = db
        .prepare("SELECT claim_id FROM claims WHERE claim_id = ? AND workspace_id = ?")
        .get(claimId, workspace);
      if (!claim) {
        return reply.code(404).send({ error: "Claim not found" });
      }

      const rows = db
        .prepare(
          "SELECT * FROM audit_log WHERE entity_type = 'claim' AND entity_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
        )
        .all(claimId, workspace, limit, offset);
      return reply.send({ data: rows });
    },
  );

  /* ── F-110  claim expiry forecast ──────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/claims/expiry-forecast",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const qs = request.query as { minutes?: string };
      const minutes = Math.min(Math.max(Number.parseInt(qs.minutes || "30", 10) || 30, 1), 1440);
      const ws = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      const rows = db
        .prepare(
          `SELECT claim_id, agent_id, scope, expires_at,
                  ROUND((julianday(expires_at) - julianday('now')) * 86400) as seconds_remaining
           FROM claims
           WHERE workspace_id = ? AND status = 'active'
             AND expires_at <= datetime('now', '+' || ? || ' minutes')
           ORDER BY expires_at ASC`,
        )
        .all(workspace, minutes) as Array<Record<string, unknown>>;
      return reply.send({ window_minutes: minutes, count: rows.length, data: rows });
    },
  );

  /* ── F-116  claim overlap matrix ────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/claims/overlap-matrix",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const ws = db
        .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
        .get(workspace);
      if (!ws) {
        return reply.code(404).send({ error: "Workspace not found" });
      }
      const activeClaims = db
        .prepare(
          "SELECT c.claim_id, c.agent_id, c.scope FROM claims c WHERE c.workspace_id = ? AND c.status = 'active'",
        )
        .all(workspace) as Array<{ claim_id: string; agent_id: string; scope: string }>;
      const overlaps: Array<{ agent_a: string; agent_b: string; shared_scope: string }> = [];
      for (let i = 0; i < activeClaims.length; i++) {
        for (let j = i + 1; j < activeClaims.length; j++) {
          if (
            activeClaims[i].scope === activeClaims[j].scope &&
            activeClaims[i].agent_id !== activeClaims[j].agent_id
          ) {
            overlaps.push({
              agent_a: activeClaims[i].agent_id,
              agent_b: activeClaims[j].agent_id,
              shared_scope: activeClaims[i].scope,
            });
          }
        }
      }
      return reply.send({ data: overlaps, count: overlaps.length });
    },
  );

  /* ── F-122  claim renewal trends ────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/claims/renewal-trends",
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
          `SELECT claim_id, agent_id, scope, renewal_count
           FROM claims
           WHERE workspace_id = ? AND renewal_count > 0
           ORDER BY renewal_count DESC
           LIMIT 50`,
        )
        .all(workspace);
      const total =
        (
          db
            .prepare("SELECT SUM(renewal_count) as s FROM claims WHERE workspace_id = ?")
            .get(workspace) as { s: number | null }
        ).s ?? 0;
      return reply.send({ total_renewals: total, data: rows });
    },
  );
};

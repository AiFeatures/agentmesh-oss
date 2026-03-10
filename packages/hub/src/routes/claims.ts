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
    {
      preHandler: app.authGuard,
    },
    async (request, reply) => {
      const { claimId, workspace } = request.params as { claimId: string; workspace: string };
      const claim = db.prepare("SELECT workspace_id FROM claims WHERE claim_id = ?").get(claimId) as
        | { workspace_id: string }
        | undefined;
      if (!claim || claim.workspace_id !== workspace) {
        return reply.code(404).send({ error: "Active claim not found" });
      }

      const body = (request.body as { cascade?: boolean }) ?? {};

      // Check for dependents
      const dependents = db
        .prepare(
          "SELECT cd.claim_id FROM claim_dependencies cd JOIN claims c ON cd.claim_id = c.claim_id WHERE cd.depends_on_claim_id = ? AND c.status = 'active'",
        )
        .all(claimId) as Array<{ claim_id: string }>;

      if (dependents.length > 0 && !body.cascade) {
        return reply.code(409).send({
          error: "Claim has active dependents",
          dependent_claim_ids: dependents.map((d) => d.claim_id),
          hint: "Set cascade: true to release dependents too",
        });
      }

      const ok = releaseClaim(claimId);
      if (!ok) {
        return reply.code(404).send({ error: "Active claim not found" });
      }

      const cascaded: string[] = [];
      if (body.cascade && dependents.length > 0) {
        for (const dep of dependents) {
          if (releaseClaim(dep.claim_id)) {
            cascaded.push(dep.claim_id);
          }
        }
      }

      writeAuditLog({
        workspaceId: workspace,
        actorType: "agent",
        action: "claim.release",
        entityType: "claim",
        entityId: claimId,
        requestId: request.id,
        payload: cascaded.length > 0 ? { cascaded } : undefined,
      });

      broadcast("claims.updated", { workspace, claim_id: claimId, status: "released" });
      if (cascaded.length > 0) {
        broadcast("claims.updated", { workspace, released: cascaded, status: "cascade_released" });
      }
      return reply.send({ ok: true, cascaded });
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

  /* ── F-128  claim conflict history ───────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/claims/conflict-history",
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
           WHERE workspace_id = ? AND action LIKE 'claim.conflict%'
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(workspace, limit);
      return reply.send({ data: rows });
    },
  );

  /* ── F-137  claim scope frequency ──────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/claims/scope-frequency",
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
          `SELECT scope, COUNT(*) as frequency
           FROM claims WHERE workspace_id = ?
           GROUP BY scope ORDER BY frequency DESC LIMIT 50`,
        )
        .all(workspace);
      return reply.send({ data: rows });
    },
  );

  /* ── F-152  claim health / expiry forecast ─────────── */
  app.get(
    "/api/v1/workspaces/:workspace/claims/health",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const summary = db
        .prepare(
          `SELECT
             COUNT(*) as total_active,
             SUM(CASE WHEN renewal_count > 0 THEN 1 ELSE 0 END) as renewed_count,
             AVG(renewal_count) as avg_renewals,
             SUM(CASE WHEN expires_at IS NOT NULL AND datetime(expires_at) < datetime('now', '+1 hour') THEN 1 ELSE 0 END) as expiring_soon,
             SUM(CASE WHEN expires_at IS NOT NULL AND datetime(expires_at) < datetime('now') THEN 1 ELSE 0 END) as already_expired,
             AVG(CASE WHEN expires_at IS NOT NULL THEN CAST((julianday(expires_at) - julianday('now')) * 24 * 60 AS INTEGER) END) as avg_ttl_minutes
           FROM claims
           WHERE workspace_id = ? AND status = 'active'`,
        )
        .get(workspace) as {
        total_active: number;
        renewed_count: number;
        avg_renewals: number;
        expiring_soon: number;
        already_expired: number;
        avg_ttl_minutes: number | null;
      };

      const atRisk = db
        .prepare(
          `SELECT claim_id, agent_id, scope, expires_at,
             CAST((julianday(expires_at) - julianday('now')) * 24 * 60 AS INTEGER) as minutes_remaining
           FROM claims
           WHERE workspace_id = ? AND status = 'active'
             AND expires_at IS NOT NULL
             AND datetime(expires_at) < datetime('now', '+1 hour')
           ORDER BY expires_at ASC LIMIT 20`,
        )
        .all(workspace) as Array<{
        claim_id: string;
        agent_id: string;
        scope: string;
        expires_at: string;
        minutes_remaining: number;
      }>;

      return reply.send({
        ...summary,
        renewal_rate:
          summary.total_active > 0 ? +(summary.renewed_count / summary.total_active).toFixed(3) : 0,
        at_risk_claims: atRisk,
      });
    },
  );

  /* ── F-156  claim overlap detection ────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/claims/overlaps",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      // Find active claims that share the same path patterns
      const overlaps = db
        .prepare(
          `SELECT p1.path_pattern, c1.claim_id as claim_a, c1.agent_id as agent_a,
                  c2.claim_id as claim_b, c2.agent_id as agent_b
           FROM claim_paths p1
           JOIN claim_paths p2 ON p1.path_pattern = p2.path_pattern AND p1.claim_id < p2.claim_id
           JOIN claims c1 ON c1.claim_id = p1.claim_id AND c1.status = 'active'
           JOIN claims c2 ON c2.claim_id = p2.claim_id AND c2.status = 'active'
           WHERE c1.workspace_id = ? AND c2.workspace_id = ?
           ORDER BY p1.path_pattern
           LIMIT 100`,
        )
        .all(workspace, workspace) as Array<{
        path_pattern: string;
        claim_a: string;
        agent_a: string;
        claim_b: string;
        agent_b: string;
      }>;

      // Group by path
      const byPath = new Map<
        string,
        Array<{ claim_a: string; agent_a: string; claim_b: string; agent_b: string }>
      >();
      for (const o of overlaps) {
        const list = byPath.get(o.path_pattern) ?? [];
        list.push({
          claim_a: o.claim_a,
          agent_a: o.agent_a,
          claim_b: o.claim_b,
          agent_b: o.agent_b,
        });
        byPath.set(o.path_pattern, list);
      }

      const grouped = Array.from(byPath.entries()).map(([path, pairs]) => ({
        path_pattern: path,
        overlap_count: pairs.length,
        pairs,
      }));

      return reply.send({
        total_overlaps: overlaps.length,
        paths: grouped,
      });
    },
  );

  /* ── F-163  claim scope tree ────────────────────────── */
  app.get(
    "/api/v1/workspaces/:workspace/claims/scope-tree",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const claims = db
        .prepare(
          `SELECT c.claim_id, c.agent_id, c.scope, c.status, cp.path_pattern
           FROM claims c
           LEFT JOIN claim_paths cp ON cp.claim_id = c.claim_id
           WHERE c.workspace_id = ? AND c.status = 'active'
           ORDER BY cp.path_pattern ASC`,
        )
        .all(workspace) as Array<{
        claim_id: string;
        agent_id: string;
        scope: string;
        status: string;
        path_pattern: string | null;
      }>;

      // Build tree structure from paths
      const tree: Record<string, Array<{ claim_id: string; agent_id: string; scope: string }>> = {};
      for (const c of claims) {
        const path = c.path_pattern ?? "/";
        const parts = path.split("/").filter(Boolean);
        let key = "/";
        if (parts.length > 0) {
          key = `/${parts[0]}`;
        }
        if (!tree[key]) tree[key] = [];
        tree[key].push({ claim_id: c.claim_id, agent_id: c.agent_id, scope: c.scope });
      }

      const nodes = Object.entries(tree).map(([path, claimList]) => ({
        path,
        claim_count: claimList.length,
        claims: claimList,
      }));

      return reply.send({
        total_active: claims.length,
        tree: nodes,
      });
    },
  );

  // F-168: Claim contention hotspots
  app.get(
    "/api/v1/workspaces/:workspace/claims/contention",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      // Find paths that appear in multiple claims (active or expired)
      const hotspots = db
        .prepare(
          `SELECT cp.path_pattern,
                  COUNT(DISTINCT c.claim_id) as claim_count,
                  COUNT(DISTINCT c.agent_id) as agent_count,
                  SUM(CASE WHEN c.status = 'active' THEN 1 ELSE 0 END) as active_claims
           FROM claim_paths cp
           JOIN claims c ON cp.claim_id = c.claim_id
           WHERE c.workspace_id = ?
           GROUP BY cp.path_pattern
           HAVING COUNT(DISTINCT c.claim_id) > 1
           ORDER BY claim_count DESC
           LIMIT 50`,
        )
        .all(workspace) as Array<{
        path_pattern: string;
        claim_count: number;
        agent_count: number;
        active_claims: number;
      }>;

      // Also get paths with single claims for overall stats
      const totalPaths = (
        db
          .prepare(
            `SELECT COUNT(DISTINCT cp.path_pattern) as c
             FROM claim_paths cp
             JOIN claims c ON cp.claim_id = c.claim_id
             WHERE c.workspace_id = ?`,
          )
          .get(workspace) as { c: number }
      ).c;

      return reply.send({
        total_paths: totalPaths,
        contested_paths: hotspots.length,
        hotspots,
      });
    },
  );

  // F-172: Claim aging analysis
  app.get(
    "/api/v1/workspaces/:workspace/claims/aging",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const claims = db
        .prepare(
          `SELECT claim_id, agent_id, scope, status, created_at, expires_at,
                  ROUND((julianday('now') - julianday(created_at)) * 24, 1) as age_hours
           FROM claims
           WHERE workspace_id = ? AND status = 'active'
           ORDER BY created_at ASC`,
        )
        .all(workspace) as Array<{
        claim_id: string;
        agent_id: string;
        scope: string;
        status: string;
        created_at: string;
        expires_at: string;
        age_hours: number;
      }>;

      // Bucket into age ranges
      const buckets = { under_1h: 0, "1h_to_6h": 0, "6h_to_24h": 0, over_24h: 0 };
      for (const c of claims) {
        if (c.age_hours < 1) buckets.under_1h++;
        else if (c.age_hours < 6) buckets["1h_to_6h"]++;
        else if (c.age_hours < 24) buckets["6h_to_24h"]++;
        else buckets.over_24h++;
      }

      const avgAge =
        claims.length > 0
          ? Math.round((claims.reduce((s, c) => s + c.age_hours, 0) / claims.length) * 10) / 10
          : 0;

      return reply.send({
        total_active: claims.length,
        avg_age_hours: avgAge,
        distribution: buckets,
        oldest: claims.slice(0, 10).map((c) => ({
          claim_id: c.claim_id,
          agent_id: c.agent_id,
          scope: c.scope,
          age_hours: c.age_hours,
        })),
      });
    },
  );

  // F-177: Claim renewal forecast
  app.get(
    "/api/v1/workspaces/:workspace/claims/renewal-forecast",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { hours = "6" } = request.query as { hours?: string };
      const numHours = Math.max(Number.parseInt(hours, 10) || 6, 1);

      const expiringSoon = db
        .prepare(
          `SELECT claim_id, agent_id, scope, expires_at,
                  ROUND((julianday(expires_at) - julianday('now')) * 24, 2) as hours_remaining
           FROM claims
           WHERE workspace_id = ? AND status = 'active'
                 AND datetime(expires_at) <= datetime('now', ?)
                 AND datetime(expires_at) > datetime('now')
           ORDER BY expires_at ASC`,
        )
        .all(workspace, `+${numHours} hours`) as Array<{
        claim_id: string;
        agent_id: string;
        scope: string;
        expires_at: string;
        hours_remaining: number;
      }>;

      const byAgent: Record<string, number> = {};
      for (const c of expiringSoon) {
        byAgent[c.agent_id] = (byAgent[c.agent_id] ?? 0) + 1;
      }

      return reply.send({
        forecast_hours: numHours,
        expiring_count: expiringSoon.length,
        by_agent: Object.entries(byAgent).map(([agent_id, count]) => ({ agent_id, count })),
        claims: expiringSoon,
      });
    },
  );

  // F-183: Claim ownership map
  app.get(
    "/api/v1/workspaces/:workspace/claims/ownership-map",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const claims = db
        .prepare(
          `SELECT c.claim_id, c.agent_id, c.scope, cp.path_pattern
           FROM claims c
           LEFT JOIN claim_paths cp ON c.claim_id = cp.claim_id
           WHERE c.workspace_id = ? AND c.status = 'active'`,
        )
        .all(workspace) as Array<{
        claim_id: string;
        agent_id: string;
        scope: string;
        path_pattern: string | null;
      }>;

      const ownerMap: Record<
        string,
        Array<{ claim_id: string; scope: string; paths: string[] }>
      > = {};
      const claimMap: Record<
        string,
        { claim_id: string; agent_id: string; scope: string; paths: string[] }
      > = {};

      for (const c of claims) {
        if (!claimMap[c.claim_id]) {
          claimMap[c.claim_id] = {
            claim_id: c.claim_id,
            agent_id: c.agent_id,
            scope: c.scope,
            paths: [],
          };
        }
        if (c.path_pattern) {
          claimMap[c.claim_id].paths.push(c.path_pattern);
        }
      }

      for (const claim of Object.values(claimMap)) {
        if (!ownerMap[claim.agent_id]) ownerMap[claim.agent_id] = [];
        ownerMap[claim.agent_id].push({
          claim_id: claim.claim_id,
          scope: claim.scope,
          paths: claim.paths,
        });
      }

      const owners = Object.entries(ownerMap).map(([agent_id, claimList]) => ({
        agent_id,
        claim_count: claimList.length,
        total_paths: claimList.reduce((s, c) => s + c.paths.length, 0),
        claims: claimList,
      }));

      owners.sort((a, b) => b.claim_count - a.claim_count);

      return reply.send({
        total_agents: owners.length,
        total_active_claims: Object.keys(claimMap).length,
        owners,
      });
    },
  );

  // F-188: Claim transfer summary
  app.get(
    "/api/v1/workspaces/:workspace/claims/transfer-summary",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const transfers = db
        .prepare(
          `SELECT from_agent_id, to_agent_id, COUNT(*) as count
           FROM claim_transfer_history
           WHERE workspace_id = ?
           GROUP BY from_agent_id, to_agent_id
           ORDER BY count DESC`,
        )
        .all(workspace) as Array<{ from_agent_id: string; to_agent_id: string; count: number }>;

      const totalTransfers = transfers.reduce((s, t) => s + t.count, 0);

      const topSenders = db
        .prepare(
          `SELECT from_agent_id, COUNT(*) as count
           FROM claim_transfer_history WHERE workspace_id = ?
           GROUP BY from_agent_id ORDER BY count DESC LIMIT 10`,
        )
        .all(workspace) as Array<{ from_agent_id: string; count: number }>;

      const topReceivers = db
        .prepare(
          `SELECT to_agent_id, COUNT(*) as count
           FROM claim_transfer_history WHERE workspace_id = ?
           GROUP BY to_agent_id ORDER BY count DESC LIMIT 10`,
        )
        .all(workspace) as Array<{ to_agent_id: string; count: number }>;

      return reply.send({
        total_transfers: totalTransfers,
        transfer_pairs: transfers,
        top_senders: topSenders,
        top_receivers: topReceivers,
      });
    },
  );

  // F-194: Claim duration statistics
  app.get(
    "/api/v1/workspaces/:workspace/claims/duration-stats",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const released = db
        .prepare(
          `SELECT claim_id, created_at, expires_at, status
           FROM claims WHERE workspace_id = ? AND status IN ('released', 'expired')`,
        )
        .all(workspace) as {
        claim_id: string;
        created_at: string;
        expires_at: string;
        status: string;
      }[];

      const active = db
        .prepare(
          `SELECT claim_id, created_at, expires_at
           FROM claims WHERE workspace_id = ? AND status = 'active'`,
        )
        .all(workspace) as {
        claim_id: string;
        created_at: string;
        expires_at: string;
      }[];

      const durations = released.map((c) => {
        const start = new Date(c.created_at).getTime();
        const end = new Date(c.expires_at).getTime();
        return (end - start) / 3600000; // hours
      });

      const sorted = [...durations].sort((a, b) => a - b);
      const avg =
        sorted.length > 0
          ? Math.round((sorted.reduce((s, d) => s + d, 0) / sorted.length) * 100) / 100
          : 0;
      const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
      const p95 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0;

      return reply.send({
        workspace,
        completed_claims: released.length,
        active_claims: active.length,
        duration_hours: {
          avg,
          median: Math.round(median * 100) / 100,
          p95: Math.round(p95 * 100) / 100,
          min: sorted.length > 0 ? Math.round(sorted[0] * 100) / 100 : 0,
          max: sorted.length > 0 ? Math.round(sorted[sorted.length - 1] * 100) / 100 : 0,
        },
      });
    },
  );

  // F-199: Scope overlap risk analysis
  app.get(
    "/api/v1/workspaces/:workspace/claims/scope-overlap-risk",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const activeClaims = db
        .prepare(
          `SELECT c.claim_id, c.agent_id, c.scope, cp.path_pattern
           FROM claims c
           JOIN claim_paths cp ON cp.claim_id = c.claim_id
           WHERE c.workspace_id = ? AND c.status = 'active'`,
        )
        .all(workspace) as {
        claim_id: string;
        agent_id: string;
        scope: string;
        path_pattern: string;
      }[];

      // Group paths by claim
      const claimPaths: Record<string, { agent_id: string; scope: string; paths: string[] }> = {};
      for (const c of activeClaims) {
        if (!claimPaths[c.claim_id])
          claimPaths[c.claim_id] = { agent_id: c.agent_id, scope: c.scope, paths: [] };
        claimPaths[c.claim_id].paths.push(c.path_pattern);
      }

      // Find path prefix overlaps between different claims
      const claimIds = Object.keys(claimPaths);
      const overlaps: { claim_a: string; claim_b: string; overlapping_paths: string[] }[] = [];
      for (let i = 0; i < claimIds.length; i++) {
        for (let j = i + 1; j < claimIds.length; j++) {
          const a = claimPaths[claimIds[i]];
          const b = claimPaths[claimIds[j]];
          const shared = a.paths.filter((p) =>
            b.paths.some((bp) => p.startsWith(bp) || bp.startsWith(p)),
          );
          if (shared.length > 0) {
            overlaps.push({
              claim_a: claimIds[i],
              claim_b: claimIds[j],
              overlapping_paths: shared,
            });
          }
        }
      }

      // Scope frequency as risk indicator
      const scopeCount: Record<string, number> = {};
      for (const c of Object.values(claimPaths)) {
        scopeCount[c.scope] = (scopeCount[c.scope] || 0) + 1;
      }
      const hotScopes = Object.entries(scopeCount)
        .filter(([_, count]) => count > 1)
        .sort((a, b) => b[1] - a[1])
        .map(([scope, count]) => ({ scope, active_claims: count }));

      return reply.send({
        workspace,
        active_claims: claimIds.length,
        path_overlaps: overlaps.length,
        overlap_details: overlaps.slice(0, 20),
        hot_scopes: hotScopes,
        risk_level: overlaps.length > 5 ? "high" : overlaps.length > 0 ? "medium" : "low",
      });
    },
  );

  // F-204: Per-agent claim summary
  app.get(
    "/api/v1/workspaces/:workspace/claims/agent-summary",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const claims = db
        .prepare(`SELECT agent_id, status FROM claims WHERE workspace_id = ?`)
        .all(workspace) as { agent_id: string; status: string }[];

      const summary: Record<
        string,
        { active: number; released: number; expired: number; total: number }
      > = {};
      for (const c of claims) {
        if (!summary[c.agent_id])
          summary[c.agent_id] = { active: 0, released: 0, expired: 0, total: 0 };
        summary[c.agent_id].total++;
        if (c.status === "active") summary[c.agent_id].active++;
        else if (c.status === "released") summary[c.agent_id].released++;
        else if (c.status === "expired") summary[c.agent_id].expired++;
      }

      const agents = Object.entries(summary)
        .map(([agent_id, stats]) => ({ agent_id, ...stats }))
        .sort((a, b) => b.total - a.total);

      return reply.send({ workspace, total_claims: claims.length, agents });
    },
  );

  // F-208: Path frequency — most frequently claimed paths
  app.get(
    "/api/v1/workspaces/:workspace/claims/path-frequency",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { limit = "20" } = request.query as { limit?: string };
      const maxResults = Math.min(Number.parseInt(limit, 10) || 20, 100);

      const paths = db
        .prepare(
          `SELECT cp.path_pattern, COUNT(*) as claim_count
           FROM claim_paths cp
           JOIN claims c ON c.claim_id = cp.claim_id
           WHERE c.workspace_id = ?
           GROUP BY cp.path_pattern
           ORDER BY claim_count DESC
           LIMIT ?`,
        )
        .all(workspace, maxResults) as { path_pattern: string; claim_count: number }[];

      const activePaths = db
        .prepare(
          `SELECT cp.path_pattern, COUNT(*) as active_count
           FROM claim_paths cp
           JOIN claims c ON c.claim_id = cp.claim_id
           WHERE c.workspace_id = ? AND c.status = 'active'
           GROUP BY cp.path_pattern
           ORDER BY active_count DESC
           LIMIT ?`,
        )
        .all(workspace, maxResults) as { path_pattern: string; active_count: number }[];

      return reply.send({
        workspace,
        most_claimed_paths: paths,
        most_active_paths: activePaths,
      });
    },
  );

  // F-213: Claim expiry timeline
  app.get(
    "/api/v1/workspaces/:workspace/claims/expiry-timeline",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { hours = "24" } = request.query as { hours?: string };
      const totalHours = Math.min(Number.parseInt(hours, 10) || 24, 168);
      const now = Date.now();

      const active = db
        .prepare(
          `SELECT claim_id, agent_id, scope, expires_at
           FROM claims WHERE workspace_id = ? AND status = 'active' AND expires_at IS NOT NULL`,
        )
        .all(workspace) as {
        claim_id: string;
        agent_id: string;
        scope: string;
        expires_at: string;
      }[];

      const buckets: { label: string; count: number; claims: string[] }[] = [];
      const intervals = [1, 2, 4, 8, 12, 24];
      let prev = 0;
      for (const h of intervals.filter((i) => i <= totalHours)) {
        const claims = active.filter((c) => {
          const remaining = (new Date(c.expires_at).getTime() - now) / 3600000;
          return remaining > prev && remaining <= h;
        });
        buckets.push({
          label: `${prev}-${h}h`,
          count: claims.length,
          claims: claims.map((c) => c.claim_id),
        });
        prev = h;
      }

      const expiredSoon = active.filter((c) => {
        const remaining = (new Date(c.expires_at).getTime() - now) / 3600000;
        return remaining <= 1;
      });

      return reply.send({
        workspace,
        active_claims: active.length,
        expiring_within_1h: expiredSoon.length,
        buckets,
      });
    },
  );

  // F-218: Claim renewal rate
  app.get(
    "/api/v1/workspaces/:workspace/claims/renewal-rate",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const totalClaims = (
        db.prepare(`SELECT COUNT(*) as c FROM claims WHERE workspace_id = ?`).get(workspace) as {
          c: number;
        }
      ).c;

      const renewals = db
        .prepare(
          `SELECT cr.claim_id, COUNT(*) as renewal_count
           FROM claim_renewal_history cr
           JOIN claims c ON c.claim_id = cr.claim_id
           WHERE c.workspace_id = ?
           GROUP BY cr.claim_id`,
        )
        .all(workspace) as { claim_id: string; renewal_count: number }[];

      const claimsWithRenewals = renewals.length;
      const totalRenewals = renewals.reduce((s, r) => s + r.renewal_count, 0);
      const renewalRate =
        totalClaims > 0 ? Math.round((claimsWithRenewals / totalClaims) * 10000) / 100 : 0;
      const avgRenewals =
        claimsWithRenewals > 0 ? Math.round((totalRenewals / claimsWithRenewals) * 100) / 100 : 0;

      return reply.send({
        workspace,
        total_claims: totalClaims,
        claims_with_renewals: claimsWithRenewals,
        total_renewals: totalRenewals,
        renewal_rate_percent: renewalRate,
        avg_renewals_per_claim: avgRenewals,
        top_renewed: renewals.sort((a, b) => b.renewal_count - a.renewal_count).slice(0, 10),
      });
    },
  );

  // F-220: Claim churn
  app.get(
    "/api/v1/workspaces/:workspace/claims/claim-churn",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const claims = db
        .prepare(
          `SELECT claim_id, agent_id, status, created_at, expires_at FROM claims WHERE workspace_id = ?`,
        )
        .all(workspace) as {
        claim_id: string;
        agent_id: string;
        status: string;
        created_at: string;
        expires_at: string | null;
      }[];

      const active = claims.filter((c) => c.status === "active").length;
      const released = claims.filter((c) => c.status === "released").length;
      const expired = claims.filter((c) => c.status === "expired").length;
      const total = claims.length;
      const churnRate = total > 0 ? Math.round(((released + expired) / total) * 10000) / 100 : 0;

      const agentChurn: Record<string, { created: number; ended: number }> = {};
      for (const c of claims) {
        if (!agentChurn[c.agent_id]) agentChurn[c.agent_id] = { created: 0, ended: 0 };
        agentChurn[c.agent_id].created++;
        if (c.status === "released" || c.status === "expired") agentChurn[c.agent_id].ended++;
      }

      const agents = Object.entries(agentChurn)
        .map(([agent_id, v]) => ({
          agent_id,
          created: v.created,
          ended: v.ended,
          churn_percent: v.created > 0 ? Math.round((v.ended / v.created) * 10000) / 100 : 0,
        }))
        .sort((a, b) => b.churn_percent - a.churn_percent);

      return reply.send({
        workspace,
        total_claims: total,
        active,
        released,
        expired,
        churn_rate_percent: churnRate,
        agent_churn: agents.slice(0, 20),
      });
    },
  );

  // F-225: Claim ownership duration
  app.get(
    "/api/v1/workspaces/:workspace/claims/ownership-duration",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const claims = db
        .prepare(
          `SELECT claim_id, agent_id, status, created_at, expires_at FROM claims WHERE workspace_id = ?`,
        )
        .all(workspace) as {
        claim_id: string;
        agent_id: string;
        status: string;
        created_at: string;
        expires_at: string | null;
      }[];

      const now = new Date();
      const durations = claims.map((c) => {
        const created = new Date(c.created_at).getTime();
        const end =
          c.status === "active"
            ? now.getTime()
            : c.expires_at
              ? new Date(c.expires_at).getTime()
              : now.getTime();
        const hours = Math.round(((end - created) / 3600000) * 100) / 100;
        return {
          claim_id: c.claim_id,
          agent_id: c.agent_id,
          status: c.status,
          duration_hours: hours,
        };
      });

      const total = durations.length;
      const avg =
        total > 0
          ? Math.round((durations.reduce((s, d) => s + d.duration_hours, 0) / total) * 100) / 100
          : 0;
      const sorted = [...durations].sort((a, b) => b.duration_hours - a.duration_hours);

      return reply.send({
        workspace,
        total_claims: total,
        avg_duration_hours: avg,
        longest: sorted.slice(0, 10),
        shortest: sorted.slice(-10).reverse(),
      });
    },
  );

  // F-230: Claim scope distribution
  app.get(
    "/api/v1/workspaces/:workspace/claims/scope-distribution",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const claims = db
        .prepare(`SELECT scope, status FROM claims WHERE workspace_id = ?`)
        .all(workspace) as { scope: string; status: string }[];

      const scopeMap: Record<
        string,
        { total: number; active: number; released: number; expired: number }
      > = {};
      for (const c of claims) {
        if (!scopeMap[c.scope])
          scopeMap[c.scope] = { total: 0, active: 0, released: 0, expired: 0 };
        scopeMap[c.scope].total++;
        if (c.status === "active") scopeMap[c.scope].active++;
        if (c.status === "released") scopeMap[c.scope].released++;
        if (c.status === "expired") scopeMap[c.scope].expired++;
      }

      const scopes = Object.entries(scopeMap)
        .map(([scope, v]) => ({ scope, ...v }))
        .sort((a, b) => b.total - a.total);

      return reply.send({
        workspace,
        total_claims: claims.length,
        unique_scopes: scopes.length,
        scopes,
      });
    },
  );

  // F-235: Claim conflict rate
  app.get(
    "/api/v1/workspaces/:workspace/claims/conflict-rate",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const totalClaims = (
        db.prepare(`SELECT COUNT(*) as c FROM claims WHERE workspace_id = ?`).get(workspace) as {
          c: number;
        }
      ).c;

      const conflicts = db
        .prepare(
          `SELECT COUNT(*) as c FROM audit_log WHERE workspace_id = ? AND action LIKE 'claim.conflict%'`,
        )
        .get(workspace) as { c: number };

      const conflictRate =
        totalClaims > 0 ? Math.round((conflicts.c / totalClaims) * 10000) / 100 : 0;

      return reply.send({
        workspace,
        total_claims: totalClaims,
        total_conflicts: conflicts.c,
        conflict_rate_percent: conflictRate,
      });
    },
  );

  // F-240: Claim active summary
  app.get(
    "/api/v1/workspaces/:workspace/claims/active-summary",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const active = db
        .prepare(
          `SELECT claim_id, agent_id, scope, created_at, expires_at FROM claims WHERE workspace_id = ? AND status = 'active'`,
        )
        .all(workspace) as {
        claim_id: string;
        agent_id: string;
        scope: string;
        created_at: string;
        expires_at: string | null;
      }[];

      const now = Date.now();
      const claims = active.map((c) => {
        const ageHours =
          Math.round(((now - new Date(c.created_at).getTime()) / 3600000) * 100) / 100;
        const remainingHours = c.expires_at
          ? Math.round(((new Date(c.expires_at).getTime() - now) / 3600000) * 100) / 100
          : null;
        return { ...c, age_hours: ageHours, remaining_hours: remainingHours };
      });

      const byAgent: Record<string, number> = {};
      for (const c of active) {
        byAgent[c.agent_id] = (byAgent[c.agent_id] || 0) + 1;
      }

      return reply.send({
        workspace,
        active_count: active.length,
        by_agent: byAgent,
        claims: claims.slice(0, 50),
      });
    },
  );

  // F-244: Claim expiry risk
  app.get(
    "/api/v1/workspaces/:workspace/claims/expiry-risk",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const active = db
        .prepare(
          `SELECT claim_id, agent_id, scope, expires_at FROM claims WHERE workspace_id = ? AND status = 'active' AND expires_at IS NOT NULL`,
        )
        .all(workspace) as {
        claim_id: string;
        agent_id: string;
        scope: string;
        expires_at: string;
      }[];

      const now = Date.now();
      const atRisk = active
        .map((c) => {
          const remaining = (new Date(c.expires_at).getTime() - now) / 60000;
          return { ...c, remaining_minutes: Math.round(remaining * 100) / 100 };
        })
        .filter((c) => c.remaining_minutes < 60 && c.remaining_minutes > 0)
        .sort((a, b) => a.remaining_minutes - b.remaining_minutes);

      const expired = active.filter((c) => new Date(c.expires_at).getTime() < now).length;

      return reply.send({
        workspace,
        active_with_expiry: active.length,
        expiring_within_1h: atRisk.length,
        already_expired: expired,
        at_risk: atRisk.slice(0, 20),
      });
    },
  );

  // F-249: Claim transfer rate
  app.get(
    "/api/v1/workspaces/:workspace/claims/transfer-rate",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const totalClaims = (
        db.prepare(`SELECT COUNT(*) as c FROM claims WHERE workspace_id = ?`).get(workspace) as {
          c: number;
        }
      ).c;

      const transfers = db
        .prepare(`SELECT COUNT(*) as c FROM claim_transfer_history WHERE workspace_id = ?`)
        .get(workspace) as { c: number };

      const transferRate =
        totalClaims > 0 ? Math.round((transfers.c / totalClaims) * 10000) / 100 : 0;

      return reply.send({
        workspace,
        total_claims: totalClaims,
        total_transfers: transfers.c,
        transfer_rate_percent: transferRate,
      });
    },
  );

  // F-254: Claim scope popularity
  app.get(
    "/api/v1/workspaces/:workspace/claims/scope-popularity",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };

      const claims = db
        .prepare(`SELECT scope FROM claims WHERE workspace_id = ?`)
        .all(workspace) as { scope: string }[];

      const frequency: Record<string, number> = {};
      for (const c of claims) {
        frequency[c.scope] = (frequency[c.scope] || 0) + 1;
      }

      const scopes = Object.entries(frequency)
        .map(([scope, count]) => ({ scope, claim_count: count }))
        .sort((a, b) => b.claim_count - a.claim_count);

      return reply.send({
        workspace,
        total_claims: claims.length,
        unique_scopes: scopes.length,
        most_popular: scopes.slice(0, 20),
        least_popular: scopes.slice(-10).reverse(),
      });
    },
  );

  // F-260 claim-path-coverage
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/path-coverage",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params;
      const rows = db
        .prepare(
          `SELECT cp.path_pattern, c.status, COUNT(*) AS cnt
           FROM claim_paths cp
           JOIN claims c ON c.claim_id = cp.claim_id
           WHERE c.workspace_id = ?
           GROUP BY cp.path_pattern, c.status`,
        )
        .all(workspace) as { path_pattern: string; status: string; cnt: number }[];

      const paths: Record<string, { total: number; by_status: Record<string, number> }> = {};
      for (const r of rows) {
        if (!paths[r.path_pattern]) paths[r.path_pattern] = { total: 0, by_status: {} };
        paths[r.path_pattern].total += r.cnt;
        paths[r.path_pattern].by_status[r.status] = r.cnt;
      }

      const sorted = Object.entries(paths)
        .map(([pattern, data]) => ({ pattern, ...data }))
        .sort((a, b) => b.total - a.total);

      return reply.send({
        workspace,
        total_paths: sorted.length,
        paths: sorted.slice(0, 50),
      });
    },
  );

  // F-264 claim-agent-overlap
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/agent-overlap",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params;
      const rows = db
        .prepare(
          `SELECT c1.agent_id AS agent_a, c2.agent_id AS agent_b, COUNT(*) AS shared_scopes
           FROM claims c1
           JOIN claims c2 ON c1.scope = c2.scope AND c1.workspace_id = c2.workspace_id AND c1.agent_id < c2.agent_id
           WHERE c1.workspace_id = ? AND c1.status = 'active' AND c2.status = 'active'
           GROUP BY c1.agent_id, c2.agent_id
           ORDER BY shared_scopes DESC
           LIMIT 50`,
        )
        .all(workspace) as { agent_a: string; agent_b: string; shared_scopes: number }[];

      return reply.send({
        workspace,
        total_overlapping_pairs: rows.length,
        pairs: rows,
      });
    },
  );

  // F-268 claim-expiry-countdown
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/expiry-countdown",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params;
      const rows = db
        .prepare(
          `SELECT claim_id, agent_id, scope, expires_at
           FROM claims WHERE workspace_id = ? AND status = 'active' AND expires_at IS NOT NULL
           ORDER BY expires_at ASC LIMIT 50`,
        )
        .all(workspace) as {
        claim_id: string;
        agent_id: string;
        scope: string;
        expires_at: string;
      }[];

      const now = Date.now();
      const result = rows.map((r) => {
        const remainingMs = new Date(r.expires_at).getTime() - now;
        return {
          claim_id: r.claim_id,
          agent_id: r.agent_id,
          scope: r.scope,
          expires_at: r.expires_at,
          remaining_seconds: Math.max(0, Math.round(remainingMs / 1000)),
          expired: remainingMs <= 0,
        };
      });

      return reply.send({
        workspace,
        total_expiring: result.length,
        already_expired: result.filter((r) => r.expired).length,
        claims: result,
      });
    },
  );

  // F-273 claim-renewal-heatmap
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/renewal-heatmap",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params;
      const rows = db
        .prepare(
          `SELECT DATE(rh.created_at) AS day, COUNT(*) AS renewals
           FROM claim_renewal_history rh
           JOIN claims c ON c.claim_id = rh.claim_id
           WHERE c.workspace_id = ?
           GROUP BY DATE(rh.created_at)
           ORDER BY day DESC LIMIT 30`,
        )
        .all(workspace) as { day: string; renewals: number }[];

      const total = rows.reduce((s, r) => s + r.renewals, 0);
      return reply.send({ workspace, total_renewals: total, daily: rows });
    },
  );

  // F-276 claim-status-summary
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/status-summary",
    { preHandler: app.authGuard },
    async (request, reply) => {
      const { workspace } = request.params;
      const rows = db
        .prepare(
          "SELECT status, COUNT(*) AS cnt FROM claims WHERE workspace_id = ? GROUP BY status",
        )
        .all(workspace) as { status: string; cnt: number }[];

      const total = rows.reduce((s, r) => s + r.cnt, 0);
      const byStatus: Record<string, number> = {};
      for (const r of rows) byStatus[r.status] = r.cnt;

      return reply.send({ workspace, total_claims: total, by_status: byStatus });
    },
  );

  // F-280 claim-contention-hotspots
  app.get<{ Params: { workspace: string }; Querystring: { limit?: number } }>(
    "/api/v1/workspaces/:workspace/claims/contention-hotspots",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const limit = req.query.limit ?? 10;
      const rows = db
        .prepare(
          `SELECT scope, COUNT(*) as claim_count, COUNT(DISTINCT agent_id) as agent_count
           FROM claims
           WHERE workspace_id = ?
           GROUP BY scope
           HAVING claim_count > 1
           ORDER BY claim_count DESC
           LIMIT ?`,
        )
        .all(req.params.workspace, limit) as {
        scope: string;
        claim_count: number;
        agent_count: number;
      }[];
      reply.send({ workspace: req.params.workspace, hotspots: rows });
    },
  );

  // F-288 claim-abandonment-rate
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/abandonment-rate",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const total = (
        db
          .prepare("SELECT COUNT(*) as c FROM claims WHERE workspace_id = ?")
          .get(req.params.workspace) as { c: number }
      ).c;
      const released = (
        db
          .prepare(
            "SELECT COUNT(*) as c FROM claims WHERE workspace_id = ? AND status = 'released'",
          )
          .get(req.params.workspace) as { c: number }
      ).c;
      const expired = (
        db
          .prepare("SELECT COUNT(*) as c FROM claims WHERE workspace_id = ? AND status = 'expired'")
          .get(req.params.workspace) as { c: number }
      ).c;
      const abandoned = released + expired;
      const rate = total > 0 ? Math.round((abandoned / total) * 10000) / 100 : 0;
      reply.send({
        workspace: req.params.workspace,
        total,
        released,
        expired,
        abandoned,
        abandonment_rate: rate,
      });
    },
  );

  // F-292 claim-scope-density
  app.get<{ Params: { workspace: string }; Querystring: { limit?: number } }>(
    "/api/v1/workspaces/:workspace/claims/scope-density",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const limit = req.query.limit ?? 20;
      const rows = db
        .prepare(
          `SELECT scope, COUNT(*) as claim_count,
                  SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_count
           FROM claims
           WHERE workspace_id = ?
           GROUP BY scope
           ORDER BY claim_count DESC
           LIMIT ?`,
        )
        .all(req.params.workspace, limit) as {
        scope: string;
        claim_count: number;
        active_count: number;
      }[];
      reply.send({ workspace: req.params.workspace, scopes: rows });
    },
  );

  // F-297 priority-histogram
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/priority-histogram",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT priority, status, COUNT(*) as count
           FROM claims
           WHERE workspace_id = ?
           GROUP BY priority, status
           ORDER BY priority DESC, count DESC`,
        )
        .all(req.params.workspace) as {
        priority: number | null;
        status: string;
        count: number;
      }[];
      reply.send({ workspace: req.params.workspace, buckets: rows });
    },
  );

  // F-301 renewal-streak
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/renewal-streak",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT c.agent_id, COUNT(rh.id) as renewals,
                  MAX(rh.new_expires_at) as latest_renewal
           FROM claims c
           JOIN claim_renewal_history rh ON rh.claim_id = c.claim_id
           WHERE c.workspace_id = ?
           GROUP BY c.agent_id
           ORDER BY renewals DESC
           LIMIT 20`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        renewals: number;
        latest_renewal: string | null;
      }[];
      reply.send({ workspace: req.params.workspace, streaks: rows });
    },
  );

  // F-305 scope-length-stats
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/scope-length-stats",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const row = db
        .prepare(
          `SELECT COUNT(*) as total,
                  AVG(LENGTH(scope)) as avg_length,
                  MIN(LENGTH(scope)) as min_length,
                  MAX(LENGTH(scope)) as max_length
           FROM claims
           WHERE workspace_id = ?`,
        )
        .get(req.params.workspace) as {
        total: number;
        avg_length: number | null;
        min_length: number | null;
        max_length: number | null;
      };
      reply.send({ workspace: req.params.workspace, ...row });
    },
  );

  // F-309 expiry-velocity
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/expiry-velocity",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT DATE(expires_at) as expiry_date, COUNT(*) as count
           FROM claims
           WHERE workspace_id = ? AND expires_at IS NOT NULL
           GROUP BY DATE(expires_at)
           ORDER BY expiry_date DESC
           LIMIT 30`,
        )
        .all(req.params.workspace) as {
        expiry_date: string;
        count: number;
      }[];
      const totalExpiring = rows.reduce((s, r) => s + r.count, 0);
      const avgPerDay = rows.length > 0 ? totalExpiring / rows.length : 0;
      reply.send({
        workspace: req.params.workspace,
        daily: rows,
        total_expiring: totalExpiring,
        avg_per_day: avgPerDay,
      });
    },
  );

  // F-314 agent-diversity
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/agent-diversity",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT agent_id, COUNT(*) as claim_count
           FROM claims
           WHERE workspace_id = ?
           GROUP BY agent_id
           ORDER BY claim_count DESC`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        claim_count: number;
      }[];
      const totalClaims = rows.reduce((s, r) => s + r.claim_count, 0);
      const uniqueAgents = rows.length;
      reply.send({
        workspace: req.params.workspace,
        agents: rows,
        unique_agents: uniqueAgents,
        total_claims: totalClaims,
        diversity_ratio: totalClaims > 0 ? uniqueAgents / totalClaims : 0,
      });
    },
  );

  // F-318 transfer-velocity
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/transfer-velocity",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT DATE(created_at) as transfer_date, COUNT(*) as count
           FROM claim_transfer_history
           WHERE workspace_id = ?
           GROUP BY DATE(created_at)
           ORDER BY transfer_date DESC
           LIMIT 30`,
        )
        .all(req.params.workspace) as {
        transfer_date: string;
        count: number;
      }[];
      const total = rows.reduce((s, r) => s + r.count, 0);
      const avgPerDay = rows.length > 0 ? total / rows.length : 0;
      reply.send({
        workspace: req.params.workspace,
        daily: rows,
        total_transfers: total,
        avg_per_day: avgPerDay,
      });
    },
  );

  // F-323 scope-prefix-tree
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/scope-prefix-tree",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare("SELECT scope FROM claims WHERE workspace_id = ?")
        .all(req.params.workspace) as { scope: string }[];
      const prefixes: Record<string, number> = {};
      for (const r of rows) {
        const parts = r.scope.split(".");
        let prefix = "";
        for (const p of parts) {
          prefix = prefix ? `${prefix}.${p}` : p;
          prefixes[prefix] = (prefixes[prefix] || 0) + 1;
        }
      }
      const tree = Object.entries(prefixes)
        .map(([prefix, count]) => ({ prefix, count, depth: prefix.split(".").length }))
        .sort((a, b) => b.count - a.count);
      reply.send({ workspace: req.params.workspace, prefixes: tree });
    },
  );

  // F-329 overlapping-scopes
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/overlapping-scopes",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT c1.claim_id AS claim_a, c2.claim_id AS claim_b,
                  c1.scope AS scope_a, c2.scope AS scope_b
           FROM claims c1
           JOIN claims c2 ON c1.workspace_id = c2.workspace_id
             AND c1.claim_id < c2.claim_id
             AND c1.scope = c2.scope
           WHERE c1.workspace_id = ? AND c1.status = 'active' AND c2.status = 'active'
           LIMIT 50`,
        )
        .all(req.params.workspace) as {
        claim_a: string;
        claim_b: string;
        scope_a: string;
        scope_b: string;
      }[];
      reply.send({ workspace: req.params.workspace, overlaps: rows });
    },
  );

  // F-334 usage-heatmap
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/usage-heatmap",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour,
                  COUNT(*) AS count
           FROM claims
           WHERE workspace_id = ?
           GROUP BY hour
           ORDER BY hour`,
        )
        .all(req.params.workspace) as { hour: number; count: number }[];
      reply.send({ workspace: req.params.workspace, heatmap: rows });
    },
  );

  // F-338 longest-active
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/longest-active",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT claim_id, agent_id, scope, created_at,
                  CAST((julianday('now') - julianday(created_at)) * 86400 AS INTEGER) AS active_seconds
           FROM claims
           WHERE workspace_id = ? AND status = 'active'
           ORDER BY created_at ASC
           LIMIT 20`,
        )
        .all(req.params.workspace) as {
        claim_id: string;
        agent_id: string;
        scope: string;
        created_at: string;
        active_seconds: number;
      }[];
      reply.send({ workspace: req.params.workspace, claims: rows });
    },
  );

  // F-343 renewal-frequency
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/renewal-frequency",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT crh.claim_id, c.scope, c.agent_id, COUNT(*) AS renewal_count
           FROM claim_renewal_history crh
           JOIN claims c ON c.claim_id = crh.claim_id
           WHERE c.workspace_id = ?
           GROUP BY crh.claim_id
           ORDER BY renewal_count DESC
           LIMIT 20`,
        )
        .all(req.params.workspace) as {
        claim_id: string;
        scope: string;
        agent_id: string;
        renewal_count: number;
      }[];
      reply.send({ workspace: req.params.workspace, claims: rows });
    },
  );

  // F-348 scope-collision-risk
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/scope-collision-risk",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT c1.claim_id AS claim_a, c2.claim_id AS claim_b,
                  c1.scope AS scope_a, c2.scope AS scope_b,
                  c1.agent_id AS agent_a, c2.agent_id AS agent_b
           FROM claims c1
           JOIN claims c2 ON c1.workspace_id = c2.workspace_id
             AND c1.claim_id < c2.claim_id
             AND c1.agent_id != c2.agent_id
             AND (c1.scope LIKE c2.scope || '%' OR c2.scope LIKE c1.scope || '%')
           WHERE c1.workspace_id = ? AND c1.status = 'active' AND c2.status = 'active'
           LIMIT 30`,
        )
        .all(req.params.workspace) as {
        claim_a: string;
        claim_b: string;
        scope_a: string;
        scope_b: string;
        agent_a: string;
        agent_b: string;
      }[];
      reply.send({ workspace: req.params.workspace, risks: rows });
    },
  );

  // F-354 agent-claim-count-ranking
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/agent-claim-count-ranking",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT c.agent_id, a.display_name, COUNT(*) AS active_claims
           FROM claims c
           JOIN agents a ON a.agent_id = c.agent_id AND a.workspace_id = c.workspace_id
           WHERE c.workspace_id = ? AND c.status = 'active'
           GROUP BY c.agent_id
           ORDER BY active_claims DESC
           LIMIT 20`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        active_claims: number;
      }[];
      reply.send({ workspace: req.params.workspace, ranking: rows });
    },
  );

  // F-359 expiry-distribution
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/expiry-distribution",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT
            CASE
              WHEN expires_at IS NULL THEN 'no_expiry'
              WHEN julianday(expires_at) <= julianday('now') THEN 'expired'
              WHEN julianday(expires_at) - julianday('now') < 1 THEN 'under_24h'
              WHEN julianday(expires_at) - julianday('now') < 7 THEN '1d_to_7d'
              ELSE 'over_7d'
            END AS bucket,
            COUNT(*) AS count
           FROM claims
           WHERE workspace_id = ? AND status = 'active'
           GROUP BY bucket
           ORDER BY count DESC`,
        )
        .all(req.params.workspace) as { bucket: string; count: number }[];
      reply.send({ workspace: req.params.workspace, distribution: rows });
    },
  );

  // F-363 claim-status-transition-counts
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/status-transition-counts",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT status, COUNT(*) AS count
           FROM claims
           WHERE workspace_id = ?
           GROUP BY status
           ORDER BY count DESC`,
        )
        .all(req.params.workspace) as { status: string; count: number }[];
      reply.send({ workspace: req.params.workspace, transitions: rows });
    },
  );

  // F-369 claim-active-per-agent
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/active-per-agent",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT c.agent_id, a.display_name, COUNT(*) AS active_claims
           FROM claims c
           LEFT JOIN agents a ON a.agent_id = c.agent_id
           WHERE c.workspace_id = ? AND c.status = 'active'
           GROUP BY c.agent_id
           ORDER BY active_claims DESC`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string | null;
        active_claims: number;
      }[];
      reply.send({ workspace: req.params.workspace, agents: rows });
    },
  );

  // F-375 claim-path-depth-stats
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/path-depth-stats",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT cp.path_pattern,
                  LENGTH(cp.path_pattern) - LENGTH(REPLACE(cp.path_pattern, '/', '')) AS depth
           FROM claim_paths cp
           JOIN claims c ON c.claim_id = cp.claim_id
           WHERE c.workspace_id = ?
           ORDER BY depth DESC
           LIMIT 50`,
        )
        .all(req.params.workspace) as { path_pattern: string; depth: number }[];
      const avg_depth = rows.length > 0 ? rows.reduce((s, r) => s + r.depth, 0) / rows.length : 0;
      reply.send({
        workspace: req.params.workspace,
        paths: rows,
        avg_depth: Math.round(avg_depth * 100) / 100,
      });
    },
  );

  // F-380 claim-renewal-success-rate
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/renewal-success-rate",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS total_renewals,
                  SUM(CASE WHEN new_expires_at > old_expires_at THEN 1 ELSE 0 END) AS successful
           FROM claim_renewal_history crh
           JOIN claims c ON c.claim_id = crh.claim_id
           WHERE c.workspace_id = ?`,
        )
        .get(req.params.workspace) as { total_renewals: number; successful: number };
      const rate = row.total_renewals > 0 ? row.successful / row.total_renewals : 0;
      reply.send({
        workspace: req.params.workspace,
        ...row,
        success_rate: Math.round(rate * 10000) / 100,
      });
    },
  );

  // F-384 claim-created-daily
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/created-daily",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT DATE(created_at) AS day, COUNT(*) AS count
           FROM claims
           WHERE workspace_id = ?
           GROUP BY DATE(created_at)
           ORDER BY day DESC
           LIMIT 30`,
        )
        .all(req.params.workspace) as { day: string; count: number }[];
      reply.send({ workspace: req.params.workspace, days: rows });
    },
  );

  // F-390 claim-scope-prefix-stats
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/scope-prefix-stats",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT CASE
                    WHEN INSTR(scope, '.') > 0 THEN SUBSTR(scope, 1, INSTR(scope, '.') - 1)
                    ELSE scope
                  END AS prefix,
                  COUNT(*) AS count
           FROM claims
           WHERE workspace_id = ?
           GROUP BY prefix
           ORDER BY count DESC
           LIMIT 20`,
        )
        .all(req.params.workspace) as { prefix: string; count: number }[];
      reply.send({ workspace: req.params.workspace, prefixes: rows });
    },
  );

  // F-394 expiry-window-stats
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/expiry-window-stats",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT
            CASE
              WHEN julianday(expires_at) - julianday('now') < 0 THEN 'expired'
              WHEN julianday(expires_at) - julianday('now') < 0.041667 THEN 'under_1h'
              WHEN julianday(expires_at) - julianday('now') < 0.25 THEN '1h_to_6h'
              WHEN julianday(expires_at) - julianday('now') < 1 THEN '6h_to_24h'
              ELSE 'over_24h'
            END AS window,
            COUNT(*) AS count
           FROM claims
           WHERE workspace_id = ? AND status = 'active' AND expires_at IS NOT NULL
           GROUP BY window
           ORDER BY count DESC`,
        )
        .all(req.params.workspace) as { window: string; count: number }[];
      reply.send({ workspace: req.params.workspace, windows: rows });
    },
  );

  // F-400 path-pattern-frequency
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/path-pattern-frequency",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT cp.path_pattern, COUNT(*) AS count
           FROM claim_paths cp
           JOIN claims c ON c.claim_id = cp.claim_id
           WHERE c.workspace_id = ?
           GROUP BY cp.path_pattern
           ORDER BY count DESC
           LIMIT 20`,
        )
        .all(req.params.workspace) as {
        path_pattern: string;
        count: number;
      }[];
      reply.send({ workspace: req.params.workspace, patterns: rows });
    },
  );

  // F-405 age-distribution
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/age-distribution",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT
             CASE
               WHEN (strftime('%s','now') - strftime('%s', created_at)) < 3600 THEN '<1h'
               WHEN (strftime('%s','now') - strftime('%s', created_at)) < 86400 THEN '1h-1d'
               WHEN (strftime('%s','now') - strftime('%s', created_at)) < 604800 THEN '1d-7d'
               ELSE '>7d'
             END AS bucket,
             COUNT(*) AS count
           FROM claims
           WHERE workspace_id = ?
           GROUP BY bucket
           ORDER BY count DESC`,
        )
        .all(req.params.workspace) as { bucket: string; count: number }[];
      reply.send({ workspace: req.params.workspace, distribution: rows });
    },
  );

  // F-410 transfer-leaderboard
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/transfer-leaderboard",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT from_agent_id AS agent_id, COUNT(*) AS transfer_count
           FROM claim_transfer_history
           WHERE workspace_id = ?
           GROUP BY from_agent_id
           ORDER BY transfer_count DESC
           LIMIT 20`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        transfer_count: number;
      }[];
      reply.send({ workspace: req.params.workspace, leaderboard: rows });
    },
  );

  // F-415 renewal-gap-analysis
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/renewal-gap-analysis",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT crh.claim_id,
                  COUNT(*) AS renewal_count,
                  CAST(AVG(strftime('%s', crh.new_expires_at) - strftime('%s', crh.old_expires_at)) AS INTEGER) AS avg_extension_seconds,
                  CAST(MIN(strftime('%s', crh.new_expires_at) - strftime('%s', crh.old_expires_at)) AS INTEGER) AS min_extension_seconds,
                  CAST(MAX(strftime('%s', crh.new_expires_at) - strftime('%s', crh.old_expires_at)) AS INTEGER) AS max_extension_seconds
           FROM claim_renewal_history crh
           JOIN claims c ON c.claim_id = crh.claim_id
           WHERE c.workspace_id = ?
           GROUP BY crh.claim_id
           ORDER BY renewal_count DESC
           LIMIT 20`,
        )
        .all(req.params.workspace) as {
        claim_id: string;
        renewal_count: number;
        avg_extension_seconds: number;
        min_extension_seconds: number;
        max_extension_seconds: number;
      }[];
      reply.send({ workspace: req.params.workspace, claims: rows });
    },
  );

  // F-421 claim-density-by-agent
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/claim-density-by-agent",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT c.agent_id, a.display_name, COUNT(*) AS claim_count
           FROM claims c
           JOIN agents a ON a.agent_id = c.agent_id AND a.workspace_id = c.workspace_id
           WHERE c.workspace_id = ? AND c.status = 'active'
           GROUP BY c.agent_id
           ORDER BY claim_count DESC
           LIMIT 20`,
        )
        .all(req.params.workspace) as {
        agent_id: string;
        display_name: string;
        claim_count: number;
      }[];
      reply.send({ workspace: req.params.workspace, agents: rows });
    },
  );

  // F-429 claim-expiry-horizon
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/claim-expiry-horizon",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT claim_id, scope, agent_id,
                  ROUND((julianday(expires_at) - julianday('now')) * 24, 2) AS hours_until_expiry
           FROM claims
           WHERE workspace_id = ? AND status = 'active' AND expires_at IS NOT NULL
           ORDER BY expires_at ASC
           LIMIT 20`,
        )
        .all(req.params.workspace) as {
        claim_id: string;
        scope: string;
        agent_id: string;
        hours_until_expiry: number;
      }[];
      reply.send({ workspace: req.params.workspace, claims: rows });
    },
  );

  // F-434 claim-renewal-frequency
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/claim-renewal-frequency",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT c.claim_id, c.scope, c.agent_id, COUNT(r.id) AS renewal_count
           FROM claims c
           LEFT JOIN claim_renewal_history r ON r.claim_id = c.claim_id
           WHERE c.workspace_id = ?
           GROUP BY c.claim_id
           ORDER BY renewal_count DESC
           LIMIT 20`,
        )
        .all(req.params.workspace) as {
        claim_id: string;
        scope: string;
        agent_id: string;
        renewal_count: number;
      }[];
      reply.send({ workspace: req.params.workspace, claims: rows });
    },
  );

  // F-438 claim-transfer-volume
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/claim-transfer-volume",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT from_agent_id, to_agent_id, COUNT(*) AS transfer_count
           FROM claim_transfer_history
           WHERE workspace_id = ?
           GROUP BY from_agent_id, to_agent_id
           ORDER BY transfer_count DESC
           LIMIT 20`,
        )
        .all(req.params.workspace) as {
        from_agent_id: string;
        to_agent_id: string;
        transfer_count: number;
      }[];
      reply.send({ workspace: req.params.workspace, transfers: rows });
    },
  );

  // F-442 claim-scope-collision
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/claim-scope-collision",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT scope, COUNT(*) AS claim_count, GROUP_CONCAT(DISTINCT agent_id) AS agents
           FROM claims
           WHERE workspace_id = ? AND status = 'active'
           GROUP BY scope
           HAVING COUNT(*) > 1
           ORDER BY claim_count DESC
           LIMIT 20`,
        )
        .all(req.params.workspace) as {
        scope: string;
        claim_count: number;
        agents: string;
      }[];
      reply.send({ workspace: req.params.workspace, collisions: rows });
    },
  );

  // F-447 claim-path-pattern-stats
  app.get<{ Params: { workspace: string } }>(
    "/api/v1/workspaces/:workspace/claims/claim-path-pattern-stats",
    { preHandler: app.authGuard },
    async (req, reply) => {
      const rows = db
        .prepare(
          `SELECT cp.path_pattern, COUNT(*) AS usage_count
           FROM claim_paths cp
           JOIN claims c ON c.claim_id = cp.claim_id
           WHERE c.workspace_id = ?
           GROUP BY cp.path_pattern
           ORDER BY usage_count DESC
           LIMIT 20`,
        )
        .all(req.params.workspace) as {
        path_pattern: string;
        usage_count: number;
      }[];
      reply.send({ workspace: req.params.workspace, patterns: rows });
    },
  );
};

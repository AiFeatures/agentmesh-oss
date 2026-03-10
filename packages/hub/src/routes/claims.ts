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
            scope: { type: "string", minLength: 1, maxLength: 128 },
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
      const ok = renewClaim(claimId, body?.ttl_seconds ?? 1800);
      if (!ok) {
        return reply.code(404).send({ error: "Active claim not found" });
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
};

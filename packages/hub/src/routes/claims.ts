import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/index.js";
import { writeAuditLog } from "../services/audit.js";
import { createClaim, listClaims, releaseClaim, renewClaim } from "../services/claims.js";
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
            limit: { type: "string" },
            offset: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const { limit, offset, status } = request.query as {
        limit?: string;
        offset?: string;
        status?: string;
      };
      let all = listClaims(workspace);
      if (status) {
        all = all.filter((c) => c.status === status);
      }
      const start = Math.max(0, Number(offset) || 0);
      const count = Math.min(200, Math.max(1, Number(limit) || 50));
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
      broadcast("claims.updated", { workspace, claim_id: claimId, status: "active" });
      return reply.send({ ok: true });
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
};

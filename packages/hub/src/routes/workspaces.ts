import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/index.js";
import { writeAuditLog } from "../services/audit.js";
import { workspaceId as generateWorkspaceId } from "../services/ids.js";

export const workspaceRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/v1/workspaces", { preHandler: app.authGuard }, async (_request, reply) => {
    const rows = db
      .prepare(
        "SELECT workspace_id, display_name, base_path, created_at FROM workspaces ORDER BY created_at ASC",
      )
      .all();
    return reply.send({ data: rows });
  });

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
            workspace_id: { type: "string", minLength: 1, maxLength: 128 },
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
        base_path?: string;
      };
      const id = body.workspace_id ?? generateWorkspaceId();

      db.prepare(
        "INSERT INTO workspaces (workspace_id, display_name, base_path) VALUES (?, ?, ?)",
      ).run(id, body.display_name, body.base_path ?? null);

      writeAuditLog({
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
};

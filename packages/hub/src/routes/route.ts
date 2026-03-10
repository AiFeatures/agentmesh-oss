import type { FastifyPluginAsync } from "fastify";
import { routeByCapability } from "../services/capability-router.js";

export const routingRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/api/v1/workspaces/:workspace/route",
    {
      preHandler: app.authGuard,
      schema: {
        body: {
          type: "object",
          required: ["capability"],
          additionalProperties: false,
          properties: {
            capability: { type: "string", minLength: 1, maxLength: 64 },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspace } = request.params as { workspace: string };
      const body = request.body as { capability?: string };
      if (!body?.capability) {
        return reply.code(400).send({ error: "capability is required" });
      }

      const result = routeByCapability(workspace, body.capability);
      if (!result) {
        return reply.code(404).send({ error: "No matching online agent" });
      }

      return reply.send({
        agent_id: result.agent_id,
        active_claims: result.active_claims,
        metadata: result.metadata,
      });
    },
  );
};

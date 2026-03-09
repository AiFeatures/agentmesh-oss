import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { agentRoutes } from "./routes/agents.js";
import { blockerRoutes } from "./routes/blockers.js";
import { claimRoutes } from "./routes/claims.js";
import { handoffRoutes } from "./routes/handoffs.js";
import { routingRoutes } from "./routes/route.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { authGuard, validateSecret } from "./security/auth.js";
import { registerSocket } from "./ws/gateway.js";

declare module "fastify" {
  interface FastifyInstance {
    authGuard: typeof authGuard;
  }
}

export function buildApp() {
  const app = Fastify({ logger: true });

  app.decorate("authGuard", authGuard);

  app.addHook("onRequest", async (request, reply) => {
    const incoming = request.headers["x-request-id"];
    const requestId = typeof incoming === "string" ? incoming : randomUUID();
    reply.header("X-Request-Id", requestId);
  });

  app.register(cors, { origin: true });
  app.register(rateLimit, { max: 100, timeWindow: "1 minute" });

  app.get("/health", { config: { rateLimit: { max: 300 } } }, async () => ({
    status: "ok",
    service: "agentmesh-hub",
  }));

  app.register(async (wsApp) => {
    await wsApp.register(websocket);
    wsApp.get("/ws", { websocket: true }, (socket, request) => {
      if (!validateSecret(request)) {
        socket.close(1008, "Unauthorized");
        return;
      }
      registerSocket(socket);
      socket.send(JSON.stringify({ event: "connected", ts: new Date().toISOString() }));
    });
  });

  app.register(workspaceRoutes);
  app.register(agentRoutes);
  app.register(claimRoutes);
  app.register(handoffRoutes);
  app.register(blockerRoutes);
  app.register(routingRoutes);

  return app;
}

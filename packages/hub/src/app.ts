import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { agentRoutes } from "./routes/agents.js";
import { blockerRoutes } from "./routes/blockers.js";
import { claimRoutes } from "./routes/claims.js";
import { handoffRoutes } from "./routes/handoffs.js";
import { routingRoutes } from "./routes/route.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { authGuard } from "./security/auth.js";
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

  app.get("/health", async () => ({ status: "ok", service: "agentmesh-hub" }));

  app.register(async (wsApp) => {
    await wsApp.register(websocket);
    wsApp.get("/ws", { websocket: true }, (socket, _request) => {
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

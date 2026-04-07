import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { db } from "./db/index.js";
import { agentRoutes } from "./routes/agents.js";
import { blockerRoutes } from "./routes/blockers.js";
import { claimRoutes } from "./routes/claims.js";
import { handoffRoutes } from "./routes/handoffs.js";
import { routingRoutes } from "./routes/route.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { authGuard, validateSecret } from "./security/auth.js";
import { getSocketCount, registerSocket } from "./ws/gateway.js";

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

  /* ── F-60  Idempotency key support ──────────────────────────── */
  app.addHook("preHandler", async (request, reply) => {
    if (request.method !== "POST") return;
    const key = request.headers["x-idempotency-key"];
    if (typeof key !== "string" || key.length === 0) return;

    const existing = db
      .prepare(
        "SELECT response_status, response_body FROM idempotency_keys WHERE idempotency_key = ?",
      )
      .get(key) as { response_status: number; response_body: string } | undefined;
    if (existing) {
      reply.header("X-Idempotent-Replayed", "true");
      return reply.code(existing.response_status).send(JSON.parse(existing.response_body));
    }
    (request as unknown as Record<string, unknown>)._idempotencyKey = key;
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const key = (request as unknown as Record<string, unknown>)._idempotencyKey as string | undefined;
    if (!key || request.method !== "POST") return payload;
    const workspace = (request.params as Record<string, string>)?.workspace ?? "";
    try {
      db.prepare(
        "INSERT OR IGNORE INTO idempotency_keys (idempotency_key, workspace_id, endpoint, response_status, response_body) VALUES (?, ?, ?, ?, ?)",
      ).run(
        key,
        workspace,
        request.url,
        reply.statusCode,
        typeof payload === "string" ? payload : JSON.stringify(payload),
      );
    } catch (_) {
      // ignore write failures
    }
    return payload;
  });

  app.register(cors, { origin: true });
  app.register(rateLimit, { max: 100, timeWindow: "1 minute" });

  app.get("/health", { config: { rateLimit: { max: 300 } } }, async () => {
    const dbCheck = db.prepare("SELECT 1 as ok").get() as { ok: number } | undefined;
    const agentCount = db
      .prepare("SELECT count(*) as c FROM agents WHERE status IN ('online','idle')")
      .get() as { c: number };
    const activeClaimCount = db
      .prepare("SELECT count(*) as c FROM claims WHERE status = 'active'")
      .get() as { c: number };
    const openBlockerCount = db
      .prepare("SELECT count(*) as c FROM blockers WHERE status = 'open'")
      .get() as { c: number };
    const pendingHandoffs = db
      .prepare("SELECT count(*) as c FROM handoffs WHERE status = 'pending'")
      .get() as { c: number };
    const workspaceCount = db.prepare("SELECT count(*) as c FROM workspaces").get() as {
      c: number;
    };
    const dbOk = dbCheck?.ok === 1;
    return {
      status: dbOk ? "ok" : "degraded",
      service: "agentmesh-hub",
      version: "0.1.0",
      uptime: Math.floor(process.uptime()),
      db: dbOk ? "connected" : "error",
      ws_connections: getSocketCount(),
      workspaces: workspaceCount.c,
      agents_online: agentCount.c,
      active_claims: activeClaimCount.c,
      open_blockers: openBlockerCount.c,
      pending_handoffs: pendingHandoffs.c,
      memory_mb: Math.round(process.memoryUsage().rss / 1048576),
    };
  });

  app.post("/api/v1/admin/maintenance", { preHandler: app.authGuard }, async (_request, reply) => {
    const integrityResult = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const integrityOk = integrityResult[0]?.integrity_check === "ok";
    db.pragma("optimize");
    const pageCount = (db.pragma("page_count") as Array<{ page_count: number }>)[0]?.page_count;
    const freelistCount = (db.pragma("freelist_count") as Array<{ freelist_count: number }>)[0]
      ?.freelist_count;
    const shouldVacuum = freelistCount > 0 && freelistCount > pageCount * 0.1;
    if (shouldVacuum) {
      db.exec("VACUUM");
    }
    return reply.send({
      integrity: integrityOk ? "ok" : "error",
      page_count: pageCount,
      freelist_count: freelistCount,
      vacuumed: shouldVacuum,
    });
  });

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

  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send({ error: "Not found", status: 404 });
  });

  app.setErrorHandler((error: Error & { validation?: unknown; statusCode?: number }, request, reply) => {
    if (error.validation) {
      return reply.code(400).send({
        error: "Validation failed",
        status: 400,
        details: error.message,
      });
    }
    request.log.error(error);
    const status = error.statusCode ?? 500;
    return reply.code(status).send({
      error: status >= 500 ? "Internal server error" : error.message,
      status,
    });
  });

  return app;
}

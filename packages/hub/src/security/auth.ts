import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getSharedSecret } from "./secret.js";

declare module "fastify" {
  interface FastifyRequest {
    meshAuth?: {
      secretValidated: boolean;
    };
  }
}

export async function authGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    reply.code(401).send({ error: "Missing Bearer secret" });
    return;
  }

  const token = header.slice("Bearer ".length).trim();
  const expected = getSharedSecret();
  if (!token) {
    reply.code(401).send({ error: "Invalid shared secret" });
    return;
  }

  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expected);
  if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
    reply.code(401).send({ error: "Invalid shared secret" });
    return;
  }

  request.meshAuth = { secretValidated: true };
}

export function validateSecret(request: FastifyRequest): boolean {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return false;
  }
  const token = header.slice("Bearer ".length).trim();
  const expected = getSharedSecret();
  if (!token) {
    return false;
  }
  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expected);
  if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
    return false;
  }
  return true;
}

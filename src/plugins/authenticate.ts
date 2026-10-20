import type { FastifyReply, FastifyRequest } from "fastify";
import type { Role } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch {
    return reply.status(401).send({
      error: { message: "Authentication required", statusCode: 401, code: "UNAUTHENTICATED" },
    });
  }
}

export function requireRole(...roles: Role[]) {
  return async function roleGuard(request: FastifyRequest, reply: FastifyReply) {
    await authenticate(request, reply);
    if (reply.sent) return;
    const account = await prisma.user.findUnique({ where: { id: request.user.sub } });
    if (!account || account.blocked) {
      return reply.status(401).send({
        error: { message: "Authentication required", statusCode: 401, code: "UNAUTHENTICATED" },
      });
    }
    request.user.role = account.role;
    if (!roles.includes(account.role)) {
      return reply.status(403).send({
        error: { message: "You do not have access to this resource", statusCode: 403, code: "FORBIDDEN" },
      });
    }
  };
}

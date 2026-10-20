import { randomUUID } from "node:crypto";
import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import sensible from "@fastify/sensible";
import rateLimit from "@fastify/rate-limit";
import { env } from "./env.js";
import { prisma } from "./lib/prisma.js";
import { registerSwagger } from "./plugins/swagger.js";
import "./types/fastify.js";
import { authRoutes } from "./routes/auth.js";
import { meRoutes } from "./routes/me.js";
import { adminRoutes } from "./routes/admin.js";
import { catalogRoutes } from "./routes/catalog.js";
import { adminCatalogRoutes } from "./routes/admin-catalog.js";

export async function buildApp() {
  const app = Fastify({
    trustProxy: env.TRUST_PROXY,
    // Honor an inbound correlation id from a proxy/gateway; fall back to a
    // fresh one otherwise. Lets logs be traced across services later.
    genReqId: (req) => (req.headers["x-request-id"] as string | undefined) ?? randomUUID(),
    logger: {
      level: env.LOG_LEVEL ?? (env.NODE_ENV === "production" ? "info" : "debug"),
      transport:
        env.NODE_ENV === "development"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
      // Groundwork for phase 03 auth, which introduces these headers/cookies.
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
        censor: "[redacted]",
      },
    },
  });

  // Awaited deliberately: registering these concurrently (no await) was
  // found to silently prevent @fastify/rate-limit's onRequest hook from
  // attaching at all — no error, it just never rate-limits. Sequential
  // await avoids that.
  await app.register(cors, {
    origin: env.CORS_ORIGIN,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
  });
  // Swagger must register before Helmet so `instance.swaggerCSP` exists for the
  // CSP directives Swagger UI needs (inline hashes). Helmet after Swagger UI
  // is the official @fastify/swagger integration.
  await registerSwagger(app);
  await app.register(helmet, (instance) => ({
    // Product photos are served from this API and drawn on the storefront origin.
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        formAction: ["'self'"],
        imgSrc: ["'self'", "data:", "validator.swagger.io"],
        scriptSrc: ["'self'", ...instance.swaggerCSP.script],
        styleSrc: ["'self'", "https:", ...instance.swaggerCSP.style],
      },
    },
  }));
  await app.register(sensible);
  // Scaffolded for later phases: JWT verification (phase 03) and image uploads (phase 04).
  await app.register(jwt, { secret: env.JWT_SECRET });
  await app.register(multipart, {
    limits: {
      fileSize: 5 * 1024 * 1024,
      files: 8,
    },
  });
  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    // Swagger UI loads many static assets; don't count those against the API budget.
    allowList: (request) => {
      const path = request.url.split("?")[0] ?? "";
      return path === "/docs" || path.startsWith("/docs/");
    },
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, "request error");
    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      error: {
        message:
          statusCode >= 500 && env.NODE_ENV === "production"
            ? "Internal Server Error"
            : error.message,
        statusCode,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { message: `Route ${request.method} ${request.url} not found`, statusCode: 404 },
    });
  });

  // Prisma owns its own connection lifecycle; tie it to Fastify's so a
  // graceful app.close() (see src/index.ts) also closes the DB connection.
  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });

  // Health check — used by uptime monitoring and load balancers.
  // See doc/phases/01-foundation-setup.md and 13-deployment-devops.md.
  app.get(
    "/health",
    {
      schema: {
        tags: ["Health"],
        summary: "Service health",
        description: "Used by uptime monitoring and load balancers. Pings Postgres with SELECT 1.",
        response: {
          200: {
            type: "object",
            required: ["status", "db", "uptime", "timestamp"],
            properties: {
              status: { type: "string", enum: ["ok", "degraded"] },
              db: { type: "string", enum: ["connected", "unreachable"] },
              uptime: { type: "number" },
              timestamp: { type: "string", format: "date-time" },
            },
          },
        },
      },
    },
    async (request) => {
      let db: "connected" | "unreachable" = "connected";
      try {
        await prisma.$queryRaw`SELECT 1`;
      } catch (error) {
        request.log.warn({ err: error }, "health check database ping failed");
        db = "unreachable";
      }

      return {
        status: db === "connected" ? "ok" : "degraded",
        db,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      };
    }
  );

  await app.register(catalogRoutes);
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(adminRoutes);
  await app.register(adminCatalogRoutes);

  // Route modules land here as each phase is implemented, e.g.:
  // app.register(catalogRoutes, { prefix: "/products" });   // phase 04
  // app.register(cartRoutes, { prefix: "/cart" });           // phase 05
  // app.register(orderRoutes, { prefix: "/orders" });        // phase 06/07

  return app;
}

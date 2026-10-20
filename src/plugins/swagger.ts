import type { FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

export async function registerSwagger(app: FastifyInstance) {
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "Unique Accessories API",
        description:
          "Storefront API for Unique Accessories. Catalog, cart, and order routes are documented here as they ship.",
        version: "1.0.0",
      },
      servers: [{ url: "/", description: "Current host" }],
      tags: [
        { name: "Health", description: "Liveness and database connectivity" },
        { name: "Auth", description: "Sign up, login, email verification, password reset" },
        { name: "Account", description: "Profile, addresses, and order history" },
        { name: "Catalog", description: "Public storefront catalog" },
        { name: "Admin", description: "Role-gated routes" },
      ],
      components: {
        schemas: {
          ErrorResponse: {
            type: "object",
            required: ["error"],
            properties: {
              error: {
                type: "object",
                required: ["message", "statusCode"],
                properties: {
                  message: { type: "string" },
                  statusCode: { type: "integer" },
                },
              },
            },
          },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
      displayRequestDuration: true,
    },
    staticCSP: true,
  });
}

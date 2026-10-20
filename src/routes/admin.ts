import type { FastifyInstance } from "fastify";
import { requireRole } from "../plugins/authenticate.js";

export async function adminRoutes(app: FastifyInstance) {
  app.get(
    "/admin/session",
    {
      schema: { tags: ["Admin"], summary: "Admin-only session check" },
      preHandler: requireRole("ADMIN"),
    },
    async (request) => ({ ok: true, role: request.user.role }),
  );
}

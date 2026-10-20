import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { publicUser } from "../lib/auth.js";
import { authenticate } from "../plugins/authenticate.js";

const profileSchema = z.object({
  fullName: z.string().trim().min(2).max(80),
});

const addressSchema = z.object({
  line1: z.string().trim().min(3).max(120),
  line2: z.string().trim().max(120).optional(),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  pincode: z.string().trim().regex(/^\d{6}$/, "Enter a 6-digit pincode"),
  phone: z.string().trim().regex(/^\d{10}$/, "Enter a 10-digit phone number"),
  isDefault: z.boolean().optional(),
});

function invalidBody(reply: { status: (code: number) => { send: (body: unknown) => unknown } }, error: z.ZodError) {
  return reply.status(400).send({
    error: {
      message: error.issues[0]?.message ?? "Invalid request",
      statusCode: 400,
      code: "VALIDATION",
    },
  });
}

function emptyToNull(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function meRoutes(app: FastifyInstance) {
  app.get("/me", { schema: { tags: ["Account"], summary: "Current user profile" }, preHandler: authenticate }, async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.sub },
      include: { addresses: { orderBy: [{ isDefault: "desc" }, { id: "asc" }] } },
    });
    if (!user) {
      return reply.status(401).send({
        error: { message: "Authentication required", statusCode: 401, code: "UNAUTHENTICATED" },
      });
    }
    return { user: publicUser(user), addresses: user.addresses };
  });

  app.patch("/me", { schema: { tags: ["Account"], summary: "Update profile" }, preHandler: authenticate }, async (request, reply) => {
    const parsed = profileSchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);

    const user = await prisma.user.update({
      where: { id: request.user.sub },
      data: { fullName: parsed.data.fullName },
    });
    return { user: publicUser(user) };
  });

  app.get("/me/orders", { schema: { tags: ["Account"], summary: "Order history" }, preHandler: authenticate }, async (request) => {
    const orders = await prisma.order.findMany({
      where: { userId: request.user.sub },
      orderBy: { createdAt: "desc" },
      include: { items: { select: { id: true, quantity: true } } },
    });
    return {
      orders: orders.map((order) => ({
        id: order.id,
        status: order.status,
        total: order.total.toString(),
        createdAt: order.createdAt.toISOString(),
        itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
      })),
    };
  });

  app.get("/me/addresses", { schema: { tags: ["Account"], summary: "List addresses" }, preHandler: authenticate }, async (request) => {
    const addresses = await prisma.address.findMany({
      where: { userId: request.user.sub },
      orderBy: [{ isDefault: "desc" }, { id: "asc" }],
    });
    return { addresses };
  });

  app.post("/me/addresses", { schema: { tags: ["Account"], summary: "Add an address" }, preHandler: authenticate }, async (request, reply) => {
    const parsed = addressSchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);

    const address = await prisma.$transaction(async (tx) => {
      const existing = await tx.address.count({ where: { userId: request.user.sub } });
      const makeDefault = parsed.data.isDefault === true || existing === 0;
      if (makeDefault) {
        await tx.address.updateMany({ where: { userId: request.user.sub }, data: { isDefault: false } });
      }
      return tx.address.create({
        data: {
          userId: request.user.sub,
          line1: parsed.data.line1,
          line2: emptyToNull(parsed.data.line2),
          city: parsed.data.city,
          state: parsed.data.state,
          pincode: parsed.data.pincode,
          phone: parsed.data.phone,
          isDefault: makeDefault,
        },
      });
    });
    return reply.status(201).send({ address });
  });

  app.patch("/me/addresses/:id", { schema: { tags: ["Account"], summary: "Update an address" }, preHandler: authenticate }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const parsed = addressSchema.partial().safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.status(400).send({
        error: { message: "Invalid address update", statusCode: 400, code: "VALIDATION" },
      });
    }

    const current = await prisma.address.findFirst({
      where: { id: params.data.id, userId: request.user.sub },
    });
    if (!current) {
      return reply.status(404).send({
        error: { message: "Address not found", statusCode: 404, code: "NOT_FOUND" },
      });
    }

    const address = await prisma.$transaction(async (tx) => {
      if (parsed.data.isDefault === true) {
        await tx.address.updateMany({ where: { userId: request.user.sub }, data: { isDefault: false } });
      }
      return tx.address.update({
        where: { id: current.id },
        data: {
          line1: parsed.data.line1,
          line2: parsed.data.line2 === undefined ? undefined : emptyToNull(parsed.data.line2),
          city: parsed.data.city,
          state: parsed.data.state,
          pincode: parsed.data.pincode,
          phone: parsed.data.phone,
          isDefault: parsed.data.isDefault,
        },
      });
    });
    return { address };
  });

  app.delete("/me/addresses/:id", { schema: { tags: ["Account"], summary: "Delete an address" }, preHandler: authenticate }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { message: "Invalid address id", statusCode: 400, code: "VALIDATION" },
      });
    }

    const current = await prisma.address.findFirst({
      where: { id: params.data.id, userId: request.user.sub },
    });
    if (!current) {
      return reply.status(404).send({
        error: { message: "Address not found", statusCode: 404, code: "NOT_FOUND" },
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.address.delete({ where: { id: current.id } });
      if (current.isDefault) {
        const next = await tx.address.findFirst({
          where: { userId: request.user.sub },
          orderBy: { id: "asc" },
        });
        if (next) {
          await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
        }
      }
    });
    return reply.status(204).send();
  });
}

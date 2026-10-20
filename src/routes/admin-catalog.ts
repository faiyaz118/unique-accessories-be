import type { FastifyInstance } from "fastify";
import { Prisma, type OrderStatus, type ProductBadge, type ProductStatus } from "@prisma/client";
import { z } from "zod";
import { env } from "../env.js";
import { prisma } from "../lib/prisma.js";
import { productInclude, toStoreProduct } from "../lib/catalog.js";
import { storeProductImage } from "../lib/images.js";
import { requireRole } from "../plugins/authenticate.js";
import { slugify } from "./catalog.js";

const staff = requireRole("ADMIN", "SUPPORT");
const adminOnly = requireRole("ADMIN");

const variantSchema = z.object({
  sku: z.string().trim().min(2),
  color: z.string().trim().optional(),
  colorHex: z.string().trim().optional(),
  material: z.string().trim().optional(),
  capacity: z.string().trim().optional(),
  price: z.number().positive(),
  compareAt: z.number().positive().optional(),
  quantity: z.number().int().min(0).default(0),
});

const productSchema = z.object({
  name: z.string().trim().min(2),
  slug: z.string().trim().min(2).optional(),
  subcategoryId: z.string().min(1),
  shortDescription: z.string().trim().min(2),
  description: z.string().trim().min(2),
  features: z.array(z.string().trim().min(1)).default([]),
  status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).default("DRAFT"),
  badge: z.enum(["BESTSELLER", "NEW", "SALE"]).nullable().optional(),
  deviceModelIds: z.array(z.string()).default([]),
  variants: z.array(variantSchema).min(1),
});

function invalid(reply: { status: (code: number) => { send: (body: unknown) => unknown } }, error: z.ZodError) {
  return reply.status(400).send({
    error: { message: error.issues[0]?.message ?? "Invalid request", statusCode: 400, code: "VALIDATION" },
  });
}

export async function adminCatalogRoutes(app: FastifyInstance) {
  app.get("/admin/dashboard", { preHandler: staff, schema: { tags: ["Admin"] } }, async () => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const [ordersToday, recentOrders, lowStock, customers, products] = await Promise.all([
      prisma.order.findMany({ where: { createdAt: { gte: start }, status: { not: "CANCELLED" } } }),
      prisma.order.findMany({ orderBy: { createdAt: "desc" }, take: 8, include: { user: true } }),
      prisma.inventory.findMany({
        where: { quantity: { lte: env.LOW_STOCK_THRESHOLD } },
        include: { variant: { include: { product: true } } },
        orderBy: { quantity: "asc" },
        take: 20,
      }),
      prisma.user.count({ where: { role: "CUSTOMER" } }),
      prisma.product.count(),
    ]);
    const sales = ordersToday.reduce((sum, order) => sum + Number(order.total), 0);
    return {
      salesToday: sales,
      ordersToday: ordersToday.length,
      customerCount: customers,
      productCount: products,
      lowStockThreshold: env.LOW_STOCK_THRESHOLD,
      lowStock: lowStock.map((row) => ({
        variantId: row.variantId,
        sku: row.variant.sku,
        productName: row.variant.product.name,
        quantity: row.quantity,
      })),
      recentOrders: recentOrders.map((order) => ({
        id: order.id,
        status: order.status,
        total: order.total.toString(),
        email: order.user.email,
        createdAt: order.createdAt.toISOString(),
      })),
    };
  });

  app.get("/admin/products", { preHandler: staff, schema: { tags: ["Admin"] } }, async () => {
    const products = await prisma.product.findMany({ include: productInclude, orderBy: { updatedAt: "desc" } });
    return { products: products.map(toStoreProduct) };
  });

  app.get("/admin/products/:id", { preHandler: staff, schema: { tags: ["Admin"] } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const product = await prisma.product.findUnique({ where: { id }, include: productInclude });
    if (!product) return reply.status(404).send({ error: { message: "Product not found", statusCode: 404 } });
    return { product: toStoreProduct(product) };
  });

  app.post("/admin/products", { preHandler: adminOnly, schema: { tags: ["Admin"] } }, async (request, reply) => {
    const parsed = productSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const data = parsed.data;
    try {
      const product = await prisma.product.create({
        data: {
          name: data.name,
          slug: slugify(data.slug || data.name),
          subcategoryId: data.subcategoryId,
          shortDescription: data.shortDescription,
          description: data.description,
          features: data.features,
          status: data.status as ProductStatus,
          badge: (data.badge ?? null) as ProductBadge | null,
          variants: {
            create: data.variants.map((variant) => ({
              sku: variant.sku,
              color: variant.color,
              colorHex: variant.colorHex,
              material: variant.material,
              capacity: variant.capacity,
              price: variant.price,
              compareAt: variant.compareAt,
              inventory: { create: { quantity: variant.quantity } },
            })),
          },
          compatibility: {
            create: data.deviceModelIds.map((deviceModelId) => ({ deviceModelId })),
          },
        },
        include: productInclude,
      });
      return reply.status(201).send({ product: toStoreProduct(product) });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.status(409).send({ error: { message: "Slug or SKU already exists", statusCode: 409 } });
      }
      throw error;
    }
  });

  app.patch("/admin/products/:id", { preHandler: adminOnly, schema: { tags: ["Admin"] } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = productSchema.partial().safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const data = parsed.data;
    const existing = await prisma.product.findUnique({ where: { id } });
    if (!existing) return reply.status(404).send({ error: { message: "Product not found", statusCode: 404 } });

    const product = await prisma.$transaction(async (tx) => {
      if (data.variants) {
        await tx.productVariant.deleteMany({ where: { productId: id } });
      }
      if (data.deviceModelIds) {
        await tx.productCompatibility.deleteMany({ where: { productId: id } });
      }
      return tx.product.update({
        where: { id },
        data: {
          name: data.name,
          slug: data.slug ? slugify(data.slug) : data.name ? slugify(data.name) : undefined,
          subcategoryId: data.subcategoryId,
          shortDescription: data.shortDescription,
          description: data.description,
          features: data.features,
          status: data.status as ProductStatus | undefined,
          badge: data.badge === undefined ? undefined : (data.badge as ProductBadge | null),
          variants: data.variants
            ? {
                create: data.variants.map((variant) => ({
                  sku: variant.sku,
                  color: variant.color,
                  colorHex: variant.colorHex,
                  material: variant.material,
                  capacity: variant.capacity,
                  price: variant.price,
                  compareAt: variant.compareAt,
                  inventory: { create: { quantity: variant.quantity } },
                })),
              }
            : undefined,
          compatibility: data.deviceModelIds
            ? { create: data.deviceModelIds.map((deviceModelId) => ({ deviceModelId })) }
            : undefined,
        },
        include: productInclude,
      });
    });
    return { product: toStoreProduct(product) };
  });

  app.delete("/admin/products/:id", { preHandler: adminOnly, schema: { tags: ["Admin"] } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.product.delete({ where: { id } }).catch(() => null);
    return reply.status(204).send();
  });

  app.post("/admin/products/:id/images", { preHandler: adminOnly, schema: { tags: ["Admin"] } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const product = await prisma.product.findUnique({ where: { id } });
    if (!product) return reply.status(404).send({ error: { message: "Product not found", statusCode: 404 } });
    const file = await request.file();
    if (!file) return reply.status(400).send({ error: { message: "Choose an image file", statusCode: 400 } });
    const buffer = await file.toBuffer();
    const variantId = typeof file.fields.variantId === "object" && file.fields.variantId && "value" in file.fields.variantId
      ? String(file.fields.variantId.value)
      : undefined;
    const url = await storeProductImage(buffer, id);
    const count = await prisma.productImage.count({ where: { productId: id } });
    const image = await prisma.productImage.create({
      data: {
        productId: id,
        variantId: variantId || null,
        url,
        altText: product.name,
        position: count,
      },
    });
    return reply.status(201).send({ image });
  });

  app.delete("/admin/products/:id/images/:imageId", { preHandler: adminOnly }, async (request, reply) => {
    const { id, imageId } = request.params as { id: string; imageId: string };
    await prisma.productImage.deleteMany({ where: { id: imageId, productId: id } });
    return reply.status(204).send();
  });

  app.post("/admin/categories", { preHandler: adminOnly }, async (request, reply) => {
    const parsed = z.object({ name: z.string().min(2), description: z.string().optional(), icon: z.string().optional() }).safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const category = await prisma.category.create({
      data: { name: parsed.data.name, slug: slugify(parsed.data.name), description: parsed.data.description, icon: parsed.data.icon },
    });
    return reply.status(201).send({ category });
  });

  app.post("/admin/subcategories", { preHandler: adminOnly }, async (request, reply) => {
    const parsed = z
      .object({ categoryId: z.string(), name: z.string().min(2), description: z.string().optional(), icon: z.string().optional() })
      .safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const subcategory = await prisma.subcategory.create({
      data: {
        categoryId: parsed.data.categoryId,
        name: parsed.data.name,
        slug: slugify(parsed.data.name),
        description: parsed.data.description,
        icon: parsed.data.icon,
      },
    });
    return reply.status(201).send({ subcategory });
  });

  app.post("/admin/brands", { preHandler: adminOnly }, async (request, reply) => {
    const parsed = z.object({ name: z.string().min(2), type: z.enum(["PHONE", "CAR"]) }).safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const brand = await prisma.brand.create({ data: parsed.data });
    return reply.status(201).send({ brand });
  });

  app.post("/admin/device-models", { preHandler: adminOnly }, async (request, reply) => {
    const parsed = z
      .object({ brandId: z.string(), name: z.string().min(2), type: z.enum(["PHONE", "CAR"]) })
      .safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const deviceModel = await prisma.deviceModel.create({ data: parsed.data });
    return reply.status(201).send({ deviceModel });
  });

  app.get("/admin/inventory", { preHandler: staff }, async () => {
    const rows = await prisma.inventory.findMany({
      include: { variant: { include: { product: true } } },
      orderBy: { quantity: "asc" },
    });
    return {
      threshold: env.LOW_STOCK_THRESHOLD,
      inventory: rows.map((row) => ({
        variantId: row.variantId,
        sku: row.variant.sku,
        productId: row.variant.productId,
        productName: row.variant.product.name,
        quantity: row.quantity,
        reserved: row.reserved,
        low: row.quantity <= env.LOW_STOCK_THRESHOLD,
      })),
    };
  });

  app.patch("/admin/inventory/:variantId", { preHandler: adminOnly }, async (request, reply) => {
    const { variantId } = request.params as { variantId: string };
    const parsed = z.object({ quantity: z.number().int().min(0) }).safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const inventory = await prisma.inventory.update({
      where: { variantId },
      data: { quantity: parsed.data.quantity },
    });
    return { inventory };
  });

  app.get("/admin/orders", { preHandler: staff }, async () => {
    const orders = await prisma.order.findMany({
      orderBy: { createdAt: "desc" },
      include: { user: true, items: true },
      take: 100,
    });
    return {
      orders: orders.map((order) => ({
        id: order.id,
        status: order.status,
        total: order.total.toString(),
        email: order.user.email,
        itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
        createdAt: order.createdAt.toISOString(),
      })),
    };
  });

  app.patch("/admin/orders/:id", { preHandler: staff }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z
      .object({
        status: z.enum(["PLACED", "CONFIRMED", "PACKED", "SHIPPED", "DELIVERED", "CANCELLED", "RETURNED", "REFUNDED"]),
      })
      .safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    if (parsed.data.status === "REFUNDED" && request.user.role !== "ADMIN") {
      return reply.status(403).send({ error: { message: "Only an admin can issue a refund", statusCode: 403 } });
    }
    const existing = await prisma.order.findUnique({ where: { id }, include: { payment: true } });
    if (!existing) return reply.status(404).send({ error: { message: "Order not found", statusCode: 404 } });
    const order = await prisma.order.update({
      where: { id },
      data: {
        status: parsed.data.status as OrderStatus,
        statusHistory: { create: { status: parsed.data.status as OrderStatus, note: `Updated by ${request.user.email}` } },
        ...(parsed.data.status === "REFUNDED" && existing.payment
          ? { payment: { update: { status: "REFUNDED" } } }
          : {}),
      },
    });
    return { order: { id: order.id, status: order.status } };
  });

  app.get("/admin/coupons", { preHandler: staff }, async () => {
    const coupons = await prisma.coupon.findMany({ orderBy: { code: "asc" } });
    return {
      coupons: coupons.map((coupon) => ({
        id: coupon.id,
        code: coupon.code,
        type: coupon.type,
        value: Number(coupon.value),
        minOrderValue: Number(coupon.minOrderValue ?? 0),
        description: coupon.description ?? "",
        active: coupon.active,
        expiresAt: coupon.expiresAt?.toISOString() ?? null,
      })),
    };
  });

  app.post("/admin/coupons", { preHandler: adminOnly }, async (request, reply) => {
    const parsed = z
      .object({
        code: z.string().trim().min(3),
        type: z.enum(["PERCENT", "FLAT"]),
        value: z.number().positive(),
        minOrderValue: z.number().min(0).optional(),
        description: z.string().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const coupon = await prisma.coupon.create({
      data: { ...parsed.data, code: parsed.data.code.toUpperCase() },
    });
    return reply.status(201).send({ coupon });
  });

  app.patch("/admin/coupons/:id", { preHandler: adminOnly }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z.object({ active: z.boolean() }).safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const coupon = await prisma.coupon.update({ where: { id }, data: { active: parsed.data.active } });
    return { coupon: { id: coupon.id, active: coupon.active } };
  });

  app.get("/admin/customers", { preHandler: staff }, async () => {
    const customers = await prisma.user.findMany({
      where: { role: { in: ["CUSTOMER", "SUPPORT", "ADMIN"] } },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { _count: { select: { orders: true } } },
    });
    return {
      customers: customers.map((user) => ({
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        blocked: user.blocked,
        orderCount: user._count.orders,
        createdAt: user.createdAt.toISOString(),
      })),
    };
  });

  app.patch("/admin/customers/:id", { preHandler: adminOnly }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z.object({ blocked: z.boolean().optional(), role: z.enum(["CUSTOMER", "SUPPORT", "ADMIN"]).optional() }).safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const customer = await prisma.user.update({ where: { id }, data: parsed.data });
    return { customer: { id: customer.id, blocked: customer.blocked, role: customer.role } };
  });
}

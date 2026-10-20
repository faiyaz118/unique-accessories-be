import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { findPublishedProducts, toStoreProduct, productInclude } from "../lib/catalog.js";
import { readUploadedFile } from "../lib/images.js";

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export { slugify };

export async function catalogRoutes(app: FastifyInstance) {
  app.get("/media/*", async (request, reply) => {
    const key = (request.params as { "*": string })["*"];
    const file = await readUploadedFile(key);
    if (!file) return reply.status(404).send({ error: { message: "Image not found", statusCode: 404 } });
    return reply.type("image/webp").send(file);
  });

  app.get("/categories", { schema: { tags: ["Catalog"], summary: "List categories" } }, async () => {
    const categories = await prisma.category.findMany({ orderBy: { name: "asc" } });
    return {
      categories: categories.map((category) => ({
        id: category.id,
        name: category.name,
        slug: category.slug,
        description: category.description ?? "",
        icon: category.icon ?? "package",
      })),
    };
  });

  app.get("/categories/:slug/subcategories", { schema: { tags: ["Catalog"] } }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const category = await prisma.category.findUnique({ where: { slug }, include: { subcategories: true } });
    if (!category) return reply.status(404).send({ error: { message: "Category not found", statusCode: 404 } });
    return {
      subcategories: category.subcategories.map((sub) => ({
        id: sub.id,
        categoryId: sub.categoryId,
        categorySlug: category.slug,
        name: sub.name,
        slug: sub.slug,
        description: sub.description ?? "",
        icon: sub.icon ?? "package",
      })),
    };
  });

  app.get("/subcategories", { schema: { tags: ["Catalog"] } }, async () => {
    const rows = await prisma.subcategory.findMany({ include: { category: true }, orderBy: { name: "asc" } });
    return {
      subcategories: rows.map((sub) => ({
        id: sub.id,
        categoryId: sub.categoryId,
        categorySlug: sub.category.slug,
        name: sub.name,
        slug: sub.slug,
        description: sub.description ?? "",
        icon: sub.icon ?? "package",
      })),
    };
  });

  app.get("/brands", { schema: { tags: ["Catalog"] } }, async (request) => {
    const type = z.enum(["PHONE", "CAR"]).optional().parse((request.query as { type?: string }).type);
    const brands = await prisma.brand.findMany({ where: { type }, orderBy: { name: "asc" } });
    return { brands };
  });

  app.get("/device-models", { schema: { tags: ["Catalog"] } }, async (request) => {
    const query = z
      .object({
        brandId: z.string().optional(),
        type: z.enum(["PHONE", "CAR"]).optional(),
      })
      .parse(request.query);
    const models = await prisma.deviceModel.findMany({
      where: { brandId: query.brandId, type: query.type },
      include: { brand: true },
      orderBy: { name: "asc" },
    });
    return {
      deviceModels: models.map((model) => ({
        id: model.id,
        brandId: model.brandId,
        brandName: model.brand.name,
        name: model.name,
        type: model.type,
      })),
    };
  });

  app.get("/products", { schema: { tags: ["Catalog"], summary: "Published products" } }, async (request) => {
    const query = z
      .object({
        subcategory: z.string().optional(),
        category: z.string().optional(),
        deviceModelId: z.string().optional(),
        page: z.coerce.number().int().positive().default(1),
        pageSize: z.coerce.number().int().positive().max(200).default(24),
      })
      .parse(request.query);

    const where = {
      ...(query.subcategory ? { subcategory: { slug: query.subcategory } } : {}),
      ...(query.category ? { subcategory: { category: { slug: query.category } } } : {}),
      ...(query.deviceModelId
        ? { OR: [{ compatibility: { none: {} } }, { compatibility: { some: { deviceModelId: query.deviceModelId } } }] }
        : {}),
    };

    const all = await findPublishedProducts(where);
    const start = (query.page - 1) * query.pageSize;
    return {
      products: all.slice(start, start + query.pageSize),
      page: query.page,
      pageSize: query.pageSize,
      total: all.length,
    };
  });

  app.get("/products/:slug", { schema: { tags: ["Catalog"], summary: "Published product" } }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const product = await prisma.product.findFirst({
      where: { slug, status: "PUBLISHED" },
      include: productInclude,
    });
    if (!product) return reply.status(404).send({ error: { message: "Product not found", statusCode: 404 } });
    const related = await findPublishedProducts({
      subcategoryId: product.subcategoryId,
      NOT: { id: product.id },
    });
    return { product: toStoreProduct(product), related: related.slice(0, 4) };
  });

  app.get("/coupons/:code", { schema: { tags: ["Catalog"] } }, async (request, reply) => {
    const { code } = request.params as { code: string };
    const coupon = await prisma.coupon.findFirst({
      where: { code: { equals: code, mode: "insensitive" }, active: true },
    });
    if (!coupon || (coupon.expiresAt && coupon.expiresAt < new Date())) {
      return reply.status(404).send({ error: { message: "That coupon code isn't valid.", statusCode: 404 } });
    }
    return {
      coupon: {
        code: coupon.code,
        type: coupon.type,
        value: Number(coupon.value),
        minOrderValue: Number(coupon.minOrderValue ?? 0),
        description: coupon.description ?? "",
      },
    };
  });
}

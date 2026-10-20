import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

export const productInclude = {
  subcategory: { include: { category: true } },
  variants: { include: { inventory: true }, orderBy: { sku: "asc" } },
  images: { orderBy: { position: "asc" } },
  compatibility: true,
  reviews: { where: { approved: true }, include: { user: true }, orderBy: { createdAt: "desc" } },
} satisfies Prisma.ProductInclude;

export type CatalogProduct = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

const BADGE_LABEL = {
  BESTSELLER: "Bestseller",
  NEW: "New",
  SALE: "Sale",
} as const;

export function toStoreProduct(product: CatalogProduct) {
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    subcategoryId: product.subcategoryId,
    subcategorySlug: product.subcategory.slug,
    categorySlug: product.subcategory.category.slug,
    shortDescription: product.shortDescription,
    description: product.description,
    features: product.features,
    rating: Number(product.ratingAverage),
    reviewCount: product.ratingCount,
    badge: product.badge ? BADGE_LABEL[product.badge] : null,
    status: product.status,
    visual: {
      icon: product.placeholderIcon ?? "package",
      theme: product.placeholderTheme ?? "navy",
    },
    images: product.images.map((image) => ({
      id: image.id,
      url: image.url,
      altText: image.altText,
      variantId: image.variantId,
      position: image.position,
    })),
    variants: product.variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      color: variant.color ?? undefined,
      colorHex: variant.colorHex ?? undefined,
      capacity: variant.capacity ?? undefined,
      price: Number(variant.price),
      compareAtPrice: variant.compareAt == null ? undefined : Number(variant.compareAt),
      stock: Math.max(0, (variant.inventory?.quantity ?? 0) - (variant.inventory?.reserved ?? 0)),
    })),
    compatibleDeviceModelIds: product.compatibility.map((row) => row.deviceModelId),
    reviews: product.reviews.map((review) => ({
      id: review.id,
      author: review.user.fullName ?? "Customer",
      rating: review.rating,
      title: review.title ?? "",
      comment: review.comment ?? "",
      date: review.createdAt.toISOString().slice(0, 10),
      verified: review.verified,
    })),
  };
}

export async function findPublishedProducts(where: Prisma.ProductWhereInput = {}) {
  const products = await prisma.product.findMany({
    where: { ...where, status: "PUBLISHED" },
    include: productInclude,
    orderBy: { createdAt: "desc" },
  });
  return products.map(toStoreProduct);
}

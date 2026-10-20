import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { env } from "../env.js";
import { isR2Configured, uploadPublicObject } from "./r2.js";

const uploadsRoot = path.resolve(process.cwd(), "uploads");

export function publicApiUrl() {
  return (env.PUBLIC_API_URL ?? `http://localhost:${env.PORT}`).replace(/\/$/, "");
}

export async function storeProductImage(input: Buffer, productId: string) {
  const id = randomUUID();
  const full = await sharp(input)
    .rotate()
    .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();

  const key = `products/${productId}/${id}.webp`;
  if (isR2Configured()) {
    return uploadPublicObject(key, full, "image/webp");
  }

  const filePath = path.join(uploadsRoot, key);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, full);
  return `${publicApiUrl()}/media/${key}`;
}

export async function readUploadedFile(key: string) {
  const filePath = path.resolve(uploadsRoot, key);
  if (!filePath.startsWith(uploadsRoot)) return null;
  try {
    return await readFile(filePath);
  } catch {
    return null;
  }
}

import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Role, User } from "@prisma/client";
import { env } from "../env.js";

const BCRYPT_ROUNDS = 12;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

export function newUserId() {
  return randomUUID();
}

export function hashPassword(password: string) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export function verifyPassword(password: string, passwordHash: string) {
  return bcrypt.compare(password, passwordHash);
}

export function newToken() {
  const raw = randomBytes(32).toString("hex");
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

export function verifyExpiry() {
  return new Date(Date.now() + VERIFY_TTL_MS);
}

export function resetExpiry() {
  return new Date(Date.now() + RESET_TTL_MS);
}

export function webOrigin() {
  return env.CORS_ORIGIN[0] ?? "http://localhost:3000";
}

export function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    emailVerified: user.emailVerifiedAt != null,
    createdAt: user.createdAt.toISOString(),
  };
}

export function signPayload(user: { id: string; email: string; role: Role }) {
  return { sub: user.id, email: user.email, role: user.role };
}

import "dotenv/config";
import { z } from "zod";

const DEV_JWT_SECRET = "dev-only-jwt-secret-do-not-use-in-production";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().default(4000),
    // Comma-separated for multiple allowed origins (e.g. staging + prod frontends).
    // "http://a.com,http://b.com" -> ["http://a.com", "http://b.com"]
    CORS_ORIGIN: z
      .string()
      .default("http://localhost:3000")
      .transform((value) =>
        value
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).optional(),
    // Only set to true once this actually sits behind a reverse proxy/load balancer
    // (Phase 13) — affects how Fastify derives request.ip.
    TRUST_PROXY: z.coerce.boolean().default(false),
    // Local Postgres (docker compose) or Supabase's pooled connection string.
    DATABASE_URL: z.string().url(),
    // Used by @fastify/jwt. The development default is rejected in production.
    JWT_SECRET: z.string().min(32).default(DEV_JWT_SECRET),
    // Comma-separated emails promoted to ADMIN on login. Local stand-in until Supabase.
    ADMIN_EMAILS: z
      .string()
      .optional()
      .transform((value) =>
        (value ?? "")
          .split(",")
          .map((email) => email.trim().toLowerCase())
          .filter(Boolean),
      ),
    LOW_STOCK_THRESHOLD: z.coerce.number().int().positive().default(5),
    PUBLIC_API_URL: z.string().url().optional(),
    // Cloudflare R2. Leave every R2_* value unset until the bucket exists.
    // Set them all together — a partial set fails boot.
    R2_ACCOUNT_ID: z.string().min(1).optional(),
    R2_ACCESS_KEY_ID: z.string().min(1).optional(),
    R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    R2_BUCKET: z.string().min(1).optional(),
    R2_PUBLIC_URL: z.string().url().optional(),
    // Uncommented as each phase wires up the real dependency:
    // SUPABASE_URL: z.string().url(),          // phase 03
    // SUPABASE_SERVICE_ROLE_KEY: z.string(),   // phase 03
    // RAZORPAY_KEY_ID: z.string(),             // phase 06
    // RAZORPAY_KEY_SECRET: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === "production" && value.JWT_SECRET === DEV_JWT_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["JWT_SECRET"],
        message: "Set a unique JWT_SECRET before running in production",
      });
    }

    const r2Values = [
      value.R2_ACCOUNT_ID,
      value.R2_ACCESS_KEY_ID,
      value.R2_SECRET_ACCESS_KEY,
      value.R2_BUCKET,
      value.R2_PUBLIC_URL,
    ];
    const present = r2Values.filter((item) => item !== undefined).length;
    if (present > 0 && present < r2Values.length) {
      ctx.addIssue({
        code: "custom",
        path: ["R2_ACCOUNT_ID"],
        message: "Set all R2_* variables together, or leave them all unset",
      });
    }
  });

export const env = envSchema.parse(process.env);

export const r2Config =
  env.R2_ACCOUNT_ID &&
  env.R2_ACCESS_KEY_ID &&
  env.R2_SECRET_ACCESS_KEY &&
  env.R2_BUCKET &&
  env.R2_PUBLIC_URL
    ? {
        accountId: env.R2_ACCOUNT_ID,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        bucket: env.R2_BUCKET,
        publicUrl: env.R2_PUBLIC_URL.replace(/\/$/, ""),
      }
    : null;

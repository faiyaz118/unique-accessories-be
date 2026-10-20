import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import {
  hashPassword,
  hashToken,
  newToken,
  newUserId,
  publicUser,
  resetExpiry,
  signPayload,
  verifyExpiry,
  verifyPassword,
  webOrigin,
} from "../lib/auth.js";
import { env } from "../env.js";
import { authenticate } from "../plugins/authenticate.js";

const registerSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string().min(8).max(72),
  fullName: z.string().trim().min(2).max(80).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string().min(1),
});

const tokenSchema = z.object({
  token: z.string().min(20),
});

const resetSchema = tokenSchema.extend({
  password: z.string().min(8).max(72),
});

const forgotSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
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

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/register", { schema: { tags: ["Auth"], summary: "Create an account" } }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);

    const verify = newToken();
    try {
      const user = await prisma.user.create({
        data: {
          id: newUserId(),
          email: parsed.data.email,
          fullName: parsed.data.fullName,
          passwordHash: await hashPassword(parsed.data.password),
          emailVerifyToken: verify.hash,
          emailVerifyExpires: verifyExpiry(),
        },
      });

      const verificationUrl = `${webOrigin()}/verify-email?token=${verify.raw}`;
      return reply.status(201).send({
        user: publicUser(user),
        ...(env.NODE_ENV === "development" ? { verificationUrl } : {}),
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.status(409).send({
          error: { message: "An account with that email already exists", statusCode: 409, code: "EMAIL_TAKEN" },
        });
      }
      throw error;
    }
  });

  app.post("/auth/verify-email", { schema: { tags: ["Auth"], summary: "Confirm an email address" } }, async (request, reply) => {
    const parsed = tokenSchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);

    const user = await prisma.user.findUnique({ where: { emailVerifyToken: hashToken(parsed.data.token) } });
    if (!user || !user.emailVerifyExpires || user.emailVerifyExpires < new Date()) {
      return reply.status(400).send({
        error: { message: "This verification link is invalid or expired", statusCode: 400, code: "INVALID_TOKEN" },
      });
    }

    const verified = await prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date(), emailVerifyToken: null, emailVerifyExpires: null },
    });
    return { user: publicUser(verified) };
  });

  app.post("/auth/login", { schema: { tags: ["Auth"], summary: "Log in with email and password" } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);

    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    if (!user?.passwordHash || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
      return reply.status(401).send({
        error: { message: "Invalid email or password", statusCode: 401, code: "INVALID_CREDENTIALS" },
      });
    }
    if (!user.emailVerifiedAt) {
      return reply.status(403).send({
        error: { message: "Verify your email before logging in", statusCode: 403, code: "EMAIL_NOT_VERIFIED" },
      });
    }
    if (user.blocked) {
      return reply.status(403).send({
        error: { message: "This account is blocked", statusCode: 403, code: "BLOCKED" },
      });
    }

    const promoted = env.ADMIN_EMAILS.includes(user.email) && user.role !== "ADMIN";
    const account = promoted
      ? await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } })
      : user;

    const token = await reply.jwtSign(signPayload(account), { expiresIn: "7d" });
    return { token, user: publicUser(account) };
  });

  app.post("/auth/forgot-password", { schema: { tags: ["Auth"], summary: "Request a password reset" } }, async (request, reply) => {
    const parsed = forgotSchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);

    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    let resetUrl: string | undefined;
    if (user?.passwordHash) {
      const reset = newToken();
      await prisma.user.update({
        where: { id: user.id },
        data: { resetToken: reset.hash, resetExpires: resetExpiry() },
      });
      resetUrl = `${webOrigin()}/reset-password?token=${reset.raw}`;
    }

    return {
      message: "If that email has an account, a reset link is ready.",
      ...(env.NODE_ENV === "development" && resetUrl ? { resetUrl } : {}),
    };
  });

  app.post("/auth/reset-password", { schema: { tags: ["Auth"], summary: "Set a new password" } }, async (request, reply) => {
    const parsed = resetSchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);

    const user = await prisma.user.findUnique({ where: { resetToken: hashToken(parsed.data.token) } });
    if (!user || !user.resetExpires || user.resetExpires < new Date()) {
      return reply.status(400).send({
        error: { message: "This reset link is invalid or expired", statusCode: 400, code: "INVALID_TOKEN" },
      });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(parsed.data.password),
        resetToken: null,
        resetExpires: null,
        emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
      },
    });
    return { message: "Password updated. You can log in now." };
  });

  app.post(
    "/auth/sync",
    { schema: { tags: ["Auth"], summary: "Ensure the mirrored user row exists" }, preHandler: authenticate },
    async (request) => {
      const body = z.object({ fullName: z.string().trim().min(2).max(80).optional() }).safeParse(request.body ?? {});
      const user = await prisma.user.upsert({
        where: { id: request.user.sub },
        update: { fullName: body.success ? body.data.fullName : undefined, email: request.user.email },
        create: {
          id: request.user.sub,
          email: request.user.email,
          role: request.user.role,
          fullName: body.success ? body.data.fullName : undefined,
          emailVerifiedAt: new Date(),
        },
      });
      return { user: publicUser(user) };
    },
  );
}

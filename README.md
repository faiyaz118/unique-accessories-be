# Unique Accessories — Backend

Fastify + TypeScript API, now with a working Prisma/Postgres layer (Phase 2 of
[`../doc/phases/02-database-schema.md`](../doc/phases/02-database-schema.md)) plus a set of
production-readiness basics (graceful shutdown, rate limiting, structured errors — see below). The
frontend (`unique-accessories-fe`) still runs on its own local mock JSON and does not call this API
yet — that switch happens in Phase 4.

## One-time setup: create your own `.env`

This file is intentionally not committed (and not created by tooling on your behalf) since it holds
credentials. Create `unique-accessories-be/.env` with:

```bash
DATABASE_URL="postgresql://unique_accessories:dev_local_only_pw@localhost:5432/unique_accessories_dev?schema=public"
PORT=4000
CORS_ORIGIN=http://localhost:3000
# Optional — see src/env.ts and .env.example for the full list and defaults:
# LOG_LEVEL=debug
# TRUST_PROXY=false
# JWT_SECRET=   # required in production; development has a built-in default
# R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET / R2_PUBLIC_URL
```

`CORS_ORIGIN` accepts a comma-separated list (`http://localhost:3000,https://staging.example.com`) for
allowing multiple frontend origins at once.

That connection string points at a **local** Postgres database and role created on this dev machine
specifically for this project (not the shared `postgres` superuser, and not Supabase yet):

```sql
-- already run once on this machine; included here so it's reproducible elsewhere
CREATE ROLE unique_accessories WITH LOGIN PASSWORD 'dev_local_only_pw' CREATEDB;
CREATE DATABASE unique_accessories_dev OWNER unique_accessories;
```

`CREATEDB` is granted because `prisma migrate dev` creates a throwaway "shadow database" to detect
drift — see [Prisma's shadow database docs](https://pris.ly/d/migrate-shadow) if you want to avoid
granting that in a shared environment.

**Swapping to Supabase later**: once that project exists (`doc/phases/01-foundation-setup.md`), just
change `DATABASE_URL` to Supabase's connection string (use the pooled/pgbouncer one for the running app,
the direct one for running migrations) — nothing else in this repo changes.

## Getting started

Postgres can be the local instance already on this machine, or:

```bash
docker compose up -d   # Postgres 16 on localhost:5432, matching DATABASE_URL above
```

```bash
pnpm install
pnpm db:migrate   # applies prisma/migrations/ to your database (safe if already applied)
pnpm db:seed      # populates categories/brands/device models/products/coupons
pnpm dev          # tsx watch, http://localhost:4000
```

```bash
pnpm build             # compile to dist/
pnpm start              # run the compiled build
pnpm lint               # eslint .
pnpm typecheck          # tsc --noEmit — covers src/, prisma/seed.ts and prisma.config.ts
pnpm db:studio          # visual DB browser at http://localhost:5555
pnpm db:status          # prisma migrate status — check for pending/drifted migrations
pnpm db:migrate:deploy  # prisma migrate deploy — non-interactive, for CI/production
pnpm db:reset           # ⚠ drops and recreates the database, then reseeds
pnpm r2:upload-test    # uploads a 1×1 PNG once all R2_* env vars are set
```

Check it's alive (should show `"db":"connected"`):

```bash
curl http://localhost:4000/health
# {"status":"ok","db":"connected","uptime":...,"timestamp":"..."}
```

## What's here

- `prisma/schema.prisma` — the full schema from `doc/phases/02-database-schema.md`, plus a handful of
  deliberate additions (see that doc's "Implementation Notes" section for the full list and reasoning:
  denormalized rating fields, `colorHex`, proper `Cart`↔`User` and `WishlistItem`↔`Product` relations,
  a `CouponType` enum, extra indexes, explicit `Decimal(10,2)` on money fields).
- `prisma.config.ts` — **Prisma 7 moved the connection URL out of `schema.prisma`** into this file. If
  you're used to older Prisma, this is the biggest structural change to know about.
- `prisma/seed-data/*.json` — a copy of the frontend's mock catalog
  (`unique-accessories-fe/src/data/*.json`), copied rather than imported across repos since the two are
  separate git repos. Every id/slug matches the frontend exactly.
- `prisma/seed.ts` — seeds taxonomy + the full product catalog + coupons + demo reviewer accounts from
  that data. Upserts everything by a stable id, so it's safe to re-run.
- `src/lib/prisma.ts` — the Prisma Client singleton. **Prisma 7 requires an explicit driver adapter**
  (`@prisma/adapter-pg` here) — `new PrismaClient()` with no arguments throws now.
- `src/env.ts` — Zod-validated environment variables, loaded from `.env` via `dotenv/config`.
- `src/app.ts` — the Fastify instance: CORS, Helmet, rate limiting, structured error/404 handlers,
  request-id correlation, log redaction, and `/health` (does a live `SELECT 1` against Postgres).
- `src/index.ts` — starts the server and handles `SIGTERM`/`SIGINT` for a graceful shutdown.
- `.github/workflows/ci.yml` — lint + typecheck + build on every push/PR (no live DB in CI — see the
  comment in that file for what would need to change to also run migrations against a real database).

## Production-readiness basics already in place

- **Graceful shutdown**: `SIGTERM`/`SIGINT` trigger `app.close()`, which runs Fastify's `onClose` hooks
  (including disconnecting Prisma) before the process exits — no requests get dropped mid-flight, no
  leaked DB connections on redeploy.
- **Rate limiting**: `@fastify/rate-limit`, 100 requests/minute per IP, applied globally.
- **Structured errors**: a central `setErrorHandler` and `setNotFoundHandler` return a consistent
  `{ error: { message, statusCode } }` shape; internal error messages are hidden in production.
- **Request correlation**: honors an inbound `x-request-id` header (falls back to a generated UUID) via
  `genReqId`, for tracing requests across services later.
- **Log redaction**: `Authorization`/`Cookie`/`Set-Cookie` are pre-configured to redact in logs, ahead of
  Phase 3 auth introducing them.

## Prisma 7 gotchas hit while building this (worth knowing before touching the schema)

- `prisma`'s npm `latest` tag currently points at an **8.0.0 release candidate**. This project pins to
  the last stable `7.10.0` for both `prisma` and `@prisma/client` deliberately — don't `pnpm up` these
  without checking the Prisma 8 migration guide first.
- `datasource { url = env("DATABASE_URL") }` in `schema.prisma` is gone — it now lives in
  `prisma.config.ts`'s `datasource.url`.
- `new PrismaClient()` with no options throws `PrismaClientInitializationError` — you must pass an
  `adapter` (see `src/lib/prisma.ts`).
- `pnpm typecheck` runs against `tsconfig.typecheck.json`, not `tsconfig.json` — the latter is scoped to
  `src/**/*.ts` only (so `pnpm build` doesn't try to emit `prisma/seed.ts` into `dist/`), which silently
  excluded `prisma.config.ts` and `prisma/seed.ts` from type checking until this was added.

## Other gotchas hit while building this

- **`typescript-eslint` does not support TypeScript 7** (`typescript`'s npm `latest` tag, like Prisma's,
  currently points at a 7.x that's a ground-up rewrite — see the
  [TS 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)). This
  repo pins `typescript` to the stable `^5.9.3` line so ESLint's type-aware tooling works. If you bump
  `typescript`, run `pnpm lint` before trusting the result.
- **Register Fastify plugins with `await`, not fire-and-forget.** `buildApp()` in `src/app.ts` awaits
  every `app.register(...)` call in sequence. This was empirically necessary, not just stylistic:
  registering `@fastify/cors`, `@fastify/helmet`, `@fastify/sensible` and `@fastify/rate-limit` back to
  back *without* awaiting each one caused `@fastify/rate-limit`'s `onRequest` hook to silently never
  attach — no error, it just never rate-limited anything. Awaiting each `register()` call fixed it.
  Worth remembering if a future plugin gets added here and its effects seem to silently not apply.

## Next steps (in plan order)

1. [Phase 3 — Auth](../doc/phases/03-authentication-user-management.md): verify Supabase JWTs in a
   Fastify `preHandler`, mirror the user into the `User` table (already modeled).
2. [Phase 4 — Product catalog](../doc/phases/04-product-catalog-management.md): build the real
   `/products`, `/categories` etc. endpoints — the catalog data to serve is already seeded — and switch
   `unique-accessories-fe/src/lib/data.ts` from reading local JSON to calling this API.
3. Create the real Supabase project and repoint `DATABASE_URL` at it (see above).

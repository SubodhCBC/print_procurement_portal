# Ticket-IT Portal — Backend

Multi-tenant B2B web-to-print and procurement platform. NestJS API backed by
PostgreSQL, Redis and S3-compatible object storage.

> **Status: infrastructure scaffold.** The platform skeleton — config, logging,
> persistence, queues, security, health, CI, containers — is in place and
> verified end to end. No domain functionality has been written yet; the
> database schema is intentionally empty.

---

## Quick start

```bash
npm install
cp .env.example .env
npm run infra:up          # postgres, redis, minio, mailpit in Docker
npm run db:generate       # generate the Prisma client
npm run db:deploy         # apply migrations
npm run start:dev         # :3000
```

Verify:

```bash
curl http://localhost:3000/health/ready
open http://localhost:3000/api/docs
```

Requires Node 22+, npm 10+ and Docker.

---

## Layout

```
src/
  main.ts                  Bootstrap: adapter, logger, Sentry, listen
  bootstrap.ts             Helmet/CORS/prefix/versioning/Swagger — shared with the e2e suite
  app.module.ts            Root module

  config/                  Environment management
    configuration.ts       Typed config factory
    validation.schema.ts   Zod schema + production hardening rules
    config.module.ts       Publishes AppConfig to the DI container
    dotenv.ts              File load order
    env/                   Committed per-environment defaults (no secrets)

  common/                  Cross-cutting concerns
    decorators/ guards/ interceptors/ filters/ pipes/ middleware/
    interfaces/            RequestContext, ErrorEnvelope, pagination
    constants/             Error codes
    exceptions/            AppError hierarchy
    context/               AsyncLocalStorage request context
    utils/                 Money, ids, Swagger setup

  database/
    database.module.ts     Global Prisma module
    prisma.service.ts      Lifecycle-managed client
    prisma-client.factory.ts
    tenant-scope.ts        withTenantScope() — RLS session variable
    prisma/schema.prisma
    migrations/
    seeds/

  modules/                 Feature modules (auth, users, catalog, orders, …)

  shared/                  Shared business services
    logger/                Pino module + Sentry
    cache/                 Redis connection factory
    queue/                 BullMQ queues, retry policies
    mailer/

  health/                  Terminus probes (+ indicators/)

test/e2e/                  End-to-end suite
scripts/                   One-off operational scripts
docker/                    Dockerfile, dev and prod compose
```

Path alias: `@/*` → `src/*` (declared in `tsconfig.json`, rewritten to relative
paths by `nest build`).

## Commands

| Command                                                                      | What it does                               |
| ---------------------------------------------------------------------------- | ------------------------------------------ |
| `npm run start:dev`                                                          | Watch mode                                 |
| `npm run build` / `npm run start:prod`                                       | `nest build` / run `dist/main.js`          |
| `npm run lint` / `npm run typecheck`                                         | Type-aware ESLint / `tsc --noEmit`         |
| `npm test` / `npm run test:e2e`                                              | Unit tests / end-to-end (needs `infra:up`) |
| `npm run infra:up` / `infra:down` / `infra:reset`                            | Local dependency stack                     |
| `npm run db:generate` / `db:migrate` / `db:deploy` / `db:studio` / `db:seed` | Prisma workflows                           |
| `npx tsx scripts/check-env.ts`                                               | Validate an environment without booting    |

New feature modules use the Nest CLI: `nest g module modules/orders`.

## TypeScript configuration

`tsconfig.json` is the editor/lint/typecheck project; `tsconfig.build.json` is
what `nest build` compiles. Four choices worth knowing about:

- **`include` carries `*.config.ts`.** Without it `prisma.config.ts` and
  `vitest.config.ts` sit outside the project, and both the editor and ESLint
  report _"file not found by the project service"_ and silently stop
  type-checking them.
- **`tsBuildInfoFile` points outside `dist/`.** `nest build` runs with
  `deleteOutDir`, so a cache stored in `dist` was destroyed on every build and
  `incremental` never reused anything.
- **`declaration: false`.** This is an application, not a published library —
  `.d.ts` output is dead weight.
- **No `baseUrl`.** It is deprecated and stops working in TypeScript 7. Since
  TS 4.1 `paths` resolves relative to the tsconfig's own directory, so
  `"@/*": ["./src/*"]` needs no base directory — and `nest build` still rewrites
  the alias to a relative `require()` in the emitted JavaScript.
- **No `$schema` key.** The schemastore URLs answer with a 301 redirect, which
  the editor's schema loader fails on behind a proxy — it surfaces as a red
  error on line 2. VS Code already ships the tsconfig schema natively.
- **`module` / `moduleResolution` are both `nodenext`.** The old `"node"` value
  is TypeScript's deprecated alias for `node10`, which predates package.json
  `exports` maps — under it, packages that publish their types only through
  `exports` (Sentry v8 and a growing number of others) resolve to `any` or fail
  outright. `nodenext` reads them correctly. Emit is unchanged: `package.json`
  declares `"type": "commonjs"`, so every file still compiles to `require()`,
  which is what Nest's decorator/DI runtime needs.

Both files are strict JSON (no `//` comments) so that any tool reading them —
not only TypeScript, which tolerates JSONC — can parse them.

## Configuration

Values resolve in this order, first one wins:

```
process env  >  .env.local  >  .env  >  src/config/env/.env.<APP_ENV>
```

`src/config/env/*` is committed and holds **non-secret defaults only** — ports,
log levels, feature flags. Secrets live in the git-ignored root `.env` locally
and in the secret manager in every deployed environment. `validation.schema.ts`
refuses to boot production with a placeholder secret, a wildcard CORS
allowlist, Swagger exposed or the demo role switcher on.

## Local services

| Service       | Host port                  | Notes                                                                                                                                                  |
| ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL 16 | **55432**                  | Non-standard on purpose — 5432/5433 are frequently taken by a locally installed PostgreSQL, which wins the binding and produces a confusing auth error |
| Redis 7       | 6379                       | AOF on, `noeviction` — queued jobs must survive a restart                                                                                              |
| MinIO         | 9000 (API), 9001 (console) | Bucket `ticketit-assets` created automatically                                                                                                         |
| Mailpit       | 1025 (SMTP), 8025 (UI)     | Every outbound email lands here locally                                                                                                                |

---

## Design decisions

Short version of the reasoning behind the parts that are expensive to change later.

**Modular monolith.** Ordering, stock reservation and webhook dispatch have to
stay consistent inside one transaction; splitting them across services buys
distributed-transaction problems and no benefit at this size. Module boundaries
under `src/modules` are kept clean so a module _can_ be extracted later.

**Queue consumers run in-process for now.** A separate worker entry point
(`src/worker.main.ts`, same `src/` tree, different bootstrap) is the cheap way
to isolate them later — worth doing before the PDF render pipeline lands, since
a headless browser's memory profile should not be able to stall the API. Ordering, stock reservation and webhook dispatch have to stay
consistent inside one transaction; splitting them across services buys
distributed-transaction problems and no benefit at this size. Module boundaries
are kept clean so a module _can_ be extracted later.

**Tenant isolation in three layers.** (1) request context carries the account,
(2) application-level scoping applies it, (3) PostgreSQL Row-Level Security
enforces it at the database. A forgotten `where` clause in a multi-tenant system
is a data breach, so it cannot be the only thing standing between two customers'
data. `withTenantScope()` in `src/database/tenant-scope.ts` opens the scoped transaction.

> Status: layer 1 (request context) and the scoping helper exist. The RLS
> policies land with the first models — until then this is one layer, not three.

**Money as integer minor units.** `0.1 + 0.2 !== 0.3`; rate-card discounts,
volume tiers and tax compound that error into invoice disputes. Money columns are
`NUMERIC(12,2)`; in-process arithmetic goes through `Money` in `src/common/utils/money.ts`.

**Configuration validated at boot.** `src/config` parses the environment
once with Zod and reports _every_ problem at startup, then refuses to start in
production with a demo role switcher, a placeholder secret, a wildcard CORS
allowlist or Swagger exposed. Nothing reads `process.env` directly — ESLint
enforces it.

**One error envelope.** Every failure leaves through `AllExceptionsFilter` as
`{ error: { code, message, details }, meta: { requestId, timestamp, path } }`.
Clients branch on the stable `code`, never on the message.

**Rate limiting in Redis.** In-memory counters are per process, so three replicas
turn a 10-attempt login limit into 30. A rate limit is a security control.

**Cursor pagination.** Offset pagination degrades on large catalogs and skips
rows when data shifts between pages.

**Queues before jobs.** Queue names, retry policies and dead-letter behaviour are
declared up front so dashboards and alerts exist before the first job ships.
Outbound integrations will use a transactional outbox: a webhook fired inside a
transaction that later rolls back leaves a phantom order in the partner system.

---

## What is deliberately not here yet

| Area                                       | Why                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Domain models in `schema.prisma`           | Land per module, with their RLS policies and indexes                                             |
| Auth module                                | Next up; the JWT/refresh config surface is already defined                                       |
| Integration adapters (PrintFlow, 3PL, ERP) | Partner API contracts are unknown — writing speculative interfaces now would guarantee a rewrite |
| Payment gateway                            | Unresolved with the client: is "Net 30 / P-Card / ACH" a selector, or real processing?           |
| Template render pipeline                   | Needs the print spec (ICC profile, bleed, font licensing)                                        |

---

## Conventions

- **Commits** — imperative mood, scoped: `feat(orders): …`, `fix(pricing): …`
- **Migrations** — expand → backfill → contract, never destructive in one deploy
- **Public ids** — prefixed and opaque (`ord_01j9x…`), never raw primary keys
- **Deletes** — never hard; `deletedAt` plus a status enum, because orders
  reference historical products
- **Timestamps** — `timestamptz`, stored UTC, formatted at the edge

## CI

`.github/workflows/ci.yml` runs format check → lint → typecheck → migrate →
migration drift check → unit tests → e2e → build, against real PostgreSQL and
Redis service containers, then builds the API image on `main`.

> Local `docker build` fails on this machine because a network proxy blocks
> Debian package repositories inside containers (`apt-get` returns 403). The
> Dockerfiles are unaffected on CI runners.

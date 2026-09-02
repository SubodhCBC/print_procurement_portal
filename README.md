# Ticket-IT Portal — Backend

Multi-tenant B2B web-to-print and procurement platform. NestJS API backed by
PostgreSQL, Redis and S3-compatible object storage, with authentication bridged
from the legacy Ticket-IT SQL Server database.

> **Status: infrastructure, identity and access control.** The platform skeleton
> — config, logging, persistence, queues, object storage, mail, security, health,
> CI, containers — is in place and verified end to end. Authentication works
> across both databases (see **Design decisions**); users are provisioned from
> the legacy system on first login, or invited directly into the portal. Tenant
> isolation is enforced by PostgreSQL Row-Level Security, and every route is
> guarded by role and permission, and every mutation is recorded in an
> immutable audit trail. The product catalogue is in place. The remaining domain
> modules — rate cards, cart and checkout, orders, approvals, templates, billing
> — have not been written yet.
> `docs/IMPLEMENTATION_GAP_ANALYSIS.md` is the backlog and tracks what is left.

---

## Quick start

```bash
npm install
cp .env.example .env
npm run infra:up          # postgres, redis, minio, mailpit in Docker
npm run db:generate       # generate both Prisma clients (portal + legacy)
npm run db:deploy         # apply migrations to the portal database
npm run start:dev         # :3000
```

Set `LEGACY_DATABASE_URL` in `.env` before first use — it is required at boot,
and first-time logins are verified against it. See **Design decisions** below.

Verify:

```bash
curl http://localhost:3000/health/ready         # portal database + redis
curl http://localhost:3000/health/dependencies  # also the legacy database
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
    decorators/            @Public, @Roles, @RequirePermissions
    authorization/         Permission catalog + role baseline
    guards/ filters/ pipes/ middleware/
    interfaces/            RequestContext, ErrorEnvelope, pagination
    constants/             Error codes
    exceptions/            AppError hierarchy
    context/               AsyncLocalStorage request context
    utils/                 Money, ids, Swagger setup

  database/
    database.module.ts     Global Prisma module (both databases)
    prisma.service.ts      Lifecycle-managed client — portal PostgreSQL
    prisma-client.factory.ts
    tenant-scope.ts        withTenantScope() — RLS session variable + role
    legacy/                Legacy SQL Server connection, READ-ONLY
      legacy-prisma.service.ts
      read-only.extension.ts   Throws on every mutating operation
    prisma/schema.prisma          Portal schema (authored)
    prisma/legacy/schema.prisma   Legacy schema (introspected, never edited)
    migrations/
    seeds/

  modules/
    auth/                  Two-database authentication — see below
      auth.service.ts          The login flow
      legacy-user.repository.ts  Only class that reads legacy
      user-provisioning.service.ts  Legacy -> portal replication
      token.service.ts         JWT access + revocable refresh
      password/                Argon2id + legacy hash verification
      role-mapping.ts          Legacy roles/clients -> portal roles/accounts
    authorization/         Effective permissions + the global guard
    accounts/              Tenant administration (ADMIN only)
    audit/                 Immutable audit trail — every module writes to it
    sites/                 Branches, addresses, budget and PO rules
    users/                 Invitations, password reset, user administration
    catalog/               Products, categories, variants, volume pricing,
                           queued bulk import, image derivatives
                           (global data — see the note in catalog.module.ts)
    pricing/               Rate cards and contract pricing. Tenant-owned and
                           policied, unlike the catalog it prices.
    cart/                  Baskets and checkout validation. Stores no prices —
                           a basket is re-priced through pricing/ on every read.
    orders/                The order lifecycle. The opposite of the cart:
                           every price and address is snapshotted at placement.
    approvals/             Configurable approval rules and multi-tier routing.
                           Writes order rows directly, so a decision and the
                           status it produces commit together.

  shared/                  Shared business services
    logger/                Pino module + Sentry
    cache/                 Redis connection factory
    queue/                 BullMQ queues, retry policies
    mailer/                SMTP transport, templates, EMAIL queue consumer
    storage/               S3/MinIO objects and presigned URLs

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
| `npm run legacy:pull`                                                        | Re-introspect the legacy schema            |
| `npx tsx scripts/verify-legacy-login.ts <login> <password>`                  | Check one credential against legacy        |

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

## Access control

Three layers, in the order a request meets them.

**Authentication.** `JwtAuthGuard` is global: every route is authenticated unless
it declares `@Public()`. Opting routes _out_ rather than _in_ means a new endpoint
is protected by default instead of staying open until somebody remembers it.

**Authorization.** `AuthorizationGuard` runs immediately after it and enforces
whatever `@Roles(...)` and `@RequirePermissions(...)` the handler declares. Both
are registered in `AuthModule`, in that order, because Nest orders global guards
by provider registration and that order is only deterministic inside one module.

The role -> permission baseline is code, in
`src/common/authorization/permissions.ts` — a product decision that belongs in
review and in tests, not in a table an operator can edit into a privilege
escalation. The database stores only the departures from it, in
`user_permission_grants`: ALLOW or DENY, optionally narrowed to a single
`resourceId`, which is how an external user is given access to one document. DENY
always beats ALLOW.

External users keep the `SITE_USER` role but get a closed four-permission baseline
that ignores the role entirely, so they never inherit a site user's ordering and
catalog rights.

```ts
@Post()
@RequirePermissions(Permission.SITE_MANAGE)
async create(@CurrentUser() actor: AuthenticatedActor, @Body(...) body: CreateSiteDto) { … }
```

`GET /users/me/permissions` returns the caller's effective set for the frontend to
render navigation from. It is a convenience, never the enforcement point.

**Tenant isolation.** `withTenantScope(prisma, accountId, fn)` opens a transaction,
sets `app.current_account_id`, and assumes the unprivileged `ticketit_app` role for
the duration — which is what subjects the queries inside it to the Row-Level
Security policies. Outside a scope the connection is the table owner and is exempt,
which is deliberate: login has to read `users` before it knows the tenant.

```ts
return withTenantScope(this.prisma, accountId, (tx) => tx.site.findMany());
```

Application-level `where: { accountId }` is still the first line of defence. RLS is
the second, for the day somebody forgets it. `test/e2e/tenant-isolation.e2e-spec.ts`
proves it holds — including that an unfiltered query, a lookup by a known primary
key, and a cross-tenant insert all fail.

**Every new tenant-owned table must add its own policy.** See
`src/database/migrations/20260103000100_row_level_security/migration.sql` for the
template and for why `FORCE ROW LEVEL SECURITY` was not used.

---

## Design decisions

Short version of the reasoning behind the parts that are expensive to change later.

**Two databases, one direction of travel.** Authentication spans the legacy
Ticket-IT database (Azure SQL Server, `LEGACY_DATABASE_URL`) and the portal's own
PostgreSQL (`DATABASE_URL`). Legacy is the source of truth for _provisioning_;
the portal database is the source of truth for _authentication_ from the second
login onwards.

```
First login      login ─▶ legacy lookup ─▶ verify legacy hash ─▶ replicate into
                          portal DB (re-hashed with Argon2id) ─▶ issue tokens

Later logins     login ─▶ portal lookup ─▶ verify locally ─▶ issue tokens
                          (legacy is not touched)
```

The legacy connection is read-only and enforced as such: it is generated to its
own Prisma client (`@prisma/legacy-client`) so it cannot be reached through
`PrismaService`, and every mutating operation — including all raw queries and
`$transaction` — throws `LegacyDatabaseReadOnlyError` before hitting the wire.
The SQL login should hold `db_datareader` and nothing more; the code guard
catches the likelier failure, which is someone adding a `create()` in good faith
against the wrong database.

Two details of the legacy schema drove the design, both verified against live
data rather than assumed:

- **`Users.Login` is the credential**, not email — `Users.Email` is not unique
  (159 groups of users share an address), so it cannot identify an account.
- **Two password schemes coexist.** `webpages_Membership.Password` is ASP.NET
  SimpleMembership (PBKDF2-HMAC-SHA1, 1000 iterations) and covers every user;
  `Users.UserPassword` is bcrypt (`$2a$11$`) and covers a subset. Either is
  accepted, because nothing guarantees a password change writes both, and
  trusting one alone would lock out whichever column is stale.

Passwords are re-hashed with Argon2id on the way in rather than copied: the
plaintext is in hand at first login, so every user is upgraded off a 2012-era
hash as they arrive. If the local hash later rejects a password, the login falls
back to legacy once (`LEGACY_AUTH_FALLBACK_ENABLED`) to cover an upstream
password change, then adopts the new password locally.

**Legacy is allowed to be down.** `PrismaService` fails the boot if the portal
database is unreachable; `LegacyPrismaService` only logs. An outage in a system
we do not own degrades first-time logins and nothing else, so it is reported on
`/health/dependencies` but deliberately kept out of `/health/ready`.

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

| Area                                                        | Why                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Order, approval and billing models                          | Land per module, with their RLS policies and indexes                                                          |
| Consumers for the WEBHOOK/BILLING/REPORT/MAINTENANCE queues | `EmailProcessor`, `ImportProcessor` and `DerivativeProcessor` are the pattern; the rest wait on their modules |
| A separate worker entrypoint                                | The three queue consumers run in the API process; moving them out is a deployment change, not a rewrite       |
| Bulk import of legacy `Outlets` into `Site`                 | Which legacy table maps onto a site is still undecided — see the gap analysis                                 |
| Integration adapters (PrintFlow, 3PL, ERP)                  | Partner API contracts are unknown — writing speculative interfaces now would guarantee a rewrite              |
| Payment gateway                                             | Unresolved with the client: is "Net 30 / P-Card / ACH" a selector, or real processing?                        |
| Template render pipeline                                    | Needs the print spec (ICC profile, bleed, font licensing)                                                     |

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

import { getCurrentAccountId } from '@/common';
import type { PrismaClient } from '@prisma/client';

/**
 * PostgreSQL session variable read by every Row-Level Security policy.
 * See src/database/migrations/20260103000100_row_level_security.
 */
export const TENANT_SESSION_VAR = 'app.current_account_id';

/**
 * The unprivileged role the policies are attached to.
 *
 * The portal connects as the role that owns its tables, and PostgreSQL exempts
 * a table's owner from RLS. Assuming this role for the length of the
 * transaction is what subjects the queries inside a tenant scope to the
 * policies; `SET LOCAL` reverts it at commit or rollback, so a pooled
 * connection cannot carry it into the next request.
 *
 * The migration explains at length why this rather than FORCE ROW LEVEL
 * SECURITY — in short, login has to read `users` before it knows the tenant.
 */
export const TENANT_APP_ROLE = 'ticketit_app';

/** Public account ids are prefixed, opaque strings — see createId(). */
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The client handed to an interactive transaction: no nested transactions, no
 * connection management.
 */
export type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * PostgreSQL's four isolation levels.
 *
 * Declared here rather than imported as `Prisma.TransactionIsolationLevel`
 * because that member only exists once `prisma generate` has produced the
 * client. Depending on it makes this file fail to type-check on a fresh clone —
 * and leaves the transaction callback inferred as `any`, which silently
 * disables type checking on every query inside a tenant scope.
 */
export type TransactionIsolationLevel =
  'ReadUncommitted' | 'ReadCommitted' | 'RepeatableRead' | 'Serializable';

export interface TenantScopeOptions {
  /** Milliseconds to wait for a connection from the pool. */
  readonly maxWait?: number;
  /** Milliseconds the transaction may stay open before it is rolled back. */
  readonly timeout?: number;
  readonly isolationLevel?: TransactionIsolationLevel;
}

/**
 * Runs `fn` inside a transaction whose connection has the tenant id set, so
 * RLS policies filter every statement at the database level.
 *
 * The `SET LOCAL` must share a connection with the queries it protects, which
 * Prisma only guarantees inside an interactive transaction — hence the
 * transaction wrapper even for pure reads. This is the second line of defence;
 * the application-level scoping is the first.
 */
export async function withTenantScope<T>(
  prisma: PrismaClient,
  accountId: string,
  fn: (tx: TransactionClient) => Promise<T>,
  options?: TenantScopeOptions,
): Promise<T> {
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    // The variable name is interpolated into set_config; the value is bound as
    // a parameter. Never let an unvalidated id near either.
    throw new Error(`Refusing to open a tenant scope for a malformed account id: ${accountId}`);
  }

  return prisma.$transaction(async (tx: TransactionClient): Promise<T> => {
    // Set the tenant first, while still connected as the owner: a custom GUC is
    // settable by any role, but doing it in this order means the scope is never
    // half-applied — the role is only assumed once the tenant is in place.
    await tx.$executeRawUnsafe(`SELECT set_config('${TENANT_SESSION_VAR}', $1, true)`, accountId);

    // SET LOCAL ROLE takes an identifier, which cannot be a bind parameter.
    // TENANT_APP_ROLE is a module constant, never caller input.
    try {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${TENANT_APP_ROLE}`);
    } catch (error) {
      throw new Error(
        `Could not assume the ${TENANT_APP_ROLE} role, so Row-Level Security would not ` +
          'apply and this query is being refused rather than run unprotected. Check that ' +
          'the 20260103000100_row_level_security migration has been applied and that the ' +
          'connecting user is a member of the role.',
        { cause: error },
      );
    }

    return fn(tx);
  }, options);
}

/**
 * Convenience wrapper that reads the tenant from the ambient request context.
 * Throws rather than silently running unscoped — an unscoped query in a
 * tenant-owned code path is a security bug, not a fallback.
 */
export async function withCurrentTenantScope<T>(
  prisma: PrismaClient,
  fn: (tx: TransactionClient) => Promise<T>,
  options?: TenantScopeOptions,
): Promise<T> {
  const accountId = getCurrentAccountId();
  if (!accountId) {
    throw new Error('withCurrentTenantScope called without an authenticated account in context');
  }
  return withTenantScope(prisma, accountId, fn, options);
}

import { Prisma, type PrismaClient as LegacyPrismaClient } from '@prisma/legacy-client';

/**
 * Thrown when application code attempts to modify the legacy database.
 *
 * Not an AppError: this is never a client's fault and must never be turned into
 * a 4xx. It is a programming error that should crash the request loudly and
 * page someone.
 */
export class LegacyDatabaseReadOnlyError extends Error {
  constructor(operation: string, model?: string) {
    super(
      `Refusing to run "${operation}"${model ? ` on ${model}` : ''} against the legacy database — ` +
        'it is read-only. The legacy system owns this data; replicate what you need into the ' +
        'portal database instead (see src/modules/auth/user-provisioning.service.ts).',
    );
    this.name = 'LegacyDatabaseReadOnlyError';
  }
}

/**
 * Every Prisma operation that can change data.
 *
 * Raw operations are blocked wholesale rather than selectively, because
 * `$queryRaw` is not read-only in any meaningful sense — `$queryRaw\`INSERT …\``
 * runs perfectly well. Allowing reads through a raw escape hatch would leave
 * exactly the hole this extension exists to close, so the legacy client is
 * typed-queries-only. `LegacyPrismaService.ping()` bypasses this deliberately
 * and is the single exception.
 */
const FORBIDDEN_OPERATIONS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
  '$executeRaw',
  '$executeRawUnsafe',
  '$queryRaw',
  '$queryRawUnsafe',
  '$runCommandRaw',
]);

/**
 * The legacy client as the rest of the application is allowed to see it.
 *
 * `$transaction` is omitted along with the lifecycle methods: a transaction
 * hands out a client that this extension does not wrap, which would let a
 * caller write through `tx`. Connection lifecycle belongs to
 * LegacyPrismaService alone.
 */
export type ReadOnlyLegacyClient = Omit<
  ReturnType<typeof applyReadOnly>,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Wraps a legacy client so that every mutating operation throws before it
 * reaches the wire.
 *
 * This is a guard rail, not a security boundary — a determined caller can
 * always reach the base client. The actual boundary is the SQL login, which
 * should hold db_datareader and nothing else. This catches the far more likely
 * failure: someone adds a `create()` in good faith, having forgotten which of
 * the two databases this service is talking to.
 */
export function applyReadOnly(client: LegacyPrismaClient) {
  const extended = client.$extends({
    name: 'legacy-read-only',
    query: {
      // Top-level $allOperations covers model operations *and* raw queries;
      // the per-model hook would miss $executeRaw entirely.
      $allOperations({ model, operation, args, query }) {
        if (FORBIDDEN_OPERATIONS.has(operation)) {
          throw new LegacyDatabaseReadOnlyError(operation, model);
        }
        return query(args);
      },
    },
  });

  // `$transaction` is closed at runtime as well as in the type.
  //
  // Whether a query extension reaches operations on the `tx` client handed to
  // an interactive transaction is Prisma-version-dependent and could not be
  // verified against a live server here. A guard that *might* hold is not a
  // guard, and nothing in the read path needs a transaction against a database
  // this service only reads — so the method is refused outright rather than
  // trusted to be covered.
  return new Proxy(extended, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        return () => {
          throw new LegacyDatabaseReadOnlyError('$transaction');
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

export { Prisma as LegacyPrisma };

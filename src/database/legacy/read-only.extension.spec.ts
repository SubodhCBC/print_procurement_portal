import { PrismaClient as LegacyPrismaClient } from '@prisma/legacy-client';
import { afterAll, describe, expect, it } from 'vitest';
import { applyReadOnly, LegacyDatabaseReadOnlyError } from './read-only.extension';

/**
 * No database is involved. The extension rejects before the query reaches the
 * engine, which is the property being tested: a write must never leave the
 * process, whether or not legacy happens to be reachable.
 */
const base = new LegacyPrismaClient({
  datasources: { db: { url: 'sqlserver://unreachable.invalid:1433;database=none' } },
});
const db = applyReadOnly(base);

afterAll(async () => {
  await base.$disconnect();
});

describe('legacy read-only extension', () => {
  it.each([
    'create',
    'createMany',
    'update',
    'updateMany',
    'upsert',
    'delete',
    'deleteMany',
  ] as const)('blocks users.%s', async (operation) => {
    const call = (db.users as unknown as Record<string, (args: unknown) => Promise<unknown>>)[
      operation
    ];

    await expect(call?.({ where: { Id: 1 }, data: { Email: 'x@y.z' } })).rejects.toBeInstanceOf(
      LegacyDatabaseReadOnlyError,
    );
  });

  it('blocks writes to the membership table that holds the password hashes', async () => {
    await expect(
      db.webpages_Membership.update({
        where: { UserId: 1 },
        data: { Password: 'anything' },
      }),
    ).rejects.toBeInstanceOf(LegacyDatabaseReadOnlyError);
  });

  it('blocks raw queries, including read-shaped ones', async () => {
    // $queryRaw is not read-only in any meaningful sense: `$queryRaw`INSERT …``
    // executes. Leaving it open would defeat the whole extension.
    await expect(db.$queryRawUnsafe('SELECT 1')).rejects.toBeInstanceOf(
      LegacyDatabaseReadOnlyError,
    );
    await expect(db.$executeRawUnsafe('DELETE FROM Users')).rejects.toBeInstanceOf(
      LegacyDatabaseReadOnlyError,
    );
  });

  it('names the operation and model, so the stack trace points somewhere useful', async () => {
    const error: unknown = await db.users
      .create({ data: {} as never })
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LegacyDatabaseReadOnlyError);
    expect((error as Error).message).toContain('create');
    expect((error as Error).message).toContain('Users');
  });

  it('refuses $transaction, which would otherwise hand out an unguarded client', () => {
    // The Omit on ReadOnlyLegacyClient is compile-time only — the underlying
    // object still carries the method, so it is refused at runtime too.
    // Throws on call rather than returning a rejected promise, so the callback
    // never runs and no connection is opened.
    const call = () =>
      (db as unknown as { $transaction: (fn: unknown) => Promise<unknown> }).$transaction(
        async (tx: { users: { create: (args: unknown) => Promise<unknown> } }) =>
          tx.users.create({ data: {} }),
      );

    expect(call).toThrow(LegacyDatabaseReadOnlyError);
  });

  it('still permits reads to be constructed', async () => {
    // Reaches the engine and fails on the unreachable host — not on the guard.
    await expect(db.users.findFirst({ where: { Login: 'someone' } })).rejects.not.toBeInstanceOf(
      LegacyDatabaseReadOnlyError,
    );
  });
});

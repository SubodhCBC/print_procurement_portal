import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@/config';
import { PrismaService, TENANT_APP_ROLE, withTenantScope } from '@/database';
import { createId } from '@/common';

/**
 * Proves Row-Level Security actually isolates tenants.
 *
 * This is the test the 20260103000100_row_level_security migration exists for.
 * Before it, withTenantScope() set a session variable that no policy read, so
 * it enforced nothing while looking exactly as if it did — the failure mode a
 * unit test cannot catch, because the whole mechanism lives in the database.
 *
 * Needs Postgres running (`npm run infra:up`) with migrations applied
 * (`npm run db:deploy`).
 */
describe('tenant isolation (e2e)', () => {
  let prisma: PrismaService;

  const suffix = Date.now().toString(36);
  const accountA = createId('acc');
  const accountB = createId('acc');
  const siteA = createId('sit');
  const siteB = createId('sit');

  beforeAll(async () => {
    loadConfig();
    prisma = new PrismaService();
    await prisma.$connect();

    // Seeded through the unscoped client, which connects as the table owner and
    // is therefore exempt from the policies. That exemption is the reason the
    // login path still works, and it is what the assertions below rely on to
    // set up data that the scoped role must then fail to see.
    await prisma.account.createMany({
      data: [
        {
          id: accountA,
          slug: `rls-a-${suffix}`,
          accountCode: `RLS-A-${suffix}`,
          legacyClient: 'RLS A',
          name: 'RLS A',
        },
        {
          id: accountB,
          slug: `rls-b-${suffix}`,
          accountCode: `RLS-B-${suffix}`,
          legacyClient: 'RLS B',
          name: 'RLS B',
        },
      ],
    });

    await prisma.site.createMany({
      data: [
        { id: siteA, accountId: accountA, code: `A-${suffix}`, name: 'Branch A' },
        { id: siteB, accountId: accountB, code: `B-${suffix}`, name: 'Branch B' },
      ],
    });
  });

  afterAll(async () => {
    await prisma?.site.deleteMany({ where: { id: { in: [siteA, siteB] } } });
    await prisma?.account.deleteMany({ where: { id: { in: [accountA, accountB] } } });
    await prisma?.$disconnect();
  });

  it('shows a tenant its own rows', async () => {
    const sites = await withTenantScope(prisma, accountA, (tx) =>
      tx.site.findMany({ select: { id: true } }),
    );

    expect(sites.map((site) => site.id)).toContain(siteA);
  });

  it("hides another tenant's rows even from an unfiltered query", async () => {
    // Deliberately no `where`. Application-level scoping is the first line of
    // defence; this asserts the second one holds when the first is forgotten,
    // which is the only scenario RLS exists for.
    const sites = await withTenantScope(prisma, accountA, (tx) =>
      tx.site.findMany({ select: { id: true, accountId: true } }),
    );

    expect(sites.map((site) => site.id)).not.toContain(siteB);
    expect(sites.every((site) => site.accountId === accountA)).toBe(true);
  });

  it("hides another tenant's row from a lookup by primary key", async () => {
    const site = await withTenantScope(prisma, accountA, (tx) =>
      tx.site.findUnique({ where: { id: siteB } }),
    );

    // Knowing the id of another tenant's row is not enough to read it.
    expect(site).toBeNull();
  });

  it('shows a tenant only its own account row', async () => {
    const accounts = await withTenantScope(prisma, accountA, (tx) =>
      tx.account.findMany({ select: { id: true } }),
    );

    expect(accounts.map((account) => account.id)).toEqual([accountA]);
  });

  it('refuses to write a row into another tenant', async () => {
    // The policy's WITH CHECK clause. A USING-only policy would leave the more
    // damaging direction — planting a row in someone else's account — open.
    await expect(
      withTenantScope(prisma, accountA, (tx) =>
        tx.site.create({
          data: {
            id: createId('sit'),
            accountId: accountB,
            code: `X-${suffix}`,
            name: 'Should not exist',
          },
        }),
      ),
    ).rejects.toThrow();

    const planted = await prisma.site.findFirst({ where: { code: `X-${suffix}` } });
    expect(planted).toBeNull();
  });

  it("cannot update another tenant's row", async () => {
    const result = await withTenantScope(prisma, accountA, (tx) =>
      tx.site.updateMany({ where: { id: siteB }, data: { name: 'Renamed by A' } }),
    );

    expect(result.count).toBe(0);

    const untouched = await prisma.site.findUnique({ where: { id: siteB } });
    expect(untouched?.name).toBe('Branch B');
  });

  it("cannot delete another tenant's row", async () => {
    const result = await withTenantScope(prisma, accountA, (tx) =>
      tx.site.deleteMany({ where: { id: siteB } }),
    );

    expect(result.count).toBe(0);
    expect(await prisma.site.findUnique({ where: { id: siteB } })).not.toBeNull();
  });

  it('sees nothing at all when the tenant variable is not set', async () => {
    // Fails closed: an unset tenant matches no rows rather than all of them.
    // Reproduced by assuming the role without setting the variable, which is
    // what a future code path that forgot set_config would look like.
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${TENANT_APP_ROLE}`);
      return tx.$queryRaw<{ count: bigint }[]>`SELECT count(*)::bigint AS count FROM sites`;
    });

    expect(Number(rows[0]?.count ?? -1)).toBe(0);
  });

  it('reverts the assumed role when the transaction ends', async () => {
    // SET LOCAL, not SET. If the role leaked past the transaction, the next
    // request on this pooled connection would silently run as the restricted
    // role — and the login lookup, which has no tenant, would start failing.
    await withTenantScope(prisma, accountA, (tx) => tx.site.findMany({ take: 1 }));

    const [row] = await prisma.$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    expect(row?.role).not.toBe(TENANT_APP_ROLE);
  });

  it('refuses a malformed account id rather than interpolating it', async () => {
    await expect(
      withTenantScope(prisma, "acc_1'; DROP TABLE sites; --", (tx) => tx.site.findMany()),
    ).rejects.toThrow(/malformed account id/i);
  });
});

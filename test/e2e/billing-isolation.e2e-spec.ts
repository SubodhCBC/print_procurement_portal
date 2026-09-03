import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@/common';
import { loadConfig } from '@/config';
import { PrismaService, withTenantScope } from '@/database';

/**
 * The billing guarantees that live in the database.
 *
 * An invoice is the one document in this system a customer pays against and a
 * tax authority may later inspect, so the rules that make it trustworthy are
 * held by the database rather than by the service that normally maintains them:
 * a draft has no number, anything issued has one, a void says why, and the
 * numbers themselves have no gaps.
 *
 * Needs Postgres running (`npm run infra:up`) with migrations applied
 * (`npm run db:deploy`).
 */
describe('billing integrity and isolation (e2e)', () => {
  let prisma: PrismaService;

  const suffix = Date.now().toString(36);
  const accountA = createId('acc');
  const accountB = createId('acc');
  const invoiceA = createId('inv');
  const invoiceB = createId('inv');
  const period = '2029-07';

  const draft = (id: string, accountId: string) => ({
    id,
    accountId,
    billingPeriod: period,
    status: 'DRAFT' as const,
    subtotal: '500.00',
    tax: '0',
    total: '500.00',
    orderCount: 2,
    siteCount: 1,
  });

  beforeAll(async () => {
    loadConfig();
    prisma = new PrismaService();
    await prisma.$connect();

    await prisma.account.createMany({
      data: [
        { id: accountA, slug: `bl-a-${suffix}`, accountCode: `BL-A-${suffix}`, name: 'Bill A' },
        { id: accountB, slug: `bl-b-${suffix}`, accountCode: `BL-B-${suffix}`, name: 'Bill B' },
      ],
    });

    await prisma.invoice.create({ data: draft(invoiceA, accountA) });
    await prisma.invoice.create({ data: draft(invoiceB, accountB) });
  });

  afterAll(async () => {
    await prisma?.invoice.deleteMany({ where: { accountId: { in: [accountA, accountB] } } });
    await prisma?.account.deleteMany({ where: { id: { in: [accountA, accountB] } } });
    await prisma?.$disconnect();
  });

  it("hides another account's invoices", async () => {
    // What a competitor spends with the same supplier is about as commercially
    // sensitive as this system gets.
    const invoices = await withTenantScope(prisma, accountA, (tx) =>
      tx.invoice.findMany({ select: { id: true } }),
    );

    expect(invoices.map((invoice) => invoice.id)).toEqual([invoiceA]);
  });

  it("hides another account's invoice from a lookup by primary key", async () => {
    const invoice = await withTenantScope(prisma, accountA, (tx) =>
      tx.invoice.findUnique({ where: { id: invoiceB } }),
    );

    expect(invoice).toBeNull();
  });

  it("cannot alter another account's invoice", async () => {
    const result = await withTenantScope(prisma, accountA, (tx) =>
      tx.invoice.updateMany({ where: { id: invoiceB }, data: { total: '1.00' } }),
    );

    expect(result.count).toBe(0);

    const untouched = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceB } });
    expect(untouched.total.toFixed(2)).toBe('500.00');
  });

  it('refuses a second draft for the same account and period', async () => {
    // Two drafts for one month would leave an operator guessing which to issue.
    await expect(
      prisma.invoice.create({ data: draft(createId('inv'), accountA) }),
    ).rejects.toThrow();
  });

  it('refuses a draft that carries a number', async () => {
    await expect(
      prisma.invoice.update({
        where: { id: invoiceA },
        data: { invoiceNumber: 'INV-2029-000001' },
      }),
    ).rejects.toThrow();
  });

  it('refuses an issued invoice with no number', async () => {
    // The rule that makes "issued" mean something.
    await expect(
      prisma.invoice.update({ where: { id: invoiceA }, data: { status: 'ISSUED' } }),
    ).rejects.toThrow();
  });

  it('accepts an issue that supplies both together', async () => {
    await expect(
      prisma.invoice.update({
        where: { id: invoiceA },
        data: { status: 'ISSUED', invoiceNumber: `INV-2029-${suffix.slice(-6).padStart(6, '0')}` },
      }),
    ).resolves.toMatchObject({ status: 'ISSUED' });
  });

  it('allows a second draft once the first is issued', async () => {
    // The uniqueness rule is partial on DRAFT, so a period can hold an issued
    // invoice and a fresh draft for whatever shipped afterwards.
    const second = createId('inv');

    await expect(prisma.invoice.create({ data: draft(second, accountA) })).resolves.toMatchObject({
      id: second,
    });
  });

  it('refuses a void with no reason', async () => {
    await expect(
      prisma.invoice.update({ where: { id: invoiceA }, data: { status: 'VOID' } }),
    ).rejects.toThrow();
  });

  it('keeps the number on a void, because a missing number is what an audit asks about', async () => {
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceA } });

    const voided = await prisma.invoice.update({
      where: { id: invoiceA },
      data: { status: 'VOID', voidReason: 'Superseded' },
    });

    expect(voided.invoiceNumber).toBe(before.invoiceNumber);
  });

  it('refuses a malformed billing period', async () => {
    await expect(
      prisma.invoice.update({ where: { id: invoiceB }, data: { billingPeriod: '2029-13' } }),
    ).rejects.toThrow();
  });

  it('hands out invoice numbers with no gaps, even concurrently', async () => {
    // The reason this is a counter table and not a sequence: several
    // jurisdictions require invoice numbers to be unbroken, and a sequence does
    // not roll back.
    const year = 2999;
    await prisma.invoiceSequence.deleteMany({ where: { year } });

    const take = () =>
      prisma.$queryRaw<{ lastNumber: number }[]>`
        INSERT INTO "invoice_sequences" ("year", "lastNumber", "updatedAt")
        VALUES (${year}, 1, now())
        ON CONFLICT ("year")
        DO UPDATE SET "lastNumber" = "invoice_sequences"."lastNumber" + 1, "updatedAt" = now()
        RETURNING "lastNumber"`;

    const results = await Promise.all(Array.from({ length: 20 }, take));
    const numbers = results.map((rows) => rows[0]!.lastNumber).sort((a, b) => a - b);

    expect(numbers).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));

    await prisma.invoiceSequence.deleteMany({ where: { year } });
  });
});

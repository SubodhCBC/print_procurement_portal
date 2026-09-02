import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@/common';
import { loadConfig } from '@/config';
import { PrismaService, withTenantScope } from '@/database';

/**
 * The approval guarantees that live in the database.
 *
 * 1. Rules, requests and steps are tenant-isolated. A customer's approval policy
 *    says who signs off on what and at which value — reading another's is
 *    reading their internal delegation of authority.
 *
 * 2. The constraints that stop an unusable rule existing: one with no approver
 *    would strand every order it matched, with nobody able to decide and nothing
 *    to say why.
 *
 * Needs Postgres running (`npm run infra:up`) with migrations applied
 * (`npm run db:deploy`).
 */
describe('approval isolation and integrity (e2e)', () => {
  let prisma: PrismaService;

  const suffix = Date.now().toString(36);
  const accountA = createId('acc');
  const accountB = createId('acc');
  const siteA = createId('sit');
  const siteB = createId('sit');
  const userA = createId('usr');
  const userB = createId('usr');
  const orderA = createId('ord');
  const orderB = createId('ord');
  const ruleA = createId('apr');
  const ruleB = createId('apr');
  const requestA = createId('apq');
  const requestB = createId('apq');
  const stepA = createId('aps');
  const stepB = createId('aps');

  beforeAll(async () => {
    loadConfig();
    prisma = new PrismaService();
    await prisma.$connect();

    await prisma.account.createMany({
      data: [
        { id: accountA, slug: `ap-a-${suffix}`, accountCode: `AP-A-${suffix}`, name: 'Appr A' },
        { id: accountB, slug: `ap-b-${suffix}`, accountCode: `AP-B-${suffix}`, name: 'Appr B' },
      ],
    });

    await prisma.site.createMany({
      data: [
        { id: siteA, accountId: accountA, code: `A-${suffix}`, name: 'Branch A' },
        { id: siteB, accountId: accountB, code: `B-${suffix}`, name: 'Branch B' },
      ],
    });

    await prisma.user.createMany({
      data: [
        {
          id: userA,
          accountId: accountA,
          siteId: siteA,
          userType: 'NEW',
          login: `ap-a-${suffix}`,
          loginDisplay: `ap-a-${suffix}`,
          email: `ap-a-${suffix}@example.test`,
          firstName: 'A',
          lastName: 'User',
          role: 'HEAD_OFFICE',
        },
        {
          id: userB,
          accountId: accountB,
          siteId: siteB,
          userType: 'NEW',
          login: `ap-b-${suffix}`,
          loginDisplay: `ap-b-${suffix}`,
          email: `ap-b-${suffix}@example.test`,
          firstName: 'B',
          lastName: 'User',
          role: 'HEAD_OFFICE',
        },
      ],
    });

    const order = (id: string, accountId: string, siteId: string, userId: string) => ({
      id,
      orderNumber: `ORD-2026-${id.slice(-6)}`,
      accountId,
      siteId,
      placedById: userId,
      placedByName: 'Test',
      placedByEmail: 'test@example.test',
      status: 'PENDING_APPROVAL' as const,
      subtotal: '500.00',
      catalogSubtotal: '500.00',
      total: '500.00',
      billingPeriod: '2026-09',
      shippingSnapshot: {},
    });

    await prisma.order.createMany({
      data: [order(orderA, accountA, siteA, userA), order(orderB, accountB, siteB, userB)],
    });

    await prisma.approvalRule.createMany({
      data: [
        {
          id: ruleA,
          accountId: accountA,
          name: 'A policy',
          tier: 1,
          minTotal: '100.00',
          approverRole: 'HEAD_OFFICE',
        },
        {
          id: ruleB,
          accountId: accountB,
          name: 'B policy — commercially sensitive',
          tier: 1,
          minTotal: '25000.00',
          approverUserId: userB,
        },
      ],
    });

    await prisma.approvalRequest.createMany({
      data: [
        {
          id: requestA,
          accountId: accountA,
          orderId: orderA,
          currentTier: 1,
          totalAtRequest: '500.00',
        },
        {
          id: requestB,
          accountId: accountB,
          orderId: orderB,
          currentTier: 1,
          totalAtRequest: '500.00',
        },
      ],
    });

    await prisma.approvalStep.createMany({
      data: [
        { id: stepA, requestId: requestA, ruleId: ruleA, tier: 1, approverRole: 'HEAD_OFFICE' },
        { id: stepB, requestId: requestB, ruleId: ruleB, tier: 1, approverUserId: userB },
      ],
    });
  });

  afterAll(async () => {
    await prisma?.approvalRequest.deleteMany({
      where: { accountId: { in: [accountA, accountB] } },
    });
    await prisma?.approvalRule.deleteMany({ where: { accountId: { in: [accountA, accountB] } } });
    await prisma?.order.deleteMany({ where: { accountId: { in: [accountA, accountB] } } });
    await prisma?.user.deleteMany({ where: { accountId: { in: [accountA, accountB] } } });
    await prisma?.site.deleteMany({ where: { accountId: { in: [accountA, accountB] } } });
    await prisma?.account.deleteMany({ where: { id: { in: [accountA, accountB] } } });
    await prisma?.$disconnect();
  });

  it("hides another account's approval policy", async () => {
    // Who signs off on what, and above which value, is a customer's internal
    // delegation of authority.
    const rules = await withTenantScope(prisma, accountA, (tx) =>
      tx.approvalRule.findMany({ select: { id: true, name: true } }),
    );

    expect(rules.map((rule) => rule.id)).toEqual([ruleA]);
  });

  it("hides another account's requests", async () => {
    const requests = await withTenantScope(prisma, accountA, (tx) =>
      tx.approvalRequest.findMany({ select: { id: true } }),
    );

    expect(requests.map((request) => request.id)).toEqual([requestA]);
  });

  it("hides another account's steps, which carry no accountId of their own", async () => {
    const steps = await withTenantScope(prisma, accountA, (tx) =>
      tx.approvalStep.findMany({ select: { id: true } }),
    );

    expect(steps.map((step) => step.id)).toEqual([stepA]);
  });

  it("hides another account's step from a lookup by primary key", async () => {
    const step = await withTenantScope(prisma, accountA, (tx) =>
      tx.approvalStep.findUnique({ where: { id: stepB } }),
    );

    expect(step).toBeNull();
  });

  it("cannot decide another account's step", async () => {
    // The WITH CHECK half: approving someone else's order is the damaging
    // direction, and a read-only policy would leave it open.
    const result = await withTenantScope(prisma, accountA, (tx) =>
      tx.approvalStep.updateMany({
        where: { id: stepB },
        data: { status: 'APPROVED', decidedByName: 'Intruder' },
      }),
    );

    expect(result.count).toBe(0);

    const untouched = await prisma.approvalStep.findUniqueOrThrow({ where: { id: stepB } });
    expect(untouched.status).toBe('PENDING');
  });

  it("cannot add a step to another account's request", async () => {
    await expect(
      withTenantScope(prisma, accountA, (tx) =>
        tx.approvalStep.create({
          data: { id: createId('aps'), requestId: requestB, tier: 1, approverRole: 'ADMIN' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a rule that names no approver', async () => {
    // It would match orders and strand every one of them, with nobody able to
    // decide and nothing to say why.
    await expect(
      prisma.approvalRule.create({
        data: { id: createId('apr'), accountId: accountA, name: 'Nobody', tier: 1 },
      }),
    ).rejects.toThrow();
  });

  it('refuses a rule that names two', async () => {
    await expect(
      prisma.approvalRule.create({
        data: {
          id: createId('apr'),
          accountId: accountA,
          name: 'Both',
          tier: 1,
          approverRole: 'HEAD_OFFICE',
          approverUserId: userA,
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses tier zero, which would sort ahead of the first round', async () => {
    await expect(
      prisma.approvalRule.create({
        data: {
          id: createId('apr'),
          accountId: accountA,
          name: 'Tier zero',
          tier: 0,
          approverRole: 'ADMIN',
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses a refusal that gives no reason', async () => {
    await expect(
      prisma.approvalStep.update({ where: { id: stepA }, data: { status: 'REJECTED' } }),
    ).rejects.toThrow();
  });

  it('accepts a refusal that gives one', async () => {
    await expect(
      prisma.approvalStep.update({
        where: { id: stepA },
        data: { status: 'REJECTED', comment: 'Over budget' },
      }),
    ).resolves.toMatchObject({ status: 'REJECTED' });
  });

  it('keeps a step after its rule is deleted', async () => {
    // Retiring a rule must never strand an order halfway through it — which is
    // why `ruleId` is nullable and the approver is snapshotted onto the step.
    await prisma.approvalStep.update({ where: { id: stepA }, data: { ruleId: null } });
    await prisma.approvalRule.delete({ where: { id: ruleA } });

    const step = await prisma.approvalStep.findUniqueOrThrow({ where: { id: stepA } });
    expect(step.approverRole).toBe('HEAD_OFFICE');
  });
});

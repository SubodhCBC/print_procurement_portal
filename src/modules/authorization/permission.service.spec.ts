import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Permission, Role, UserType, type AuthenticatedActor } from '@/common';
import type { PrismaService } from '@/database';
import { PermissionService } from './permission.service';

type GrantRow = {
  permission: string;
  effect: 'ALLOW' | 'DENY';
  resourceId: string | null;
};

function makeActor(overrides: Partial<AuthenticatedActor> = {}): AuthenticatedActor {
  return {
    userId: 'usr_1',
    accountId: 'acc_1',
    role: Role.SITE_USER,
    userType: UserType.EXISTING,
    email: 'jo@example.test',
    sessionId: 'ses_1',
    ...overrides,
  };
}

function makeService(rows: GrantRow[]) {
  const findMany = vi.fn().mockResolvedValue(rows);
  const prisma = { userPermissionGrant: { findMany } } as unknown as PrismaService;
  return { service: new PermissionService(prisma), findMany };
}

describe('PermissionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the role baseline when there are no grants', async () => {
    const { service } = makeService([]);
    const effective = await service.resolve(makeActor());

    expect(effective.has(Permission.ORDER_CREATE)).toBe(true);
    expect(effective.has(Permission.USER_MANAGE)).toBe(false);
  });

  it("scopes the grant query to the actor's account as well as their user id", async () => {
    const { service, findMany } = makeService([]);
    await service.resolve(makeActor());

    // Redundant with userId, and deliberately so: a grant row pointing at
    // another account must not be honoured even if one somehow exists.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'usr_1', accountId: 'acc_1' }),
      }),
    );
  });

  it('adds an account-wide ALLOW to the baseline', async () => {
    const { service } = makeService([
      { permission: Permission.BILLING_VIEW, effect: 'ALLOW', resourceId: null },
    ]);
    const effective = await service.resolve(makeActor());

    expect(effective.has(Permission.BILLING_VIEW)).toBe(true);
  });

  it('removes an account-wide DENY from the baseline', async () => {
    const { service } = makeService([
      { permission: Permission.ORDER_CREATE, effect: 'DENY', resourceId: null },
    ]);
    const effective = await service.resolve(makeActor());

    expect(effective.has(Permission.ORDER_CREATE)).toBe(false);
  });

  it('lets DENY beat ALLOW whichever order the rows arrive in', async () => {
    const forwards = makeService([
      { permission: Permission.BILLING_VIEW, effect: 'ALLOW', resourceId: null },
      { permission: Permission.BILLING_VIEW, effect: 'DENY', resourceId: null },
    ]);
    const backwards = makeService([
      { permission: Permission.BILLING_VIEW, effect: 'DENY', resourceId: null },
      { permission: Permission.BILLING_VIEW, effect: 'ALLOW', resourceId: null },
    ]);

    expect((await forwards.service.resolve(makeActor())).has(Permission.BILLING_VIEW)).toBe(false);
    expect((await backwards.service.resolve(makeActor())).has(Permission.BILLING_VIEW)).toBe(false);
  });

  it('ignores a grant naming a permission this build does not know', async () => {
    const { service } = makeService([
      { permission: 'RETIRED_PERMISSION', effect: 'ALLOW', resourceId: null },
    ]);
    const effective = await service.resolve(makeActor());

    expect(effective.accountWide.has('RETIRED_PERMISSION' as Permission)).toBe(false);
    // ...and does not disturb anything else.
    expect(effective.has(Permission.ORDER_CREATE)).toBe(true);
  });

  describe('resource-scoped grants', () => {
    it('grants one named object without granting the permission generally', async () => {
      const { service } = makeService([
        {
          permission: Permission.EXTERNAL_DOCUMENT_ACCESS,
          effect: 'ALLOW',
          resourceId: 'doc_42',
        },
      ]);
      const effective = await service.resolve(makeActor({ userType: UserType.EXTERNAL }));

      expect(effective.hasOn(Permission.DAM_DOWNLOAD, 'doc_42')).toBe(false);
      expect(effective.hasOn(Permission.EXTERNAL_DOCUMENT_ACCESS, 'doc_42')).toBe(true);
      expect(effective.hasOn(Permission.EXTERNAL_DOCUMENT_ACCESS, 'doc_99')).toBe(true);
    });

    it('lets an account-wide permission satisfy a resource check', async () => {
      // A head-office user who holds DAM_DOWNLOAD outright should not need a
      // grant row per document.
      const { service } = makeService([]);
      const effective = await service.resolve(makeActor({ role: Role.HEAD_OFFICE }));

      expect(effective.hasOn(Permission.DAM_DOWNLOAD, 'doc_42')).toBe(true);
    });

    it('lets a resource-scoped DENY carve one object out of a broad permission', async () => {
      const { service } = makeService([
        { permission: Permission.DAM_DOWNLOAD, effect: 'DENY', resourceId: 'doc_42' },
      ]);
      const effective = await service.resolve(makeActor({ role: Role.HEAD_OFFICE }));

      expect(effective.hasOn(Permission.DAM_DOWNLOAD, 'doc_42')).toBe(false);
      expect(effective.hasOn(Permission.DAM_DOWNLOAD, 'doc_43')).toBe(true);
      expect(effective.has(Permission.DAM_DOWNLOAD)).toBe(true);
    });
  });

  describe('external users', () => {
    it('starts from the closed external list, not the role list', async () => {
      const { service } = makeService([]);
      const effective = await service.resolve(
        makeActor({ role: Role.HEAD_OFFICE, userType: UserType.EXTERNAL }),
      );

      expect(effective.has(Permission.EXTERNAL_DOCUMENT_ACCESS)).toBe(true);
      expect(effective.has(Permission.APPROVAL_ACT)).toBe(false);
      expect(effective.has(Permission.ORDER_CREATE)).toBe(false);
    });

    it('can still be extended one permission at a time', async () => {
      const { service } = makeService([
        { permission: Permission.DAM_DOWNLOAD, effect: 'ALLOW', resourceId: null },
      ]);
      const effective = await service.resolve(makeActor({ userType: UserType.EXTERNAL }));

      expect(effective.has(Permission.DAM_DOWNLOAD)).toBe(true);
      expect(effective.has(Permission.ORDER_CREATE)).toBe(false);
    });
  });

  describe('can()', () => {
    it('checks account-wide when no resource is named', async () => {
      const { service } = makeService([]);
      const actor = makeActor();

      await expect(service.can(actor, Permission.ORDER_CREATE)).resolves.toBe(true);
      await expect(service.can(actor, Permission.USER_MANAGE)).resolves.toBe(false);
    });

    it('checks the named resource when one is given', async () => {
      const { service } = makeService([
        { permission: Permission.DAM_DOWNLOAD, effect: 'DENY', resourceId: 'doc_42' },
      ]);
      const actor = makeActor();

      await expect(service.can(actor, Permission.DAM_DOWNLOAD, 'doc_42')).resolves.toBe(false);
      await expect(service.can(actor, Permission.DAM_DOWNLOAD, 'doc_43')).resolves.toBe(true);
    });
  });
});

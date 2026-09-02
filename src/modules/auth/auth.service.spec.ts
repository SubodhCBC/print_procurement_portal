import type { User } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode, Role } from '@/common';
import type { AppConfig } from '@/config';
import { AuthService } from './auth.service';
import type { LegacyUserRepository, LegacyUserRecord } from './legacy-user.repository';
import type { PasswordHasherService } from './password/password-hasher.service';
import type { TokenService } from './token.service';
import { hashSimpleMembership } from './password/test-helpers';
import type { UserProvisioningService } from './user-provisioning.service';

/**
 * These tests are about *which database is consulted*, which is the whole point
 * of the module. Password hashing and token minting are stubbed; they have
 * their own specs.
 */

const LEGACY_RECORD: LegacyUserRecord = {
  legacyUserId: 4242,
  login: 'JSmith',
  email: 'jsmith@example.test',
  firstName: 'J',
  lastName: 'Smith',
  phone: null,
  client: 'Cellarbrations',
  regionName: 'NSW',
  groupName: null,
  outletId: 7,
  isActive: true,
  isHeadOfficeAdmin: false,
  mustChangePassword: false,
  legacyRoleName: 'Franchisee',
  bcryptHash: null,
  // Valid SimpleMembership hash of 'correct-password', generated in-test below.
  membershipHash: null,
};

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'usr_1',
    identityUserId: '00000000-0000-4000-8000-000000000001',
    accountId: 'acc_1',
    siteId: null,
    userType: 'EXISTING',
    legacyUserId: 4242,
    login: 'jsmith',
    loginDisplay: 'JSmith',
    email: 'jsmith@example.test',
    firstName: 'J',
    lastName: 'Smith',
    phone: null,
    department: null,
    monthlyBudgetCap: null,
    poPrefix: null,
    passwordHash: 'argon2-hash',
    role: Role.SITE_USER,
    status: 'ACTIVE',
    legacyRoleName: 'Franchisee',
    legacyRegionName: 'NSW',
    legacyGroupName: null,
    legacyOutletId: 7,
    isHeadOfficeAdmin: false,
    mustChangePassword: false,
    legacySyncedAt: new Date(),
    legacyFingerprint: 'fp',
    lastLoginAt: null,
    activatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

describe('AuthService — two-database login flow', () => {
  let prisma: { user: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } };
  let legacyUsers: { findByLogin: ReturnType<typeof vi.fn> };
  let hasher: {
    hash: ReturnType<typeof vi.fn>;
    verify: ReturnType<typeof vi.fn>;
    needsRehash: ReturnType<typeof vi.fn>;
  };
  let provisioning: {
    syncFromLegacy: ReturnType<typeof vi.fn>;
    isStale: ReturnType<typeof vi.fn>;
    refreshQuietly: ReturnType<typeof vi.fn>;
    hasChanged: ReturnType<typeof vi.fn>;
  };
  let tokens: {
    issue: ReturnType<typeof vi.fn>;
    rotate: ReturnType<typeof vi.fn>;
    revoke: ReturnType<typeof vi.fn>;
    revokeAllForUser: ReturnType<typeof vi.fn>;
  };
  let service: AuthService;

  const config = {
    legacyDatabase: { authFallbackEnabled: true, userSyncTtlSeconds: 86_400 },
  } as AppConfig;

  beforeEach(() => {
    prisma = { user: { findUnique: vi.fn(), update: vi.fn() } };
    legacyUsers = { findByLogin: vi.fn() };
    hasher = {
      hash: vi.fn().mockResolvedValue('new-argon2-hash'),
      verify: vi.fn().mockResolvedValue(false),
      needsRehash: vi.fn().mockReturnValue(false),
    };
    provisioning = {
      syncFromLegacy: vi.fn().mockResolvedValue(makeUser()),
      isStale: vi.fn().mockReturnValue(false),
      refreshQuietly: vi.fn(),
      hasChanged: vi.fn().mockReturnValue(false),
    };
    tokens = {
      issue: vi.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 }),
      rotate: vi.fn(),
      revoke: vi.fn(),
      revokeAllForUser: vi.fn(),
    };

    service = new AuthService(
      prisma as never,
      legacyUsers as unknown as LegacyUserRepository,
      hasher as unknown as PasswordHasherService,
      provisioning as unknown as UserProvisioningService,
      tokens as unknown as TokenService,
      config,
    );
  });

  describe('first login', () => {
    it('verifies against legacy and replicates the user into the portal database', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      legacyUsers.findByLogin.mockResolvedValue({
        ...LEGACY_RECORD,
        membershipHash: hashSimpleMembership('correct-password'),
      });

      const result = await service.login('JSmith', 'correct-password');

      expect(legacyUsers.findByLogin).toHaveBeenCalledWith('JSmith');
      expect(hasher.hash).toHaveBeenCalledWith('correct-password');
      expect(provisioning.syncFromLegacy).toHaveBeenCalledWith(
        expect.objectContaining({ legacyUserId: 4242 }),
        'new-argon2-hash',
      );
      expect(result.provisioned).toBe(true);
      expect(result.verifiedAgainst).toBe('legacy');
    });

    it('rejects an unknown login and a wrong password identically', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      legacyUsers.findByLogin.mockResolvedValue(undefined);
      const unknown = await service.login('nobody', 'x').catch((e: unknown) => e);

      legacyUsers.findByLogin.mockResolvedValue({
        ...LEGACY_RECORD,
        membershipHash: hashSimpleMembership('correct-password'),
      });
      const wrongPassword = await service.login('JSmith', 'wrong').catch((e: unknown) => e);

      // Same code and same message: anything else enumerates valid logins.
      expect((unknown as { code: string }).code).toBe(ErrorCode.INVALID_CREDENTIALS);
      expect((wrongPassword as { code: string }).code).toBe(ErrorCode.INVALID_CREDENTIALS);
      expect((unknown as Error).message).toBe((wrongPassword as Error).message);
      expect(provisioning.syncFromLegacy).not.toHaveBeenCalled();
    });

    it('does not provision a user who is deactivated upstream', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      legacyUsers.findByLogin.mockResolvedValue({
        ...LEGACY_RECORD,
        isActive: false,
        membershipHash: hashSimpleMembership('correct-password'),
      });

      await expect(service.login('JSmith', 'correct-password')).rejects.toMatchObject({
        code: ErrorCode.FORBIDDEN,
      });
      expect(provisioning.syncFromLegacy).not.toHaveBeenCalled();
    });
  });

  describe('subsequent login', () => {
    it('never touches the legacy database when the local hash verifies', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      hasher.verify.mockResolvedValue(true);

      const result = await service.login('JSmith', 'correct-password');

      // This is the requirement the whole module exists for.
      expect(legacyUsers.findByLogin).not.toHaveBeenCalled();
      expect(result.verifiedAgainst).toBe('portal');
      expect(result.provisioned).toBe(false);
    });

    it('looks the user up by the lowercased login', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      hasher.verify.mockResolvedValue(true);

      await service.login('  JSmith  ', 'correct-password');

      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { login: 'jsmith' } });
    });

    it('refuses a locally deactivated user even with the right password', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ status: 'DISABLED' }));
      hasher.verify.mockResolvedValue(true);

      await expect(service.login('JSmith', 'correct-password')).rejects.toMatchObject({
        code: ErrorCode.FORBIDDEN,
      });
    });
  });

  describe('legacy fallback after an upstream password change', () => {
    it('re-checks legacy and adopts the new password locally', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      hasher.verify.mockResolvedValue(false); // local hash is stale
      legacyUsers.findByLogin.mockResolvedValue({
        ...LEGACY_RECORD,
        membershipHash: hashSimpleMembership('changed-upstream'),
      });

      const result = await service.login('JSmith', 'changed-upstream');

      expect(legacyUsers.findByLogin).toHaveBeenCalledWith('JSmith');
      expect(provisioning.syncFromLegacy).toHaveBeenCalledWith(
        expect.anything(),
        'new-argon2-hash',
      );
      expect(result.verifiedAgainst).toBe('legacy');
    });

    it('rejects without calling legacy when the fallback is disabled', async () => {
      service = new AuthService(
        prisma as never,
        legacyUsers as unknown as LegacyUserRepository,
        hasher as unknown as PasswordHasherService,
        provisioning as unknown as UserProvisioningService,
        tokens as unknown as TokenService,
        { legacyDatabase: { authFallbackEnabled: false, userSyncTtlSeconds: 86_400 } } as AppConfig,
      );
      prisma.user.findUnique.mockResolvedValue(makeUser());
      hasher.verify.mockResolvedValue(false);

      await expect(service.login('JSmith', 'whatever')).rejects.toMatchObject({
        code: ErrorCode.INVALID_CREDENTIALS,
      });
      expect(legacyUsers.findByLogin).not.toHaveBeenCalled();
    });

    it('answers 401, not 503, when legacy is down and the local hash already failed', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      hasher.verify.mockResolvedValue(false);
      legacyUsers.findByLogin.mockRejectedValue(new Error('legacy unreachable'));

      // A wrong password during a legacy outage is still a wrong password;
      // surfacing 503 would make every mistyped password look like an incident.
      await expect(service.login('JSmith', 'wrong')).rejects.toMatchObject({
        code: ErrorCode.INVALID_CREDENTIALS,
      });
    });
  });

  describe('staleness refresh', () => {
    it('picks up an upstream deactivation and revokes existing sessions', async () => {
      const user = makeUser();
      prisma.user.findUnique.mockResolvedValue(user);
      hasher.verify.mockResolvedValue(true);
      provisioning.isStale.mockReturnValue(true);
      legacyUsers.findByLogin.mockResolvedValue({ ...LEGACY_RECORD, isActive: false });

      await expect(service.login('JSmith', 'correct-password')).rejects.toMatchObject({
        code: ErrorCode.FORBIDDEN,
      });
      expect(tokens.revokeAllForUser).toHaveBeenCalledWith(user.id);
    });

    it('still logs the user in when legacy is unreachable during a refresh', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      hasher.verify.mockResolvedValue(true);
      provisioning.isStale.mockReturnValue(true);
      legacyUsers.findByLogin.mockRejectedValue(new Error('legacy unreachable'));

      const result = await service.login('JSmith', 'correct-password');

      expect(result.verifiedAgainst).toBe('portal');
    });

    it('upgrades a hash written under weaker Argon2 parameters', async () => {
      const user = makeUser();
      prisma.user.findUnique.mockResolvedValue(user);
      hasher.verify.mockResolvedValue(true);
      hasher.needsRehash.mockReturnValue(true);
      prisma.user.update.mockResolvedValue(makeUser({ passwordHash: 'new-argon2-hash' }));

      await service.login('JSmith', 'correct-password');

      expect(hasher.hash).toHaveBeenCalledWith('correct-password');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: user.id },
        data: { passwordHash: 'new-argon2-hash' },
      });
    });
  });
});

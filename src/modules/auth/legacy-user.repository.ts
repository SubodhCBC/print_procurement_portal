import { Injectable, Logger } from '@nestjs/common';
import { DependencyUnavailableError } from '@/common';
import { LegacyPrismaService } from '@/database';

/**
 * A legacy user plus everything the portal needs to authenticate and replicate
 * them. Flattened deliberately: nothing outside this file should have to know
 * that the role lives in a join table and the password in a second table with
 * no foreign key to the first.
 */
export interface LegacyUserRecord {
  readonly legacyUserId: number;
  readonly login: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string | null;
  readonly client: string;
  readonly regionName: string | null;
  readonly groupName: string | null;
  readonly outletId: number | null;
  readonly isActive: boolean;
  readonly isHeadOfficeAdmin: boolean;
  readonly mustChangePassword: boolean;
  readonly legacyRoleName: string | null;
  /** `Users.UserPassword` — bcrypt, present for a subset of users. */
  readonly bcryptHash: string | null;
  /** `webpages_Membership.Password` — PBKDF2, present for every user. */
  readonly membershipHash: string | null;
}

/**
 * Reads users out of the legacy database.
 *
 * The only class in the application permitted to query legacy directly. Its
 * client is the read-only one, so a stray write here throws rather than
 * reaching a database this service does not own.
 */
@Injectable()
export class LegacyUserRepository {
  private readonly logger = new Logger(LegacyUserRepository.name);

  constructor(private readonly legacy: LegacyPrismaService) {}

  /**
   * Looks a user up by login.
   *
   * `Users.Login` is unique case-insensitively across all 4432 rows, so this is
   * unambiguous. The comparison is left to SQL Server's default case-insensitive
   * collation rather than lowering both sides, because `LOWER(Login)` would
   * discard the `nci_wi_Users_…` index on the column and turn every login into
   * a table scan.
   */
  async findByLogin(login: string): Promise<LegacyUserRecord | undefined> {
    const trimmed = login.trim();
    if (trimmed.length === 0) return undefined;

    try {
      const user = await this.legacy.db.users.findFirst({
        where: { Login: trimmed },
        include: {
          webpages_UsersInRoles: { include: { webpages_Roles: true } },
        },
      });

      if (!user) return undefined;

      // webpages_Membership has no foreign key to Users, so introspection could
      // not derive a relation — it has to be a second round trip.
      const membership = await this.legacy.db.webpages_Membership.findUnique({
        where: { UserId: user.Id },
        select: { Password: true },
      });

      // Every legacy user holds exactly one role, verified across all 4402 role
      // assignments; taking the first is safe, and mapLegacyRole falls back to
      // the least privileged role when there is none.
      const roleName = user.webpages_UsersInRoles[0]?.webpages_Roles.RoleName ?? null;

      return {
        legacyUserId: user.Id,
        login: user.Login,
        email: user.Email,
        firstName: user.FirstName,
        lastName: user.LastName,
        phone: user.Phone || null,
        client: user.Client,
        regionName: user.RegionName || null,
        groupName: user.GroupName,
        outletId: user.OutletId,
        isActive: user.IsActive,
        isHeadOfficeAdmin: user.IsHeadOfficeAdmin,
        mustChangePassword: user.IsPasswordChangeRequired,
        legacyRoleName: roleName,
        bcryptHash: user.UserPassword,
        membershipHash: membership?.Password ?? null,
      };
    } catch (error) {
      // A legacy outage must not surface as a 401: telling a user their password
      // is wrong when the database is simply unreachable sends them to reset a
      // password that was never the problem.
      this.logger.error(
        `Legacy lookup failed for login "${trimmed}"`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new DependencyUnavailableError('Legacy authentication database', { cause: error });
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import type { Account, Prisma } from '@prisma/client';
import {
  ConflictError,
  createId,
  NotFoundError,
  offsetPage,
  toSkipTake,
  type AuthenticatedActor,
  type OffsetPage,
} from '@/common';
import { PrismaService, withTenantScope } from '@/database';
import { AuditAction, AuditService } from '@/modules/audit';
import type { CreateAccountDto, ListAccountsQueryDto, UpdateAccountDto } from './dto/account.dto';

/** Counts the admin table shows next to each account. */
export type AccountWithCounts = Account & {
  _count: { sites: number; users: number };
};

/**
 * Tenant administration.
 *
 * Two things make this module unlike the others.
 *
 * First, it is the one place that legitimately reads and writes across tenants:
 * listing accounts *is* a cross-tenant operation, so it cannot run inside
 * `withTenantScope`. It is therefore restricted to ADMIN by
 * `Permission.ACCOUNT_MANAGE`, which no customer role holds, and the queries do
 * their own filtering. Writes to a single account still open that account's
 * scope, so RLS covers them.
 *
 * Second, accounts are also created implicitly, by
 * UserProvisioningService, when a legacy user of an unseen `Users.Client` logs
 * in for the first time. Those rows arrive with a slug-derived `accountCode`
 * and no contact details, and an administrator fills the rest in here. That is
 * why creating one by hand has to tolerate the slug already existing.
 */
@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Cross-tenant by definition, so no tenant scope and no RLS. The guard on the
   * controller is the whole protection here — ACCOUNT_MANAGE is ADMIN-only in
   * the role baseline, and this method must never be reachable without it.
   */
  async list(query: ListAccountsQueryDto): Promise<OffsetPage<AccountWithCounts>> {
    const where: Prisma.AccountWhereInput = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { accountCode: { contains: query.search, mode: 'insensitive' } },
              { legacyClient: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const { skip, take } = toSkipTake(query);

    const [items, total] = await Promise.all([
      this.prisma.account.findMany({
        where,
        include: { _count: { select: { sites: true, users: true } } },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.account.count({ where }),
    ]);

    return offsetPage(items, total, query);
  }

  async findById(accountId: string): Promise<AccountWithCounts> {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, deletedAt: null },
      include: { _count: { select: { sites: true, users: true } } },
    });
    if (!account) throw new NotFoundError('Account');
    return account;
  }

  async create(dto: CreateAccountDto, actor: AuthenticatedActor): Promise<AccountWithCounts> {
    const slug = toSlug(dto.accountCode);

    const clash = await this.prisma.account.findFirst({
      where: { OR: [{ accountCode: dto.accountCode }, { slug }] },
      select: { id: true, accountCode: true, slug: true, deletedAt: true },
    });

    if (clash) {
      // The slug is how a legacy login finds its account, so a collision here
      // would silently attach that customer's users to this new row. Refusing
      // is the only safe answer, and the message says which of the two keys
      // collided so the administrator can pick a different code.
      throw new ConflictError(
        clash.accountCode === dto.accountCode
          ? `Account code "${dto.accountCode}" is already in use`
          : `Account code "${dto.accountCode}" collides with the existing account "${clash.slug}"`,
        { details: { accountCode: dto.accountCode } },
      );
    }

    const account = await this.prisma.account.create({
      data: {
        id: createId('acc'),
        slug,
        accountCode: dto.accountCode,
        // Null, not the name: this account has no legacy counterpart, and
        // writing one in would make a later reconciliation match the wrong row.
        legacyClient: null,
        name: dto.name,
        contactEmail: dto.contactEmail ?? null,
        contactPhone: dto.contactPhone ?? null,
        approvalThreshold: dto.approvalThreshold ?? null,
        requirePoNumber: dto.requirePoNumber,
        poPrefix: dto.poPrefix ?? null,
      },
      include: { _count: { select: { sites: true, users: true } } },
    });

    // After the write commits, never before — see AuditService.record().
    await this.audit.record({
      action: AuditAction.ACCOUNT_CREATED,
      entityType: 'ACCOUNT',
      entityId: account.id,
      entityName: account.name,
      accountId: account.id,
      details: { accountCode: account.accountCode, name: account.name },
    });

    this.logger.log(`Created account ${account.id} (${account.accountCode}) by ${actor.userId}.`);
    return account;
  }

  async update(
    accountId: string,
    dto: UpdateAccountDto,
    _actor: AuthenticatedActor,
  ): Promise<AccountWithCounts> {
    const before = await this.findById(accountId);

    const updated = await withTenantScope(this.prisma, accountId, (tx) =>
      tx.account.update({
        where: { id: accountId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.contactEmail !== undefined ? { contactEmail: dto.contactEmail } : {}),
          ...(dto.contactPhone !== undefined ? { contactPhone: dto.contactPhone } : {}),
          ...(dto.approvalThreshold !== undefined
            ? { approvalThreshold: dto.approvalThreshold }
            : {}),
          ...(dto.requirePoNumber !== undefined ? { requirePoNumber: dto.requirePoNumber } : {}),
          ...(dto.poPrefix !== undefined ? { poPrefix: dto.poPrefix } : {}),
        },
        include: { _count: { select: { sites: true, users: true } } },
      }),
    );

    // A status change is logged as its own action rather than folded into
    // `account.updated`, because "who suspended this customer and when" is a
    // question people actually ask, and it should not require reading a diff.
    if (dto.status !== undefined && dto.status !== before.status) {
      await this.audit.record({
        action: AuditAction.ACCOUNT_STATUS_CHANGED,
        entityType: 'ACCOUNT',
        entityId: accountId,
        entityName: updated.name,
        accountId,
        details: { from: before.status, to: dto.status },
      });
    }

    await this.audit.record({
      action: AuditAction.ACCOUNT_UPDATED,
      entityType: 'ACCOUNT',
      entityId: accountId,
      entityName: updated.name,
      accountId,
      details: diff(before, updated),
    });

    return updated;
  }

  /**
   * Soft delete. Invoices, orders and audit entries reference the account, so
   * the row survives; INACTIVE plus `deletedAt` is what stops it being used.
   *
   * The users are deliberately left alone rather than cascaded: deactivating a
   * customer must not silently rewrite hundreds of user rows in a way that a
   * mistaken deactivation cannot be undone from. They cannot sign in anyway
   * once the account is gone from every listing.
   */
  async deactivate(accountId: string): Promise<void> {
    const account = await this.findById(accountId);

    await withTenantScope(this.prisma, accountId, (tx) =>
      tx.account.update({
        where: { id: accountId },
        data: { status: 'INACTIVE', deletedAt: new Date() },
      }),
    );

    await this.audit.record({
      action: AuditAction.ACCOUNT_DEACTIVATED,
      entityType: 'ACCOUNT',
      entityId: accountId,
      entityName: account.name,
      accountId,
    });

    this.logger.log(`Deactivated account ${accountId} (${account.accountCode}).`);
  }
}

/**
 * Mirrors `toAccountSlug` in the auth module, but applied to the account code
 * rather than to a legacy client name.
 *
 * Kept separate rather than shared because the two answer different questions:
 * that one normalises a messy upstream string so repeated logins converge on
 * one account, this one derives an internal key from a code an administrator
 * already typed cleanly. Sharing them would tie the legacy normalisation rules
 * to the admin UI's validation rules, which have no reason to move together.
 */
function toSlug(accountCode: string): string {
  return accountCode
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The fields that actually changed, as `{ field: { from, to } }`. */
function diff(before: Account, after: Account): Record<string, { from: unknown; to: unknown }> {
  const tracked = [
    'name',
    'status',
    'contactEmail',
    'contactPhone',
    'approvalThreshold',
    'requirePoNumber',
    'poPrefix',
  ] as const;

  const result: Record<string, { from: unknown; to: unknown }> = {};

  for (const field of tracked) {
    const from = before[field];
    const to = after[field];
    // String-compared because Decimal instances are never `!==`-equal even when
    // they hold the same value, which would log every field as changed.
    if (String(from) !== String(to)) {
      result[field] = { from: from?.toString() ?? null, to: to?.toString() ?? null };
    }
  }

  return result;
}

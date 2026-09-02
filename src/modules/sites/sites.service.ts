import { Injectable, Logger } from '@nestjs/common';
import type { Address, Prisma, Site } from '@prisma/client';
import { ConflictError, createId, emptyPage, NotFoundError, type CursorPage } from '@/common';
import { PrismaService, withTenantScope, type TransactionClient } from '@/database';
import { AuditAction, AuditService } from '@/modules/audit';
import type {
  AddSiteAddressDto,
  CreateSiteDto,
  ListSitesQueryDto,
  UpdateSiteDto,
} from './dto/site.dto';

export type SiteWithAddresses = Site & { addresses: Address[] };

/**
 * Sites and their addresses.
 *
 * Every method runs inside withTenantScope(), including the ones an ADMIN
 * invokes across accounts — an admin acting on another tenant opens the scope
 * for *that* tenant rather than escaping scoping altogether. Two things follow:
 * Row-Level Security is exercised on the ordinary path rather than only in
 * tests, and a bug in the `where` clause of any query here produces an empty
 * result instead of another customer's branches.
 */
@Injectable()
export class SitesService {
  private readonly logger = new Logger(SitesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(accountId: string, query: ListSitesQueryDto): Promise<CursorPage<SiteWithAddresses>> {
    const where: Prisma.SiteWhereInput = {
      accountId,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { code: { contains: query.search, mode: 'insensitive' } },
              { name: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    return withTenantScope(this.prisma, accountId, async (tx) => {
      // One row more than asked for, so "is there another page" is answered
      // without a second count query over the same predicate.
      const rows = await tx.site.findMany({
        where,
        include: { addresses: { where: { deletedAt: null } } },
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      });

      if (rows.length === 0) return emptyPage<SiteWithAddresses>(query.limit);

      const hasMore = rows.length > query.limit;
      const items = hasMore ? rows.slice(0, query.limit) : rows;

      return {
        items,
        pageInfo: {
          nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
          hasMore,
          limit: query.limit,
        },
      };
    });
  }

  async findById(accountId: string, siteId: string): Promise<SiteWithAddresses> {
    return withTenantScope(this.prisma, accountId, async (tx) => {
      const site = await tx.site.findFirst({
        where: { id: siteId, accountId, deletedAt: null },
        include: { addresses: { where: { deletedAt: null } } },
      });
      if (!site) throw new NotFoundError('Site');
      return site;
    });
  }

  async create(accountId: string, dto: CreateSiteDto): Promise<SiteWithAddresses> {
    const created = await withTenantScope(this.prisma, accountId, async (tx) => {
      await this.assertCodeIsFree(tx, accountId, dto.code);

      const siteId = createId('sit');

      const site = await tx.site.create({
        data: {
          id: siteId,
          accountId,
          code: dto.code,
          name: dto.name,
          monthlyBudget: dto.monthlyBudget ?? null,
          poRequired: dto.poRequired,
          poPrefix: dto.poPrefix ?? null,
          costCentre: dto.costCentre ?? null,
          addresses: {
            create: dto.addresses.map((address) => ({
              id: createId('adr'),
              accountId,
              ...address,
              label: address.label ?? null,
              recipientName: address.recipientName ?? null,
              line2: address.line2 ?? null,
              region: address.region ?? null,
              phone: address.phone ?? null,
            })),
          },
        },
        include: { addresses: true },
      });

      this.logger.log(`Created site ${site.id} (${site.code}) for account ${accountId}.`);
      return site;
    });

    await this.audit.record({
      action: AuditAction.SITE_CREATED,
      entityType: 'SITE',
      entityId: created.id,
      entityName: `${created.code} — ${created.name}`,
      accountId,
      details: {
        code: created.code,
        name: created.name,
        monthlyBudget: created.monthlyBudget?.toString() ?? null,
        poRequired: created.poRequired,
        addressCount: created.addresses.length,
      },
    });

    return created;
  }

  async update(accountId: string, siteId: string, dto: UpdateSiteDto): Promise<SiteWithAddresses> {
    const updated = await withTenantScope(this.prisma, accountId, async (tx) => {
      const existing = await tx.site.findFirst({
        where: { id: siteId, accountId, deletedAt: null },
        select: { id: true },
      });
      if (!existing) throw new NotFoundError('Site');

      return tx.site.update({
        where: { id: siteId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          // `nullish` means "omitted" and "explicitly null" are different
          // requests: the first leaves the budget alone, the second removes the
          // cap. Collapsing them would make an uncapped site unreachable.
          ...(dto.monthlyBudget !== undefined ? { monthlyBudget: dto.monthlyBudget } : {}),
          ...(dto.poRequired !== undefined ? { poRequired: dto.poRequired } : {}),
          ...(dto.poPrefix !== undefined ? { poPrefix: dto.poPrefix } : {}),
          ...(dto.costCentre !== undefined ? { costCentre: dto.costCentre } : {}),
        },
        include: { addresses: { where: { deletedAt: null } } },
      });
    });

    await this.audit.record({
      action: AuditAction.SITE_UPDATED,
      entityType: 'SITE',
      entityId: siteId,
      entityName: `${updated.code} — ${updated.name}`,
      accountId,
      // The requested change, not a computed before/after: the caller sent
      // exactly these fields, and echoing them keeps the entry readable without
      // a second read of the row before the write.
      details: { changes: dto },
    });

    return updated;
  }

  /**
   * Soft delete. A site is referenced by historical orders and invoices, so the
   * row has to survive; deactivating it is what stops new orders being placed
   * against it.
   */
  async deactivate(accountId: string, siteId: string): Promise<void> {
    const site = await this.findById(accountId, siteId);

    await withTenantScope(this.prisma, accountId, async (tx) => {
      const result = await tx.site.updateMany({
        where: { id: siteId, accountId, deletedAt: null },
        data: { status: 'INACTIVE', deletedAt: new Date() },
      });
      if (result.count === 0) throw new NotFoundError('Site');
    });

    await this.audit.record({
      action: AuditAction.SITE_DEACTIVATED,
      entityType: 'SITE',
      entityId: siteId,
      entityName: `${site.code} — ${site.name}`,
      accountId,
    });
  }

  async addAddress(
    accountId: string,
    siteId: string,
    dto: AddSiteAddressDto,
  ): Promise<SiteWithAddresses> {
    const withAddress = await withTenantScope(this.prisma, accountId, async (tx) => {
      const site = await tx.site.findFirst({
        where: { id: siteId, accountId, deletedAt: null },
        select: { id: true },
      });
      if (!site) throw new NotFoundError('Site');

      // Exactly one default per site and kind. Cleared first so the pair can
      // never both be default, which would make the checkout picker's
      // pre-selection non-deterministic.
      if (dto.isDefault) {
        await tx.address.updateMany({
          where: { siteId, kind: dto.kind, deletedAt: null },
          data: { isDefault: false },
        });
      }

      await tx.address.create({
        data: {
          id: createId('adr'),
          accountId,
          siteId,
          ...dto,
          label: dto.label ?? null,
          recipientName: dto.recipientName ?? null,
          line2: dto.line2 ?? null,
          region: dto.region ?? null,
          phone: dto.phone ?? null,
        },
      });

      return tx.site.findFirstOrThrow({
        where: { id: siteId },
        include: { addresses: { where: { deletedAt: null } } },
      });
    });

    await this.audit.record({
      action: AuditAction.SITE_ADDRESS_ADDED,
      entityType: 'SITE',
      entityId: siteId,
      entityName: `${withAddress.code} — ${withAddress.name}`,
      accountId,
      details: { kind: dto.kind, city: dto.city, postcode: dto.postcode, isDefault: dto.isDefault },
    });

    return withAddress;
  }

  /**
   * Resolves a site by its legacy `Outlets.Id`, creating nothing.
   *
   * Used during user provisioning to attach a replicated legacy user to their
   * branch when that branch has already been set up here. Returns null rather
   * than creating a placeholder site: a site carries budget and purchase-order
   * rules that only a human can supply, and inventing one with defaults would
   * silently give a branch an uncapped budget.
   */
  async findIdByLegacyOutletId(accountId: string, legacyOutletId: number): Promise<string | null> {
    const site = await this.prisma.site.findFirst({
      where: { legacyOutletId, accountId, deletedAt: null },
      select: { id: true },
    });
    return site?.id ?? null;
  }

  private async assertCodeIsFree(
    tx: TransactionClient,
    accountId: string,
    code: string,
  ): Promise<void> {
    const clash = await tx.site.findFirst({
      where: { accountId, code },
      select: { id: true, deletedAt: true },
    });

    if (clash) {
      // A soft-deleted site still holds the code, because the unique index
      // covers every row. Say so, rather than letting the caller retry against
      // a constraint error they cannot interpret.
      throw new ConflictError(
        clash.deletedAt
          ? `Site code "${code}" belongs to a deactivated site and cannot be reused`
          : `Site code "${code}" is already in use in this account`,
        { details: { code } },
      );
    }
  }
}

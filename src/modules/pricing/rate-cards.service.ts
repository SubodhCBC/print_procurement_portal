import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RateCard, RateCardStatus } from '@prisma/client';
import {
  BusinessRuleError,
  ConflictError,
  createId,
  NotFoundError,
  offsetPage,
  Role,
  toSkipTake,
  type AuthenticatedActor,
  type OffsetPage,
} from '@/common';
import { PrismaService, withTenantScope } from '@/database';
import { AuditAction, AuditService } from '@/modules/audit';
import type {
  ChangeRateCardStatusDto,
  CreateRateCardDto,
  ListRateCardItemsQueryDto,
  ListRateCardsQueryDto,
  RateCardItemDto,
  SetRateCardItemsDto,
  UpdateRateCardDto,
} from './dto/rate-card.dto';

/** Everything the rate-card detail screen needs, in one read. */
const FULL_RATE_CARD = Prisma.validator<Prisma.RateCardInclude>()({
  account: { select: { id: true, accountCode: true, name: true } },
  items: {
    include: {
      product: {
        select: { id: true, sku: true, name: true, basePrice: true, uom: true, moq: true },
      },
      tiers: { orderBy: { minQuantity: 'asc' } },
    },
    orderBy: { productId: 'asc' },
  },
  _count: { select: { items: true } },
});

export type FullRateCard = Prisma.RateCardGetPayload<{ include: typeof FULL_RATE_CARD }>;
export type RateCardItemRow = FullRateCard['items'][number];

/** The list view: counts, no items. */
const RATE_CARD_SUMMARY = Prisma.validator<Prisma.RateCardInclude>()({
  account: { select: { id: true, accountCode: true, name: true } },
  _count: { select: { items: true } },
});

export type RateCardSummary = Prisma.RateCardGetPayload<{ include: typeof RATE_CARD_SUMMARY }>;

/**
 * Which status changes are allowed.
 *
 * A card never returns to DRAFT once it has been active: orders priced under it
 * reference it, and "draft" would suggest it can still be edited freely. An
 * archived card is final — reviving one would resurrect a contract that has
 * been superseded, and writing a new card is both cheap and auditable.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<RateCardStatus, readonly RateCardStatus[]>> = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['ARCHIVED'],
  ARCHIVED: [],
};

/**
 * Rate card administration (SOW BE-04).
 *
 * ---------------------------------------------------------------------------
 * Tenant scoping, and the one place it is deliberately absent
 * ---------------------------------------------------------------------------
 * Rate cards are tenant-owned and policied — unlike the catalog they price,
 * which is global. Every read and write for a single account opens that
 * account's scope, so RLS covers the ordinary path.
 *
 * The exception is `list()` when an administrator asks for every account's
 * cards, which is what the pricing admin screen does and which no tenant scope
 * can express. That path is the same shape as AccountsService.list(): guarded
 * by PRICING_MANAGE, which no customer role holds, and filtered in the query.
 * A customer calling the same endpoint is pinned to their own account before
 * the query is built — see `resolveScope`.
 */
@Injectable()
export class RateCardsService {
  private readonly logger = new Logger(RateCardsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // --- Reads ------------------------------------------------------------------

  /**
   * The account a request may act on.
   *
   * An administrator may name any account, or none for a cross-tenant list.
   * Everyone else is pinned to their own, whatever they asked for — silently,
   * because a customer supplying someone else's accountId is not a request to
   * be corrected with an error message that confirms the id exists.
   */
  private resolveScope(actor: AuthenticatedActor, requested?: string): string | null {
    if (actor.role !== Role.ADMIN) return actor.accountId;
    return requested ?? null;
  }

  async list(
    actor: AuthenticatedActor,
    query: ListRateCardsQueryDto,
  ): Promise<OffsetPage<RateCardSummary>> {
    const accountId = this.resolveScope(actor, query.accountId);

    // Composed as an AND array rather than one spread object. `activeAt` also
    // constrains `status`, and spreading both into a single object would let it
    // silently overwrite an explicit `status=DRAFT` — the caller would get
    // ACTIVE cards back and no indication their filter had been discarded.
    const clauses: Prisma.RateCardWhereInput[] = [{ deletedAt: null }];

    if (accountId) clauses.push({ accountId });
    if (query.status) clauses.push({ status: query.status });
    if (query.search) {
      clauses.push({ name: { contains: query.search, mode: 'insensitive' } });
    }
    if (query.activeAt) {
      clauses.push({
        status: 'ACTIVE',
        effectiveFrom: { lte: query.activeAt },
        // Exclusive upper bound, matching the `[)` range in the constraint.
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: query.activeAt } }],
      });
    }

    // status=DRAFT with activeAt is now a contradiction rather than a silent
    // rewrite, and correctly returns nothing.
    const where: Prisma.RateCardWhereInput = { AND: clauses };

    const { skip, take } = toSkipTake(query);
    const read = async (client: Prisma.TransactionClient | PrismaService) =>
      Promise.all([
        client.rateCard.findMany({
          where,
          include: RATE_CARD_SUMMARY,
          orderBy: [{ effectiveFrom: 'desc' }, { id: 'asc' }],
          skip,
          take,
        }),
        client.rateCard.count({ where }),
      ]);

    // Cross-tenant only when an administrator asked for it; otherwise scoped,
    // so RLS is exercised on the path customers actually take.
    const [items, total] = accountId
      ? await withTenantScope(this.prisma, accountId, read)
      : await read(this.prisma);

    return offsetPage(items, total, query);
  }

  async findById(actor: AuthenticatedActor, rateCardId: string): Promise<FullRateCard> {
    const accountId = await this.requireReadableAccount(actor, rateCardId);

    const card = await withTenantScope(this.prisma, accountId, (tx) =>
      tx.rateCard.findFirst({
        where: { id: rateCardId, deletedAt: null },
        include: FULL_RATE_CARD,
      }),
    );

    if (!card) throw new NotFoundError('Rate card');
    return card;
  }

  /**
   * One card without its items.
   *
   * For callers that need the card's own terms — its default discount, to price
   * an item row against — and not the price list itself. `findById` includes
   * every item, so using it here would load the whole contract on each page of
   * a paged read and undo the paging entirely.
   */
  async findSummary(actor: AuthenticatedActor, rateCardId: string): Promise<RateCardSummary> {
    const accountId = await this.requireReadableAccount(actor, rateCardId);

    const card = await withTenantScope(this.prisma, accountId, (tx) =>
      tx.rateCard.findFirst({
        where: { id: rateCardId, deletedAt: null },
        include: RATE_CARD_SUMMARY,
      }),
    );

    if (!card) throw new NotFoundError('Rate card');
    return card;
  }

  /**
   * One card's items, paged and searchable.
   *
   * Separate from `findById` because a negotiated price list runs to hundreds
   * of lines and the detail screen pages through them; returning all of them on
   * every card read would make opening the screen the most expensive request in
   * the pricing module.
   */
  async listItems(
    actor: AuthenticatedActor,
    rateCardId: string,
    query: ListRateCardItemsQueryDto,
  ): Promise<OffsetPage<RateCardItemRow>> {
    const accountId = await this.requireReadableAccount(actor, rateCardId);

    const where: Prisma.RateCardItemWhereInput = {
      rateCardId,
      ...(query.search
        ? {
            product: {
              OR: [
                { name: { contains: query.search, mode: 'insensitive' } },
                { sku: { contains: query.search, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    };

    const { skip, take } = toSkipTake(query);

    const [items, total] = await withTenantScope(this.prisma, accountId, (tx) =>
      Promise.all([
        tx.rateCardItem.findMany({
          where,
          include: {
            product: {
              select: { id: true, sku: true, name: true, basePrice: true, uom: true, moq: true },
            },
            tiers: { orderBy: { minQuantity: 'asc' } },
          },
          orderBy: { product: { name: 'asc' } },
          skip,
          take,
        }),
        tx.rateCardItem.count({ where }),
      ]),
    );

    return offsetPage(items, total, query);
  }

  // --- Writes -----------------------------------------------------------------

  async create(dto: CreateRateCardDto, actor: AuthenticatedActor): Promise<FullRateCard> {
    await this.assertAccountExists(dto.accountId);
    await this.assertProductsExist(dto.items);

    const rateCardId = createId('rc');

    const card = await withTenantScope(this.prisma, dto.accountId, async (tx) => {
      await tx.rateCard.create({
        data: {
          id: rateCardId,
          accountId: dto.accountId,
          name: dto.name,
          notes: dto.notes ?? null,
          // Always DRAFT. Activation is its own audited transition — see
          // changeStatus, which is also where the overlap rule is arbitrated.
          status: 'DRAFT',
          effectiveFrom: dto.effectiveFrom,
          effectiveTo: dto.effectiveTo ?? null,
          defaultDiscountPercent: dto.defaultDiscountPercent,
          createdById: actor.userId,
        },
      });

      await this.writeItems(tx, rateCardId, dto.items);

      return tx.rateCard.findFirstOrThrow({
        where: { id: rateCardId },
        include: FULL_RATE_CARD,
      });
    });

    await this.audit.record({
      action: AuditAction.RATE_CARD_CREATED,
      entityType: 'RATE_CARD',
      entityId: card.id,
      entityName: card.name,
      accountId: card.accountId,
      details: {
        defaultDiscountPercent: card.defaultDiscountPercent.toString(),
        effectiveFrom: card.effectiveFrom.toISOString(),
        effectiveTo: card.effectiveTo?.toISOString() ?? null,
        itemCount: card.items.length,
      },
    });

    this.logger.log(`Created rate card ${card.id} for account ${card.accountId}.`);
    return card;
  }

  async update(
    rateCardId: string,
    dto: UpdateRateCardDto,
    _actor: AuthenticatedActor,
  ): Promise<FullRateCard> {
    const before = await this.requireCard(rateCardId);
    this.assertMutable(before);

    const effectiveFrom = dto.effectiveFrom ?? before.effectiveFrom;
    const effectiveTo = dto.effectiveTo === undefined ? before.effectiveTo : dto.effectiveTo;
    if (effectiveTo != null && effectiveTo <= effectiveFrom) {
      throw new BusinessRuleError('The card must end after it starts', {
        details: {
          effectiveFrom: effectiveFrom.toISOString(),
          effectiveTo: effectiveTo.toISOString(),
        },
      });
    }

    const card = await this.runScoped(before.accountId, (tx) =>
      tx.rateCard.update({
        where: { id: rateCardId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.effectiveFrom !== undefined ? { effectiveFrom: dto.effectiveFrom } : {}),
          ...(dto.effectiveTo !== undefined ? { effectiveTo: dto.effectiveTo } : {}),
          ...(dto.defaultDiscountPercent !== undefined
            ? { defaultDiscountPercent: dto.defaultDiscountPercent }
            : {}),
        },
        include: FULL_RATE_CARD,
      }),
    ).catch((error: unknown) => {
      // Moving an ACTIVE card's window onto another live card's is rejected by
      // the same EXCLUDE constraint that guards activation, and deserves the
      // same 409 rather than a raw database error.
      throw this.translateOverlap(error, before);
    });

    await this.audit.record({
      action: AuditAction.RATE_CARD_UPDATED,
      entityType: 'RATE_CARD',
      entityId: rateCardId,
      entityName: card.name,
      accountId: card.accountId,
      details: diff(before, card),
    });

    return card;
  }

  /**
   * DRAFT → ACTIVE → ARCHIVED, and DRAFT → ARCHIVED for a card that was never
   * signed.
   *
   * Activating is the interesting one: the EXCLUDE constraint refuses a second
   * card whose window overlaps an already-active one for the same account, and
   * that rejection is translated here into an explanation rather than a 500. It
   * is a constraint and not a query because two administrators activating two
   * cards in the same second would both pass a read-then-write check and leave
   * the customer with two live contracts.
   */
  async changeStatus(
    rateCardId: string,
    dto: ChangeRateCardStatusDto,
    _actor: AuthenticatedActor,
  ): Promise<FullRateCard> {
    const before = await this.requireCard(rateCardId);

    if (before.status === dto.status) {
      throw new BusinessRuleError(`This rate card is already ${dto.status}`, {
        details: { status: dto.status },
      });
    }

    if (!ALLOWED_TRANSITIONS[before.status].includes(dto.status)) {
      throw new BusinessRuleError(
        `A ${before.status} rate card cannot become ${dto.status}. ` +
          `Allowed from here: ${ALLOWED_TRANSITIONS[before.status].join(', ') || 'nothing'}.`,
        { details: { from: before.status, to: dto.status } },
      );
    }

    const card = await this.runScoped(before.accountId, (tx) =>
      tx.rateCard.update({
        where: { id: rateCardId },
        data: { status: dto.status },
        include: FULL_RATE_CARD,
      }),
    ).catch((error: unknown) => {
      throw this.translateOverlap(error, before);
    });

    await this.audit.record({
      action: AuditAction.RATE_CARD_STATUS_CHANGED,
      entityType: 'RATE_CARD',
      entityId: rateCardId,
      entityName: card.name,
      accountId: card.accountId,
      details: { from: before.status, to: dto.status, reason: dto.reason ?? null },
    });

    this.logger.log(`Rate card ${rateCardId}: ${before.status} -> ${dto.status}.`);
    return card;
  }

  /**
   * Bulk item editor.
   *
   * Upserts the named products and, with `replaceAll`, removes everything else.
   * The whole payload is one transaction: half a price list is worse than none,
   * because the half that landed would start pricing orders immediately.
   */
  async setItems(
    rateCardId: string,
    dto: SetRateCardItemsDto,
    _actor: AuthenticatedActor,
  ): Promise<FullRateCard> {
    const before = await this.requireCard(rateCardId);
    this.assertMutable(before);
    await this.assertProductsExist(dto.items);

    const keep = dto.items.map((item) => item.productId);

    const card = await this.runScoped(before.accountId, async (tx) => {
      if (dto.replaceAll) {
        await tx.rateCardItem.deleteMany({
          where: { rateCardId, productId: { notIn: keep } },
        });
      }

      await this.writeItems(tx, rateCardId, dto.items);

      return tx.rateCard.findFirstOrThrow({ where: { id: rateCardId }, include: FULL_RATE_CARD });
    });

    await this.audit.record({
      action: AuditAction.RATE_CARD_ITEMS_SET,
      entityType: 'RATE_CARD',
      entityId: rateCardId,
      entityName: card.name,
      accountId: card.accountId,
      details: {
        productIds: keep,
        replaceAll: dto.replaceAll,
        itemCount: card.items.length,
      },
    });

    return card;
  }

  async removeItem(
    rateCardId: string,
    productId: string,
    _actor: AuthenticatedActor,
  ): Promise<void> {
    const card = await this.requireCard(rateCardId);
    this.assertMutable(card);

    const deleted = await this.runScoped(card.accountId, (tx) =>
      tx.rateCardItem.deleteMany({ where: { rateCardId, productId } }),
    );

    if (deleted.count === 0) throw new NotFoundError('Rate card item');

    await this.audit.record({
      action: AuditAction.RATE_CARD_ITEM_REMOVED,
      entityType: 'RATE_CARD',
      entityId: rateCardId,
      entityName: card.name,
      accountId: card.accountId,
      details: { productId },
    });
  }

  /**
   * Soft delete.
   *
   * Orders priced under this card reference it, so the row survives; ARCHIVED
   * plus `deletedAt` is what takes it out of pricing. An ACTIVE card is
   * archived on the way out, which also releases its slot in the overlap
   * constraint — otherwise a deleted card would keep blocking its successor.
   */
  async remove(rateCardId: string, _actor: AuthenticatedActor): Promise<void> {
    const card = await this.requireCard(rateCardId);

    await this.runScoped(card.accountId, (tx) =>
      tx.rateCard.update({
        where: { id: rateCardId },
        data: { status: 'ARCHIVED', deletedAt: new Date() },
      }),
    );

    await this.audit.record({
      action: AuditAction.RATE_CARD_DELETED,
      entityType: 'RATE_CARD',
      entityId: rateCardId,
      entityName: card.name,
      accountId: card.accountId,
      details: { statusWas: card.status },
    });

    this.logger.log(`Deleted rate card ${rateCardId} (was ${card.status}).`);
  }

  // --- Internals --------------------------------------------------------------

  /**
   * Writes item rows and their tiers.
   *
   * Tiers are deleted and re-created rather than diffed: a ladder is read as a
   * whole, an update that merged rows would leave a threshold nobody asked for
   * still standing, and there are at most twenty of them.
   */
  private async writeItems(
    tx: Prisma.TransactionClient,
    rateCardId: string,
    items: readonly RateCardItemDto[],
  ): Promise<void> {
    for (const item of items) {
      const existing = await tx.rateCardItem.findUnique({
        where: { rateCardId_productId: { rateCardId, productId: item.productId } },
        select: { id: true },
      });

      const data = {
        fixedPrice: item.fixedPrice ?? null,
        discountPercent: item.discountPercent ?? null,
      };

      const itemId = existing?.id ?? createId('rci');

      if (existing) {
        await tx.rateCardItem.update({ where: { id: existing.id }, data });
        await tx.rateCardTier.deleteMany({ where: { rateCardItemId: existing.id } });
      } else {
        await tx.rateCardItem.create({
          data: { id: itemId, rateCardId, productId: item.productId, ...data },
        });
      }

      if (item.tiers.length > 0) {
        await tx.rateCardTier.createMany({
          data: item.tiers.map((tier) => ({
            id: createId('rct'),
            rateCardItemId: itemId,
            minQuantity: tier.minQuantity,
            discountPercent: tier.discountPercent,
          })),
        });
      }
    }
  }

  /** Runs inside the card's own tenant scope, so RLS applies to every write. */
  private runScoped<T>(
    accountId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return withTenantScope(this.prisma, accountId, fn);
  }

  /**
   * Reads the card outside any scope, purely to learn which account owns it.
   *
   * Deliberately narrow — id, account, status, name and window, never the
   * negotiated numbers — because this is the one read in the module that RLS
   * does not cover, and it exists only to decide which scope to open next.
   */
  private async requireCard(rateCardId: string): Promise<RateCard> {
    const card = await this.prisma.rateCard.findFirst({
      where: { id: rateCardId, deletedAt: null },
    });
    if (!card) throw new NotFoundError('Rate card');
    return card;
  }

  /**
   * The account whose scope a read should open, having checked the actor may
   * see this card at all.
   *
   * A customer asking for someone else's card gets 404, not 403: confirming
   * that a rate card exists for another company is itself a disclosure.
   */
  private async requireReadableAccount(
    actor: AuthenticatedActor,
    rateCardId: string,
  ): Promise<string> {
    const card = await this.requireCard(rateCardId);
    if (actor.role !== Role.ADMIN && card.accountId !== actor.accountId) {
      throw new NotFoundError('Rate card');
    }
    return card.accountId;
  }

  /**
   * An ARCHIVED card is history. Editing one would rewrite the terms an already
   * invoiced order was priced under.
   *
   * ACTIVE cards *are* editable, deliberately: a price correction on a live
   * contract is an ordinary thing to need, and forcing an archive-and-recreate
   * would break the link from existing orders to the card they cite. Every edit
   * is audited, which is what makes that safe.
   */
  private assertMutable(card: RateCard): void {
    if (card.status === 'ARCHIVED') {
      throw new BusinessRuleError(
        'An archived rate card cannot be edited. Create a new card instead.',
        { details: { rateCardId: card.id, status: card.status } },
      );
    }
  }

  private async assertAccountExists(accountId: string): Promise<void> {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, deletedAt: null },
      select: { id: true },
    });
    if (!account) throw new NotFoundError('Account');
  }

  /**
   * Every named product must exist and not be deleted.
   *
   * Checked up front rather than relying on the foreign key, so a 400 naming
   * the bad ids comes back instead of a constraint violation that says only
   * that something failed. Draft products are allowed: a contract is routinely
   * signed before the SKU is published.
   */
  private async assertProductsExist(items: readonly RateCardItemDto[]): Promise<void> {
    if (items.length === 0) return;

    const wanted = [...new Set(items.map((item) => item.productId))];
    const found = await this.prisma.product.findMany({
      where: { id: { in: wanted }, deletedAt: null },
      select: { id: true },
    });

    const missing = wanted.filter((id) => !found.some((product) => product.id === id));
    if (missing.length > 0) {
      throw new BusinessRuleError(
        `${missing.length} of the products on this rate card do not exist`,
        { details: { productIds: missing } },
      );
    }
  }

  /**
   * Turns the EXCLUDE constraint's rejection into something an administrator
   * can act on.
   *
   * Prisma surfaces an exclusion violation as P2010 (raw query failed) rather
   * than as a unique-constraint error, so it is matched on the constraint name,
   * which is the stable part.
   */
  private translateOverlap(error: unknown, card: RateCard): unknown {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('rate_cards_no_overlapping_active')) return error;

    return new ConflictError(
      'Another rate card is already active for this account over part of the same period. ' +
        'Archive it, or change the effective dates so the two do not overlap.',
      {
        details: {
          accountId: card.accountId,
          effectiveFrom: card.effectiveFrom.toISOString(),
          effectiveTo: card.effectiveTo?.toISOString() ?? null,
        },
      },
    );
  }
}

/**
 * The fields that actually changed, as `{ field: { from, to } }`.
 *
 * The tracked list is `as const` so the indexed reads stay typed: these are the
 * only five fields `update` can touch, and a sixth added to the DTO without
 * being added here would otherwise go unlogged.
 */
const TRACKED_FIELDS = [
  'name',
  'notes',
  'effectiveFrom',
  'effectiveTo',
  'defaultDiscountPercent',
] as const;

type TrackedValue = RateCard[(typeof TRACKED_FIELDS)[number]];

function diff(before: RateCard, after: RateCard): Record<string, { from: unknown; to: unknown }> {
  const result: Record<string, { from: unknown; to: unknown }> = {};

  for (const field of TRACKED_FIELDS) {
    const from: TrackedValue = before[field];
    const to: TrackedValue = after[field];
    // String-compared: Decimal and Date instances are never `!==`-equal even
    // when they hold the same value, which would log every field as changed.
    if (serialise(from) !== serialise(to)) {
      result[field] = { from: serialise(from), to: serialise(to) };
    }
  }

  return result;
}

/** Every tracked field is a string, a Date, a Decimal or null. */
function serialise(value: TrackedValue): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return value.toFixed(2);
}

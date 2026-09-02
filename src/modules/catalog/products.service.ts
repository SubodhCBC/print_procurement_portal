import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Product, ProductVariant } from '@prisma/client';
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
import { PrismaService } from '@/database';
import { AuditAction, AuditService } from '@/modules/audit';
import { MailDispatcher } from '@/shared/mailer';
import { StoragePrefix, StorageService } from '@/shared/storage';
import { AssetDerivativeService } from './asset-derivative.service';
import type {
  AdjustStockDto,
  AttachAssetDto,
  ChangeProductStatusDto,
  CreateProductDto,
  CreateVariantDto,
  ListProductsQueryDto,
  PresignAssetUploadDto,
  SetProductOptionsDto,
  SetVisibilityDto,
  SetVolumeTiersDto,
  UpdateProductDto,
  UpdateVariantDto,
} from './dto/product.dto';
import { assertTransition, CUSTOMER_VISIBLE_STATUSES, type ProductStatus } from './product-status';

/**
 * Everything the product detail page needs, in one read.
 *
 * Wrapped in `Prisma.validator` rather than declared `as const`: the latter
 * makes the nested `orderBy` arrays readonly, which Prisma's own input types
 * reject. The validator keeps the literal types that `ProductGetPayload` needs
 * while still type-checking the shape against the schema.
 */
const FULL_PRODUCT = Prisma.validator<Prisma.ProductInclude>()({
  category: { select: { id: true, code: true, name: true } },
  options: { orderBy: { sortOrder: 'asc' } },
  variants: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
  volumeTiers: { orderBy: { minQuantity: 'asc' } },
  assets: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
  supersededBy: { select: { id: true, sku: true, name: true, status: true } },
});

export type FullProduct = Prisma.ProductGetPayload<{ include: typeof FULL_PRODUCT }>;

/**
 * Just enough of a product to price it: the base price, the order rules and
 * the public volume ladder.
 *
 * Deliberately narrow. A quote for a fifty-tile grid would otherwise drag every
 * variant, option and asset row along with it for data no price calculation
 * looks at.
 */
const PRICEABLE_PRODUCT = Prisma.validator<Prisma.ProductSelect>()({
  id: true,
  sku: true,
  name: true,
  status: true,
  basePrice: true,
  moq: true,
  orderMultiple: true,
  packSize: true,
  uom: true,
  volumeTiers: {
    select: { minQuantity: true, discountPercent: true },
    orderBy: { minQuantity: 'asc' },
  },
});

export type PriceableProduct = Prisma.ProductGetPayload<{ select: typeof PRICEABLE_PRODUCT }>;

/**
 * The product catalog.
 *
 * ---------------------------------------------------------------------------
 * Global data, and what that means here
 * ---------------------------------------------------------------------------
 * None of the catalog tables carries an `accountId`, so none of this runs
 * inside `withTenantScope` and none of it is covered by Row-Level Security.
 * That is deliberate — the catalog belongs to the platform operator — but it
 * removes the safety net every other module has.
 *
 * What replaces it is `visibilityFilter()`: the single place that decides which
 * products an actor may see. Every customer-facing read goes through it. A bug
 * there cannot leak one customer's data to another, because there is none in
 * these tables; what it can leak is a RESTRICTED product to an account that has
 * no contract for it, which is why it is one function and not a predicate
 * copied into each query.
 */
@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly derivatives: AssetDerivativeService,
    private readonly mail: MailDispatcher,
  ) {}

  // --- Reads ------------------------------------------------------------------

  /**
   * Which products this actor may see.
   *
   * An administrator sees the whole catalog including drafts, because building
   * the catalog is their job. Everyone else sees published products that are
   * either unrestricted or explicitly granted to their account.
   *
   * The `visibleTo: { some: ... }` arm is an EXISTS subquery on
   * `product_account_visibility`, which is indexed on accountId — so a
   * restricted catalog does not cost a scan.
   */
  private visibilityFilter(actor: AuthenticatedActor): Prisma.ProductWhereInput {
    if (actor.role === Role.ADMIN) return {};

    return {
      status: { in: CUSTOMER_VISIBLE_STATUSES as unknown as ProductStatus[] },
      OR: [
        { visibility: 'ALL_ACCOUNTS' },
        { visibility: 'RESTRICTED', visibleTo: { some: { accountId: actor.accountId } } },
      ],
    };
  }

  async list(
    actor: AuthenticatedActor,
    query: ListProductsQueryDto,
  ): Promise<OffsetPage<FullProduct>> {
    // Composed as an AND array rather than one spread object. Both the
    // visibility filter and the search filter contribute a top-level `OR`, and
    // spreading them into a single object would silently drop the first — the
    // search would then widen the result past what the actor may see.
    const clauses: Prisma.ProductWhereInput[] = [{ deletedAt: null }, this.visibilityFilter(actor)];

    if (query.categoryId) clauses.push({ categoryId: query.categoryId });
    // A non-admin asking for DRAFT gets an empty page rather than an error: the
    // visibility clause already excludes it, and the two simply intersect.
    if (query.status) clauses.push({ status: query.status });
    if (query.tags?.length) clauses.push({ tags: { hasEvery: query.tags } });

    if (query.search) {
      clauses.push({
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { sku: { contains: query.search, mode: 'insensitive' } },
        ],
      });
    }

    if (query.lowStockOnly) {
      // Prisma cannot compare two columns in a `where`, so the set is resolved
      // in SQL first. Cheap in practice — the point of a low-stock threshold is
      // that few items are under it — but it is a two-query read, and if the
      // catalog ever makes that hurt the fix is a generated column with an
      // index on it rather than a bigger `IN` list.
      const lowStockIds = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "products"
        WHERE "trackInventory" = true
          AND "stockOnHand" <= "lowStockThreshold"
          AND "deletedAt" IS NULL
      `;
      clauses.push({ id: { in: lowStockIds.map((row) => row.id) } });
    }

    const finalWhere: Prisma.ProductWhereInput = { AND: clauses };
    const { skip, take } = toSkipTake(query);

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where: finalWhere,
        include: FULL_PRODUCT,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.product.count({ where: finalWhere }),
    ]);

    return offsetPage(items, total, query);
  }

  async findById(actor: AuthenticatedActor, productId: string): Promise<FullProduct> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null, ...this.visibilityFilter(actor) },
      include: FULL_PRODUCT,
    });

    // A product the actor may not see is reported as missing, not forbidden.
    // Telling a customer that a SKU exists but is not theirs leaks the
    // existence of another customer's contract line.
    if (!product) throw new NotFoundError('Product');
    return product;
  }

  /**
   * Several products at once, in the shape pricing needs and nothing more.
   *
   * Added for the rate-card quote endpoint (BE-04) and used again by the cart
   * (BE-05). It goes through `visibilityFilter()` like every other read: a
   * batch endpoint that built its own predicate is precisely how a RESTRICTED
   * product ends up priced for an account with no contract for it.
   *
   * Ids the actor may not see are simply absent from the result rather than
   * raising — a quote for fifty tiles should not fail because one of them was
   * unpublished a second ago, and the caller reports the gap per line.
   */
  async findPriceable(
    actor: AuthenticatedActor,
    productIds: readonly string[],
  ): Promise<PriceableProduct[]> {
    if (productIds.length === 0) return [];

    return this.prisma.product.findMany({
      where: {
        AND: [
          { id: { in: [...new Set(productIds)] } },
          { deletedAt: null },
          this.visibilityFilter(actor),
        ],
      },
      select: PRICEABLE_PRODUCT,
    });
  }

  // --- Writes -----------------------------------------------------------------

  async create(dto: CreateProductDto, actor: AuthenticatedActor): Promise<FullProduct> {
    await this.assertCategoryExists(dto.categoryId);
    await this.assertSkuIsFree(dto.sku);

    const product = await this.prisma.product.create({
      data: {
        id: createId('prd'),
        sku: dto.sku,
        name: dto.name,
        description: dto.description ?? null,
        categoryId: dto.categoryId,
        // Always DRAFT. Publishing is its own audited transition — see the note
        // on CreateProductSchema.
        status: 'DRAFT',
        basePrice: dto.basePrice,
        moq: dto.moq,
        orderMultiple: dto.orderMultiple,
        packSize: dto.packSize,
        uom: dto.uom,
        widthMm: dto.widthMm ?? null,
        heightMm: dto.heightMm ?? null,
        depthMm: dto.depthMm ?? null,
        weightGrams: dto.weightGrams ?? null,
        bleedMm: dto.bleedMm ?? null,
        safeMarginMm: dto.safeMarginMm ?? null,
        trackInventory: dto.trackInventory,
        lowStockThreshold: dto.lowStockThreshold,
        leadTimeDays: dto.leadTimeDays ?? null,
        tags: dto.tags,
      },
      include: FULL_PRODUCT,
    });

    await this.audit.record({
      action: AuditAction.PRODUCT_CREATED,
      entityType: 'PRODUCT',
      entityId: product.id,
      entityName: `${product.sku} — ${product.name}`,
      accountId: actor.accountId,
      details: { sku: product.sku, name: product.name, categoryId: product.categoryId },
    });

    this.logger.log(`Created product ${product.id} (${product.sku}).`);
    return product;
  }

  async update(
    productId: string,
    dto: UpdateProductDto,
    actor: AuthenticatedActor,
  ): Promise<FullProduct> {
    const before = await this.requireProduct(productId);
    if (dto.categoryId) await this.assertCategoryExists(dto.categoryId);

    const product = await this.prisma.product.update({
      where: { id: productId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
        ...(dto.basePrice !== undefined ? { basePrice: dto.basePrice } : {}),
        ...(dto.moq !== undefined ? { moq: dto.moq } : {}),
        ...(dto.orderMultiple !== undefined ? { orderMultiple: dto.orderMultiple } : {}),
        ...(dto.packSize !== undefined ? { packSize: dto.packSize } : {}),
        ...(dto.uom !== undefined ? { uom: dto.uom } : {}),
        ...(dto.widthMm !== undefined ? { widthMm: dto.widthMm } : {}),
        ...(dto.heightMm !== undefined ? { heightMm: dto.heightMm } : {}),
        ...(dto.depthMm !== undefined ? { depthMm: dto.depthMm } : {}),
        ...(dto.weightGrams !== undefined ? { weightGrams: dto.weightGrams } : {}),
        ...(dto.bleedMm !== undefined ? { bleedMm: dto.bleedMm } : {}),
        ...(dto.safeMarginMm !== undefined ? { safeMarginMm: dto.safeMarginMm } : {}),
        ...(dto.trackInventory !== undefined ? { trackInventory: dto.trackInventory } : {}),
        ...(dto.lowStockThreshold !== undefined
          ? { lowStockThreshold: dto.lowStockThreshold }
          : {}),
        ...(dto.leadTimeDays !== undefined ? { leadTimeDays: dto.leadTimeDays } : {}),
        ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
      },
      include: FULL_PRODUCT,
    });

    await this.audit.record({
      action: AuditAction.PRODUCT_UPDATED,
      entityType: 'PRODUCT',
      entityId: productId,
      entityName: `${product.sku} — ${product.name}`,
      accountId: actor.accountId,
      details: {
        changes: dto,
        // The one field worth a before/after in its own right: a price change
        // is the question most often asked of this log.
        ...(dto.basePrice !== undefined
          ? { basePrice: { from: before.basePrice.toFixed(2), to: product.basePrice.toFixed(2) } }
          : {}),
      },
    });

    return product;
  }

  /**
   * Moves a product through its lifecycle. The only way `status` ever changes.
   *
   * See product-status.ts for the transition table and for why a published
   * product can never return to DRAFT.
   */
  async changeStatus(
    productId: string,
    dto: ChangeProductStatusDto,
    actor: AuthenticatedActor,
  ): Promise<FullProduct> {
    const product = await this.requireProduct(productId);

    // Both sides are already the same string union: the Prisma enum and the
    // ProductStatus constant are asserted to agree by product-status.spec.ts.
    assertTransition(product.status, dto.status);

    if (dto.supersededById) {
      await this.assertUsableSuccessor(productId, dto.supersededById);
    }

    if (dto.status === 'ACTIVE') await this.assertPublishable(product);

    const updated = await this.prisma.product.update({
      where: { id: productId },
      data: {
        status: dto.status,
        supersededById: dto.status === 'SUPERSEDED' ? (dto.supersededById ?? null) : null,
      },
      include: FULL_PRODUCT,
    });

    await this.audit.record({
      action: AuditAction.PRODUCT_STATUS_CHANGED,
      entityType: 'PRODUCT',
      entityId: productId,
      entityName: `${updated.sku} — ${updated.name}`,
      accountId: actor.accountId,
      details: {
        from: product.status,
        to: dto.status,
        supersededById: dto.supersededById ?? null,
        reason: dto.reason ?? null,
      },
    });

    this.logger.log(`Product ${productId} moved ${product.status} -> ${dto.status}.`);
    return updated;
  }

  /**
   * Soft delete, and only ever from DRAFT.
   *
   * Once a product has been published, orders and invoices reference it, and
   * removing it from the catalogue is what UNAVAILABLE and SUPERSEDED are for.
   * Deleting a draft is the genuine case — something created by mistake that
   * nobody has ever been able to order.
   */
  async remove(productId: string, actor: AuthenticatedActor): Promise<void> {
    const product = await this.requireProduct(productId);

    if (product.status !== 'DRAFT') {
      throw new BusinessRuleError(
        'Only a draft product can be deleted. Mark a published product unavailable, ' +
          'or supersede it with its replacement.',
        { details: { status: product.status } },
      );
    }

    await this.prisma.product.update({
      where: { id: productId },
      data: { deletedAt: new Date() },
    });

    await this.audit.record({
      action: AuditAction.PRODUCT_DELETED,
      entityType: 'PRODUCT',
      entityId: productId,
      entityName: `${product.sku} — ${product.name}`,
      accountId: actor.accountId,
    });
  }

  // --- Options and variants ---------------------------------------------------

  /**
   * Replaces the whole option set.
   *
   * Removing a value that a variant is built on would leave that variant
   * describing a configuration the product no longer offers, so it is refused
   * with the offending variants named. Deleting the variants first is the
   * administrator's decision.
   */
  async setOptions(
    productId: string,
    dto: SetProductOptionsDto,
    actor: AuthenticatedActor,
  ): Promise<FullProduct> {
    await this.requireProduct(productId);

    const duplicateName = firstDuplicate(dto.options.map((option) => option.name.toLowerCase()));
    if (duplicateName) {
      throw new BusinessRuleError(`Duplicate option name "${duplicateName}"`);
    }

    for (const option of dto.options) {
      const duplicateValue = firstDuplicate(option.values.map((value) => value.toLowerCase()));
      if (duplicateValue) {
        throw new BusinessRuleError(
          `Option "${option.name}" lists "${duplicateValue}" more than once`,
        );
      }
    }

    const variants = await this.prisma.productVariant.findMany({
      where: { productId, deletedAt: null },
      select: { sku: true, attributes: true },
    });

    const orphaned = variants.filter(
      (variant) => !attributesMatchOptions(variant.attributes, dto.options),
    );
    if (orphaned.length > 0) {
      throw new BusinessRuleError(
        'These variants use option values that the new option set does not offer: ' +
          orphaned.map((variant) => variant.sku).join(', '),
        { details: { variantSkus: orphaned.map((variant) => variant.sku) } },
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.productOption.deleteMany({ where: { productId } });
      if (dto.options.length > 0) {
        await tx.productOption.createMany({
          data: dto.options.map((option) => ({
            id: createId('opt'),
            productId,
            name: option.name,
            values: option.values,
            sortOrder: option.sortOrder,
          })),
        });
      }
    });

    const product = await this.requireFullProduct(productId);

    await this.audit.record({
      action: AuditAction.PRODUCT_OPTIONS_SET,
      entityType: 'PRODUCT',
      entityId: productId,
      entityName: `${product.sku} — ${product.name}`,
      accountId: actor.accountId,
      details: { options: dto.options.map((o) => ({ name: o.name, valueCount: o.values.length })) },
    });

    return product;
  }

  async createVariant(
    productId: string,
    dto: CreateVariantDto,
    actor: AuthenticatedActor,
  ): Promise<ProductVariant> {
    const product = await this.requireProduct(productId);
    await this.assertSkuIsFree(dto.sku);

    const options = await this.prisma.productOption.findMany({
      where: { productId },
      select: { name: true, values: true },
    });

    // Every key must be an option and every value one that option offers.
    // Without this the JSON drifts from the options, and the product page
    // renders selectors that match no variant.
    if (!attributesMatchOptions(dto.attributes, options)) {
      throw new BusinessRuleError("The variant attributes do not match this product's options", {
        details: { attributes: dto.attributes, options },
      });
    }

    if (Object.keys(dto.attributes).length !== options.length) {
      throw new BusinessRuleError(
        'A variant must choose a value for every option the product defines',
        { details: { expected: options.map((o) => o.name), given: Object.keys(dto.attributes) } },
      );
    }

    const clash = await this.prisma.productVariant.findFirst({
      where: { productId, deletedAt: null, attributes: { equals: dto.attributes } },
      select: { sku: true },
    });
    if (clash) {
      throw new ConflictError(`Variant "${clash.sku}" already covers that combination of options`, {
        details: { attributes: dto.attributes },
      });
    }

    const variant = await this.prisma.productVariant.create({
      data: {
        id: createId('var'),
        productId,
        sku: dto.sku,
        attributes: dto.attributes,
        priceOverride: dto.priceOverride ?? null,
        sortOrder: dto.sortOrder,
      },
    });

    await this.audit.record({
      action: AuditAction.PRODUCT_VARIANT_CREATED,
      entityType: 'PRODUCT',
      entityId: productId,
      entityName: `${product.sku} — ${product.name}`,
      accountId: actor.accountId,
      details: { variantSku: variant.sku, attributes: dto.attributes },
    });

    return variant;
  }

  async updateVariant(
    productId: string,
    variantId: string,
    dto: UpdateVariantDto,
    actor: AuthenticatedActor,
  ): Promise<ProductVariant> {
    const existing = await this.prisma.productVariant.findFirst({
      where: { id: variantId, productId, deletedAt: null },
    });
    if (!existing) throw new NotFoundError('Variant');

    const variant = await this.prisma.productVariant.update({
      where: { id: variantId },
      data: {
        ...(dto.priceOverride !== undefined ? { priceOverride: dto.priceOverride } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    });

    await this.audit.record({
      action: AuditAction.PRODUCT_VARIANT_UPDATED,
      entityType: 'PRODUCT',
      entityId: productId,
      entityName: variant.sku,
      accountId: actor.accountId,
      details: { variantSku: variant.sku, changes: dto },
    });

    return variant;
  }

  async removeVariant(
    productId: string,
    variantId: string,
    actor: AuthenticatedActor,
  ): Promise<void> {
    const variant = await this.prisma.productVariant.findFirst({
      where: { id: variantId, productId, deletedAt: null },
      select: { id: true, sku: true },
    });
    if (!variant) throw new NotFoundError('Variant');

    // Soft, like everything else: order lines will reference the variant SKU.
    await this.prisma.productVariant.update({
      where: { id: variantId },
      data: { status: 'INACTIVE', deletedAt: new Date() },
    });

    await this.audit.record({
      action: AuditAction.PRODUCT_VARIANT_DELETED,
      entityType: 'PRODUCT',
      entityId: productId,
      entityName: variant.sku,
      accountId: actor.accountId,
    });
  }

  // --- Volume tiers -----------------------------------------------------------

  async setVolumeTiers(
    productId: string,
    dto: SetVolumeTiersDto,
    actor: AuthenticatedActor,
  ): Promise<FullProduct> {
    await this.requireProduct(productId);

    const duplicate = firstDuplicate(dto.tiers.map((tier) => String(tier.minQuantity)));
    if (duplicate) {
      throw new BusinessRuleError(`Two tiers both start at ${duplicate}`);
    }

    // A ladder where a larger order costs more per unit is a pricing error that
    // customers find before we do.
    const ordered = [...dto.tiers].sort((a, b) => a.minQuantity - b.minQuantity);
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index]!.discountPercent <= ordered[index - 1]!.discountPercent) {
        throw new BusinessRuleError(
          `The tier at ${ordered[index]!.minQuantity} does not discount more than the one ` +
            `at ${ordered[index - 1]!.minQuantity}. Volume discounts must increase with quantity.`,
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.productVolumeTier.deleteMany({ where: { productId } });
      if (ordered.length > 0) {
        await tx.productVolumeTier.createMany({
          data: ordered.map((tier) => ({
            id: createId('vtr'),
            productId,
            minQuantity: tier.minQuantity,
            discountPercent: tier.discountPercent,
          })),
        });
      }
    });

    const product = await this.requireFullProduct(productId);

    await this.audit.record({
      action: AuditAction.PRODUCT_TIERS_SET,
      entityType: 'PRODUCT',
      entityId: productId,
      entityName: `${product.sku} — ${product.name}`,
      accountId: actor.accountId,
      details: { tiers: ordered },
    });

    return product;
  }

  // --- Visibility --------------------------------------------------------------

  async setVisibility(
    productId: string,
    dto: SetVisibilityDto,
    actor: AuthenticatedActor,
  ): Promise<FullProduct> {
    await this.requireProduct(productId);

    if (dto.visibility === 'RESTRICTED') {
      const found = await this.prisma.account.count({
        where: { id: { in: dto.accountIds }, deletedAt: null },
      });
      if (found !== new Set(dto.accountIds).size) {
        throw new BusinessRuleError('One or more of those accounts does not exist');
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: productId },
        data: { visibility: dto.visibility },
      });

      if (dto.visibility === 'RESTRICTED') {
        await tx.productAccountVisibility.deleteMany({ where: { productId } });
        await tx.productAccountVisibility.createMany({
          data: dto.accountIds.map((accountId) => ({
            id: createId('pav'),
            productId,
            accountId,
          })),
        });
      }
      // ALL_ACCOUNTS deliberately leaves the rows in place. A restriction lifted
      // for a campaign is usually reinstated, and re-entering fifty account ids
      // by hand is how it gets reinstated wrongly.
    });

    const product = await this.requireFullProduct(productId);

    await this.audit.record({
      action: AuditAction.PRODUCT_VISIBILITY_SET,
      entityType: 'PRODUCT',
      entityId: productId,
      entityName: `${product.sku} — ${product.name}`,
      accountId: actor.accountId,
      details: { visibility: dto.visibility, accountCount: dto.accountIds.length },
    });

    return product;
  }

  // --- Stock -------------------------------------------------------------------

  /**
   * Applies a signed stock movement.
   *
   * The update is a single atomic `increment`, not a read-then-write: two
   * warehouse staff adjusting the same product at the same moment must both be
   * applied, and a read-modify-write would silently lose one of them.
   *
   * Stock is never allowed below zero. A negative figure is not a real state —
   * it is an adjustment applied twice, or one applied to the wrong SKU — and
   * letting it through means the low-stock alerts and the 3PL feed both carry
   * the error onwards.
   */
  async adjustStock(
    productId: string,
    dto: AdjustStockDto,
    actor: AuthenticatedActor,
  ): Promise<{ productId: string; variantId?: string; stockOnHand: number }> {
    const product = await this.requireProduct(productId);

    if (!product.trackInventory) {
      throw new BusinessRuleError(
        'This product is not stock-tracked. Enable inventory tracking before adjusting stock.',
      );
    }

    if (dto.variantId) {
      const variant = await this.prisma.productVariant.findFirst({
        where: { id: dto.variantId, productId, deletedAt: null },
        select: { id: true, sku: true, stockOnHand: true },
      });
      if (!variant) throw new NotFoundError('Variant');

      if (variant.stockOnHand + dto.delta < 0) {
        throw new BusinessRuleError(
          `That would take ${variant.sku} to ${variant.stockOnHand + dto.delta}. ` +
            'Stock cannot go below zero.',
          { details: { stockOnHand: variant.stockOnHand, delta: dto.delta } },
        );
      }

      const updated = await this.prisma.productVariant.update({
        where: { id: dto.variantId },
        data: { stockOnHand: { increment: dto.delta } },
        select: { stockOnHand: true },
      });

      await this.recordStockAudit(product, actor, dto, updated.stockOnHand, variant.sku);
      return { productId, variantId: dto.variantId, stockOnHand: updated.stockOnHand };
    }

    if (product.stockOnHand + dto.delta < 0) {
      throw new BusinessRuleError(
        `That would take ${product.sku} to ${product.stockOnHand + dto.delta}. ` +
          'Stock cannot go below zero.',
        { details: { stockOnHand: product.stockOnHand, delta: dto.delta } },
      );
    }

    const updated = await this.prisma.product.update({
      where: { id: productId },
      data: { stockOnHand: { increment: dto.delta } },
      select: { stockOnHand: true, lowStockThreshold: true },
    });

    await this.recordStockAudit(product, actor, dto, updated.stockOnHand, product.sku);

    // Only on the *crossing*, not on every adjustment below the line. A
    // warehouse counting down from five to one would otherwise send four
    // identical alerts, and the fourth is what teaches people to filter the
    // first away.
    const wasAbove = product.stockOnHand > updated.lowStockThreshold;
    if (wasAbove && updated.stockOnHand <= updated.lowStockThreshold) {
      this.logger.warn(
        `${product.sku} is at ${updated.stockOnHand}, at or below its threshold of ` +
          `${updated.lowStockThreshold}.`,
      );
      await this.alertLowStock(product.sku, product.name, updated);
    }

    return { productId, stockOnHand: updated.stockOnHand };
  }

  /**
   * Tells the people who can do something about it (SOW BE-08).
   *
   * Sent to the platform operator's administrators, not to the customer:
   * replenishing the warehouse is the operator's job, and a buyer told that
   * stock is low can only worry about it.
   *
   * Never allowed to fail the adjustment. The count is already committed, and
   * refusing the response would have a warehouse operator re-key a stock
   * movement that had actually landed — which is how a count of 40 becomes 80.
   */
  private async alertLowStock(
    sku: string,
    name: string,
    stock: { stockOnHand: number; lowStockThreshold: number },
  ): Promise<void> {
    try {
      const admins = await this.prisma.user.findMany({
        where: { role: 'ADMIN', status: 'ACTIVE', deletedAt: null },
        select: { email: true, firstName: true },
      });

      for (const admin of admins) {
        await this.mail.sendLowStock({
          to: admin.email,
          firstName: admin.firstName,
          items: [
            {
              sku,
              name,
              stockOnHand: stock.stockOnHand,
              threshold: stock.lowStockThreshold,
            },
          ],
        });
      }
    } catch (error) {
      this.logger.error(
        `Could not queue a low-stock alert for ${sku}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async recordStockAudit(
    product: Product,
    actor: AuthenticatedActor,
    dto: AdjustStockDto,
    resulting: number,
    sku: string,
  ): Promise<void> {
    await this.audit.record({
      action: AuditAction.PRODUCT_STOCK_ADJUSTED,
      entityType: 'PRODUCT',
      entityId: product.id,
      entityName: `${product.sku} — ${product.name}`,
      accountId: actor.accountId,
      details: {
        sku,
        variantId: dto.variantId ?? null,
        delta: dto.delta,
        stockOnHand: resulting,
        reason: dto.reason,
      },
    });
  }

  // --- Assets ------------------------------------------------------------------

  /**
   * Mints a presigned PUT URL the client uploads to directly.
   *
   * The key is built here, not by the caller, so a client cannot choose where
   * its upload lands. `attachAsset` then registers it.
   */
  async presignAssetUpload(
    productId: string,
    dto: PresignAssetUploadDto,
    actor: AuthenticatedActor,
  ): Promise<{ uploadUrl: string; storageKey: string }> {
    const product = await this.requireProduct(productId);

    // The catalog is global, so its assets are filed under the operator's own
    // account id rather than the customer's — they are not tenant data, and
    // filing them per tenant would put the same image under fifty prefixes.
    const storageKey = this.storage.buildKey(
      dto.kind === 'IMAGE' ? StoragePrefix.ARTWORK : StoragePrefix.DOCUMENT,
      `catalog/${product.sku}`,
      `${Date.now()}-${dto.filename}`,
    );

    const uploadUrl = await this.storage.presignUpload(storageKey, dto.contentType);
    void actor;

    return { uploadUrl, storageKey };
  }

  async attachAsset(
    productId: string,
    dto: AttachAssetDto,
    actor: AuthenticatedActor,
  ): Promise<FullProduct> {
    const product = await this.requireProduct(productId);

    // Confirms the client actually completed the upload before a row claims it
    // did — otherwise the product page renders a broken image and nothing says
    // why.
    if (!(await this.storage.exists(dto.storageKey))) {
      throw new BusinessRuleError(
        'No uploaded file was found at that key. Complete the upload before attaching it.',
        { details: { storageKey: dto.storageKey } },
      );
    }

    const asset = await this.prisma.productAsset.create({
      data: {
        id: createId('pas'),
        productId,
        kind: dto.kind,
        storageKey: dto.storageKey,
        filename: dto.filename,
        contentType: dto.contentType,
        sizeBytes: dto.sizeBytes,
        altText: dto.altText ?? null,
        sortOrder: dto.sortOrder,
        // Only images get resized copies. The status is set before the job is
        // queued, so an enqueue failure leaves the asset PENDING for
        // sweepPending() rather than stuck at NOT_APPLICABLE for ever.
        derivativeStatus: dto.kind === 'IMAGE' ? 'PENDING' : 'NOT_APPLICABLE',
      },
    });

    // Fire and forget. Attaching the asset must succeed whether or not a
    // thumbnail can be scheduled — enqueue() swallows its own failures.
    if (asset.kind === 'IMAGE') await this.derivatives.enqueue(asset.id);

    await this.audit.record({
      action: AuditAction.PRODUCT_ASSET_ATTACHED,
      entityType: 'PRODUCT',
      entityId: productId,
      entityName: `${product.sku} — ${product.name}`,
      accountId: actor.accountId,
      details: { kind: dto.kind, filename: dto.filename, sizeBytes: dto.sizeBytes },
    });

    return this.requireFullProduct(productId);
  }

  async removeAsset(productId: string, assetId: string, actor: AuthenticatedActor): Promise<void> {
    const asset = await this.prisma.productAsset.findFirst({
      where: { id: assetId, productId },
    });
    if (!asset) throw new NotFoundError('Asset');

    // The row goes first. If the object delete fails the row is already gone,
    // which leaves an orphaned object for the MAINTENANCE queue to sweep —
    // strictly better than a row pointing at a file that no longer exists.
    await this.prisma.productAsset.delete({ where: { id: assetId } });

    try {
      await this.storage.remove(asset.storageKey);
    } catch (error) {
      this.logger.warn(
        `Detached asset ${assetId} but could not delete ${asset.storageKey}; ` +
          'it is now an orphaned object.',
        error instanceof Error ? error.message : String(error),
      );
    }

    // The generated copies go too. Best-effort, and separate from the original
    // so a failure to delete one does not strand the other.
    await this.derivatives.removeDerivatives(asset.thumbnailKey, asset.previewKey);

    await this.audit.record({
      action: AuditAction.PRODUCT_ASSET_REMOVED,
      entityType: 'PRODUCT',
      entityId: productId,
      entityName: asset.filename,
      accountId: actor.accountId,
      details: { kind: asset.kind, filename: asset.filename },
    });
  }

  /**
   * Short-lived download URLs for a product's assets, minted on read.
   *
   * Returns the original plus whichever derivatives exist, keyed
   * `<assetId>`, `<assetId>:thumbnail` and `<assetId>:preview`. Flat rather
   * than nested because the view layer looks each up by key and a nested shape
   * would need a null check per level for something that is simply absent.
   *
   * All signed in parallel: signing is local HMAC work, not a network call, so
   * a product with a dozen images costs microseconds rather than round trips.
   */
  async presignAssets(product: FullProduct): Promise<Record<string, string>> {
    const jobs = product.assets.flatMap((asset) => {
      const entries: Promise<readonly [string, string]>[] = [
        this.storage
          .presignDownload(asset.storageKey, asset.filename)
          .then((url) => [asset.id, url] as const),
      ];

      if (asset.thumbnailKey) {
        entries.push(
          this.storage
            .presignDownload(asset.thumbnailKey)
            .then((url) => [`${asset.id}:thumbnail`, url] as const),
        );
      }
      if (asset.previewKey) {
        entries.push(
          this.storage
            .presignDownload(asset.previewKey)
            .then((url) => [`${asset.id}:preview`, url] as const),
        );
      }

      return entries;
    });

    return Object.fromEntries(await Promise.all(jobs));
  }

  // --- Shared guards ------------------------------------------------------------

  /** Admin-side lookup: no visibility filter, drafts included. */
  private async requireProduct(productId: string): Promise<Product> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
    });
    if (!product) throw new NotFoundError('Product');
    return product;
  }

  private async requireFullProduct(productId: string): Promise<FullProduct> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      include: FULL_PRODUCT,
    });
    if (!product) throw new NotFoundError('Product');
    return product;
  }

  private async assertCategoryExists(categoryId: string): Promise<void> {
    const category = await this.prisma.productCategory.findFirst({
      where: { id: categoryId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!category) throw new NotFoundError('Category');

    if (category.status === 'INACTIVE') {
      throw new BusinessRuleError('That category is inactive and cannot take new products');
    }
  }

  /**
   * SKUs are unique across products *and* variants, which two separate unique
   * indexes cannot express — hence the explicit check.
   */
  private async assertSkuIsFree(sku: string): Promise<void> {
    const [product, variant] = await Promise.all([
      this.prisma.product.findUnique({ where: { sku }, select: { id: true, deletedAt: true } }),
      this.prisma.productVariant.findUnique({ where: { sku }, select: { id: true } }),
    ]);

    if (product) {
      throw new ConflictError(
        product.deletedAt
          ? `SKU "${sku}" belongs to a deleted product and cannot be reused`
          : `SKU "${sku}" is already in use`,
        { details: { sku } },
      );
    }
    if (variant) {
      throw new ConflictError(`SKU "${sku}" is already used by a product variant`, {
        details: { sku },
      });
    }
  }

  private async assertUsableSuccessor(productId: string, successorId: string): Promise<void> {
    if (successorId === productId) {
      throw new BusinessRuleError('A product cannot supersede itself');
    }

    const successor = await this.prisma.product.findFirst({
      where: { id: successorId, deletedAt: null },
      select: { id: true, sku: true, status: true },
    });
    if (!successor) throw new NotFoundError('Replacement product');

    // Pointing at a draft or an already-superseded product sends every re-order
    // to a dead end, which is the exact failure the pointer exists to prevent.
    if (successor.status !== 'ACTIVE' && successor.status !== 'UNAVAILABLE') {
      throw new BusinessRuleError(
        `${successor.sku} is ${successor.status} and cannot be a replacement`,
        { details: { successorStatus: successor.status } },
      );
    }
  }

  /**
   * A product cannot be published half-built.
   *
   * If it declares options, it needs at least one variant to sell — otherwise
   * the product page renders selectors that resolve to nothing and the customer
   * gets an add-to-cart button that cannot work.
   */
  private async assertPublishable(product: Product): Promise<void> {
    const [optionCount, variantCount] = await Promise.all([
      this.prisma.productOption.count({ where: { productId: product.id } }),
      this.prisma.productVariant.count({
        where: { productId: product.id, deletedAt: null, status: 'ACTIVE' },
      }),
    ]);

    if (optionCount > 0 && variantCount === 0) {
      throw new BusinessRuleError(
        'This product defines options but has no active variants, so nothing could be ordered. ' +
          'Add a variant for each combination you sell, or remove the options.',
        { details: { optionCount, variantCount } },
      );
    }
  }
}

/** The first value that appears twice, or undefined. */
function firstDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

/**
 * Whether an attribute map only uses option names and values the product
 * actually offers.
 *
 * Accepts a partial map on purpose — `setOptions` uses it to find variants that
 * a proposed option set would orphan, and `createVariant` separately requires
 * every option to be answered.
 */
function attributesMatchOptions(
  attributes: unknown,
  options: readonly { name: string; values: string[] }[],
): boolean {
  if (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes)) {
    return false;
  }

  const byName = new Map(options.map((option) => [option.name, new Set(option.values)]));

  for (const [name, value] of Object.entries(attributes as Record<string, unknown>)) {
    const allowed = byName.get(name);
    if (!allowed) return false;
    if (typeof value !== 'string' || !allowed.has(value)) return false;
  }

  return true;
}

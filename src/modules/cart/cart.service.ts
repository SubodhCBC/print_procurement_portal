import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  BusinessRuleError,
  createId,
  NotFoundError,
  Role,
  type AuthenticatedActor,
} from '@/common';
import { PrismaService, withTenantScope } from '@/database';
import { ORDERABLE_STATUSES, roundToOrderable } from '@/modules/catalog';
import { PricingService, type QuotedLine } from '@/modules/pricing';
import { TemplatesService } from '@/modules/templates';
// The pure rules file, not the templates barrel: this needs one function and
// the barrel would pull the service's whole dependency chain in behind it.
import { acceptCustomisation, type TemplateLayerLike } from '@/modules/templates/template-status';
import { readSnapshot } from '@/modules/templates/dto/template-response';
// Imported from the file rather than from '@/modules/orders': that barrel
// re-exports OrdersService, which depends on this service, and the cycle would
// be real at runtime. `order-status.ts` is pure and has no imports of its own,
// so both sides agree on which statuses count as committed spend — the part
// that must not drift — without either module depending on the other.
import { COMMITTED_STATUSES } from '@/modules/orders/order-status';
import { billingPeriodOf, evaluateBudget, type BudgetStatus } from './budget';
import {
  CartIssueCode,
  checkCheckoutDetails,
  checkLine,
  type CartIssue,
  type LineCheck,
  type LineProductFacts,
} from './cart-validation';
import {
  checkPurchaseOrder,
  resolvePurchaseOrderPolicy,
  type PurchaseOrderCheck,
} from './purchase-order';
import type { AddCartLineDto, SetCheckoutDetailsDto, UpdateCartLineDto } from './dto/cart.dto';

const FULL_CART = Prisma.validator<Prisma.CartInclude>()({
  site: {
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      monthlyBudget: true,
      poRequired: true,
      poPrefix: true,
      costCentre: true,
    },
  },
  shippingAddress: true,
  billingAddress: true,
  lines: {
    include: {
      product: {
        select: {
          id: true,
          sku: true,
          name: true,
          status: true,
          moq: true,
          orderMultiple: true,
          uom: true,
          packSize: true,
          trackInventory: true,
          stockOnHand: true,
          stockReserved: true,
          leadTimeDays: true,
        },
      },
      variant: {
        select: {
          id: true,
          sku: true,
          status: true,
          deletedAt: true,
          stockOnHand: true,
          stockReserved: true,
        },
      },
      // `status` and `deletedAt` are read by validation, not by the view: a
      // template withdrawn while a basket sat is a line that cannot be printed,
      // and the buyer has to be told before they check out rather than after.
      template: {
        select: { id: true, code: true, name: true, status: true, deletedAt: true },
      },
      templateVersion: { select: { id: true, version: true, label: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
});

export type FullCart = Prisma.CartGetPayload<{ include: typeof FULL_CART }>;

/**
 * Matches the cap on `POST /pricing/quote`. A basket bigger than this is priced
 * in several calls rather than being refused.
 */
const QUOTE_BATCH_SIZE = 200;

/**
 * A price depends on the product and the quantity, so both belong in the key.
 * See the note in `validate()` for what keying on the product alone did.
 */
function quoteKey(productId: string, quantity: number): string {
  return `${productId}:${quantity}`;
}
export type CartLineRow = FullCart['lines'][number];

/** One line, priced and checked. */
export interface ValidatedLine {
  readonly line: CartLineRow;
  readonly check: LineCheck;
  /** Null when the product could not be priced — it is gone or now invisible. */
  readonly quote: QuotedLine | null;
}

export interface CartValidation {
  readonly cart: FullCart;
  readonly lines: readonly ValidatedLine[];
  /** Blocking. The cart cannot become an order while any of these stand. */
  readonly issues: readonly CartIssue[];
  /** Non-blocking. The buyer accepts an adjustment and proceeds. */
  readonly warnings: readonly CartIssue[];
  readonly valid: boolean;
  readonly purchaseOrder: PurchaseOrderCheck;
  readonly budget: BudgetStatus;
  readonly billingPeriod: string;
  /** Priced at the quantities that would actually be ordered, in cents. */
  readonly subtotalCents: number;
  /** What the same basket would cost with no rate card. */
  readonly catalogSubtotalCents: number;
  readonly savingCents: number;
}

/**
 * Baskets and checkout validation (SOW BE-05).
 *
 * ---------------------------------------------------------------------------
 * The cart is never the source of a price
 * ---------------------------------------------------------------------------
 * Nothing here stores money. Every read re-prices through PricingService, so a
 * rate card that is activated, corrected or expires between adding a line and
 * paying for it is reflected immediately. A price cached on the line would be a
 * quote the system had quietly stopped honouring, and the customer would find
 * out from the invoice.
 *
 * ---------------------------------------------------------------------------
 * Which basket a request may touch
 * ---------------------------------------------------------------------------
 * Carts are never addressed by id. Every method resolves the basket from the
 * authenticated user and the branch they asked for, so there is no identifier
 * for one colleague to guess another's with. RLS covers the tenant boundary;
 * this covers the boundary inside a tenant, which RLS cannot express because
 * the scope carries an account and not a user.
 */
@Injectable()
export class CartService {
  private readonly logger = new Logger(CartService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly templates: TemplatesService,
  ) {}

  // --- Reading and creating the basket ----------------------------------------

  /**
   * This user's open basket for a branch, created on first use.
   *
   * Creating on read is deliberate: every client's first action is to show the
   * cart, and making them POST an empty one first would be a round trip that
   * exists only to satisfy REST. The partial unique index in the migration is
   * what keeps a double-tap from making two.
   */
  async openCart(actor: AuthenticatedActor, requestedSiteId?: string): Promise<FullCart> {
    const siteId = await this.resolveSite(actor, requestedSiteId);

    return withTenantScope(this.prisma, actor.accountId, async (tx) => {
      const existing = await tx.cart.findFirst({
        where: { userId: actor.userId, siteId, status: 'OPEN' },
        include: FULL_CART,
      });
      if (existing) return existing;

      return tx.cart.create({
        data: {
          id: createId('crt'),
          accountId: actor.accountId,
          userId: actor.userId,
          siteId,
          status: 'OPEN',
        },
        include: FULL_CART,
      });
    });
  }

  // --- Template personalisation -------------------------------------------------

  /**
   * Resolves the artwork a line was personalised from, and rebuilds the values
   * it may carry.
   *
   * ---------------------------------------------------------------------------
   * What this closes
   * ---------------------------------------------------------------------------
   * A basket line used to hold `customisation` and nothing that said which
   * artwork the values belonged to. An operator saw the answers without the
   * question, and `{"disclaimer": "No conditions apply."}` was as acceptable as
   * a branch name — there was no template to check it against.
   *
   * Three things are enforced here, and the third is the one that matters:
   *
   * 1. **The template must be published and visible to this buyer.** Delegated
   *    to `TemplatesService.getCustomisable`, which is the same call the
   *    customiser made — so the basket cannot accept a template the storefront
   *    would not have shown.
   *
   * 2. **The version must be the one currently published.** A stale id means
   *    the buyer had the customiser open while a designer republished; their
   *    values were checked against artwork that is no longer live, so they are
   *    sent back rather than pinned to something nobody can see any more.
   *
   * 3. **The values are rebuilt from that version's editable layers.** Not
   *    filtered — rebuilt, by `acceptCustomisation`. A key aimed at a locked
   *    layer cannot survive a rebuild the way it survives a check somebody
   *    later forgets to run.
   *
   * Returns nulls when no template is named: a box of envelopes has no artwork,
   * and its `customisation` stays free-form as it always was.
   */
  private async resolveTemplateSelection(
    actor: AuthenticatedActor,
    selection: {
      readonly templateId?: string | null;
      readonly templateVersionId?: string | null;
      readonly customisation?: Record<string, unknown> | null;
    },
  ): Promise<{
    templateId: string | null;
    templateVersionId: string | null;
    customisation: Prisma.InputJsonValue | typeof Prisma.DbNull;
  }> {
    const raw = selection.customisation ?? null;

    if (!selection.templateId || !selection.templateVersionId) {
      return {
        templateId: null,
        templateVersionId: null,
        customisation: raw === null ? Prisma.DbNull : (raw as Prisma.InputJsonValue),
      };
    }

    // Throws 404 when the template is unpublished, deleted, or restricted to
    // another account — deliberately the same answer for all three, so a basket
    // cannot be used to enumerate the library.
    const { version } = await this.templates.getCustomisable(actor, selection.templateId);

    if (version.id !== selection.templateVersionId) {
      throw new BusinessRuleError(
        'This template has been updated since you personalised it. ' +
          'Open the customiser again so your details are checked against the new artwork.',
        {
          details: {
            templateId: selection.templateId,
            sentVersionId: selection.templateVersionId,
            publishedVersionId: version.id,
          },
        },
      );
    }

    const snapshot = readSnapshot(version.snapshot);
    const accepted = acceptCustomisation(
      snapshot.layers as unknown as readonly TemplateLayerLike[],
      raw ?? {},
    );

    return {
      templateId: selection.templateId,
      templateVersionId: version.id,
      customisation: accepted,
    };
  }

  // --- Lines ------------------------------------------------------------------

  /**
   * Adds a line, merging into an existing one where that is unambiguous.
   *
   * Merging only happens when both lines are for the same product and variant
   * **and neither carries customisation**. Two personalised runs of the same
   * business card are two different things to print, and adding their
   * quantities together would silently destroy one of them.
   */
  async addLine(
    actor: AuthenticatedActor,
    dto: AddCartLineDto,
    requestedSiteId?: string,
  ): Promise<FullCart> {
    // The branch has to come through here as it does on every other cart
    // method. Without it a head-office buyer can select a branch basket, see
    // it, and edit its checkout details — but every line they add lands in
    // their own branch-less one, which looks like the add silently failing.
    const cart = await this.openCart(actor, requestedSiteId);
    const product = await this.requireOrderableProduct(actor, dto.productId, dto.variantId ?? null);
    const selection = await this.resolveTemplateSelection(actor, dto);

    await withTenantScope(this.prisma, actor.accountId, async (tx) => {
      // Only a plain line merges: no personalisation *and* no artwork behind
      // it. A line naming a template is a specific print run even when its
      // fields happen to be empty, and adding quantities across two of them
      // would silently destroy one.
      const mergeable =
        dto.customisation == null && selection.templateId === null
          ? await tx.cartLine.findFirst({
              where: {
                cartId: cart.id,
                productId: dto.productId,
                variantId: dto.variantId ?? null,
                customisation: { equals: Prisma.DbNull },
                templateId: null,
              },
            })
          : null;

      if (mergeable) {
        await tx.cartLine.update({
          where: { id: mergeable.id },
          data: { quantity: mergeable.quantity + dto.quantity },
        });
        return;
      }

      await tx.cartLine.create({
        data: {
          id: createId('crl'),
          cartId: cart.id,
          productId: dto.productId,
          variantId: dto.variantId ?? null,
          quantity: dto.quantity,
          templateId: selection.templateId,
          templateVersionId: selection.templateVersionId,
          customisation: selection.customisation,
          notes: dto.notes ?? null,
        },
      });
    });

    this.logger.log(`Added ${product.sku} x${dto.quantity} to cart ${cart.id}.`);
    return this.openCart(actor, cart.siteId ?? undefined);
  }

  async updateLine(
    actor: AuthenticatedActor,
    lineId: string,
    dto: UpdateCartLineDto,
  ): Promise<FullCart> {
    const cart = await this.requireOwnedLine(actor, lineId);

    const existing = await withTenantScope(this.prisma, actor.accountId, (tx) =>
      tx.cartLine.findUniqueOrThrow({
        where: { id: lineId },
        select: { templateId: true, templateVersionId: true },
      }),
    );

    // Editing the values of a line that already names a template must go
    // through the same rebuild. The template is taken from the line rather than
    // from the request when the request is silent about it — otherwise a
    // buyer could strip `templateId` from a PATCH and turn a checked
    // personalisation back into a free-form bag of values.
    const namesTemplate = dto.templateId !== undefined || dto.templateVersionId !== undefined;
    const touchesValues = dto.customisation !== undefined;

    const selection =
      namesTemplate || (touchesValues && existing.templateId)
        ? await this.resolveTemplateSelection(actor, {
            templateId: namesTemplate ? dto.templateId : existing.templateId,
            templateVersionId: namesTemplate ? dto.templateVersionId : existing.templateVersionId,
            customisation: dto.customisation ?? null,
          })
        : null;

    await withTenantScope(this.prisma, actor.accountId, (tx) =>
      tx.cartLine.update({
        where: { id: lineId },
        data: {
          ...(dto.quantity !== undefined ? { quantity: dto.quantity } : {}),
          ...(selection
            ? {
                templateId: selection.templateId,
                templateVersionId: selection.templateVersionId,
                customisation: selection.customisation,
              }
            : dto.customisation !== undefined
              ? { customisation: dto.customisation ?? Prisma.DbNull }
              : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        },
      }),
    );

    return this.openCart(actor, cart.siteId ?? undefined);
  }

  async removeLine(actor: AuthenticatedActor, lineId: string): Promise<FullCart> {
    const cart = await this.requireOwnedLine(actor, lineId);

    await withTenantScope(this.prisma, actor.accountId, (tx) =>
      tx.cartLine.delete({ where: { id: lineId } }),
    );

    return this.openCart(actor, cart.siteId ?? undefined);
  }

  async clear(actor: AuthenticatedActor, requestedSiteId?: string): Promise<FullCart> {
    const cart = await this.openCart(actor, requestedSiteId);

    await withTenantScope(this.prisma, actor.accountId, (tx) =>
      tx.cartLine.deleteMany({ where: { cartId: cart.id } }),
    );

    return this.openCart(actor, cart.siteId ?? undefined);
  }

  /**
   * Rounds every line up to a quantity the product can be ordered in.
   *
   * The explicit half of "report the adjustment rather than applying it": the
   * buyer sees the warnings, then asks for them to be applied. Nothing here
   * happens without that second call.
   */
  async normaliseQuantities(
    actor: AuthenticatedActor,
    requestedSiteId?: string,
  ): Promise<FullCart> {
    const validation = await this.validate(actor, requestedSiteId, false);

    const adjustments = validation.lines
      .filter((line) => line.check.orderableQuantity !== line.line.quantity)
      .map((line) => ({ id: line.line.id, quantity: line.check.orderableQuantity }));

    if (adjustments.length > 0) {
      await withTenantScope(this.prisma, actor.accountId, async (tx) => {
        for (const adjustment of adjustments) {
          await tx.cartLine.update({
            where: { id: adjustment.id },
            data: { quantity: adjustment.quantity },
          });
        }
      });
      this.logger.log(`Rounded ${adjustments.length} line(s) in cart ${validation.cart.id}.`);
    }

    return this.openCart(actor, validation.cart.siteId ?? undefined);
  }

  // --- Checkout details -------------------------------------------------------

  async setDetails(
    actor: AuthenticatedActor,
    dto: SetCheckoutDetailsDto,
    requestedSiteId?: string,
  ): Promise<FullCart> {
    const cart = await this.openCart(actor, requestedSiteId);

    // Changing the branch would move the basket to a different budget, a
    // different purchase-order rule and different addresses, so it is a
    // different basket — the client asks for that one instead of mutating this.
    if (dto.siteId !== undefined && dto.siteId !== cart.siteId) {
      throw new BusinessRuleError(
        'A basket belongs to one branch. Ask for the basket for the other branch instead of ' +
          'moving this one — its budget, purchase-order rule and addresses all differ.',
        { details: { currentSiteId: cart.siteId, requestedSiteId: dto.siteId } },
      );
    }

    if (dto.shippingAddressId) {
      await this.assertAddressUsable(actor, cart.siteId, dto.shippingAddressId, 'SHIPPING');
    }
    if (dto.billingAddressId) {
      await this.assertAddressUsable(actor, cart.siteId, dto.billingAddressId, 'BILLING');
    }

    await withTenantScope(this.prisma, actor.accountId, (tx) =>
      tx.cart.update({
        where: { id: cart.id },
        data: {
          ...(dto.poNumber !== undefined ? { poNumber: dto.poNumber } : {}),
          ...(dto.campaignCode !== undefined ? { campaignCode: dto.campaignCode } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.requestedDeliveryDate !== undefined
            ? { requestedDeliveryDate: dto.requestedDeliveryDate }
            : {}),
          ...(dto.shippingAddressId !== undefined
            ? { shippingAddressId: dto.shippingAddressId }
            : {}),
          ...(dto.billingAddressId !== undefined ? { billingAddressId: dto.billingAddressId } : {}),
          ...(dto.paymentMethod !== undefined ? { paymentMethod: dto.paymentMethod } : {}),
          // The server stamps the instant. Accepting one from the client would
          // let it claim the buyer agreed at any time it liked.
          ...(dto.acceptTerms !== undefined
            ? { termsAcceptedAt: dto.acceptTerms ? new Date() : null }
            : {}),
        },
      }),
    );

    return this.openCart(actor, cart.siteId ?? undefined);
  }

  // --- Validation -------------------------------------------------------------

  /**
   * Everything wrong with the basket, at once.
   *
   * Never short-circuits: a buyer with four bad lines sees four messages rather
   * than fixing one and discovering the next.
   */
  async validate(
    actor: AuthenticatedActor,
    requestedSiteId?: string,
    forCheckout = false,
  ): Promise<CartValidation> {
    const cart = await this.openCart(actor, requestedSiteId);
    const now = new Date();

    const quotes = await this.quoteLines(actor, cart);

    // Keyed by product *and* quantity, not by product alone. The same SKU can
    // appear on several lines — two personalised runs of one business card —
    // and a product-keyed map would collapse them, pricing every such line at
    // whichever quantity happened to be quoted last. That is a wrong number on
    // an invoice, so the key has to carry everything the price depends on.
    const quoteByLine = new Map(
      quotes.map((quote) => [quoteKey(quote.productId, quote.breakdown.quantity), quote]),
    );
    // Visibility is a product-level fact, so it needs its own set.
    const visibleProducts = new Set(quotes.map((quote) => quote.productId));

    const lines: ValidatedLine[] = cart.lines.map((line) => {
      // A product missing from the quote is one the actor may no longer see.
      // `checkLine` reports that identically to "gone", which is deliberate:
      // a cart message must not confirm that a SKU exists but has become
      // another customer's contract line.
      const facts = visibleProducts.has(line.productId) ? this.factsFor(line) : null;

      // A template withdrawn since the line was added. Read from the joined
      // row rather than re-queried: the basket already loaded it, and one more
      // round trip per line to learn a status it is holding would be waste.
      const template =
        line.template && line.templateVersion
          ? {
              templateId: line.template.id,
              name: line.template.name,
              version: line.templateVersion.version,
              available: line.template.status === 'PUBLISHED' && line.template.deletedAt === null,
            }
          : null;

      return {
        line,
        check: checkLine(line.id, line.quantity, facts, template),
        quote: quoteByLine.get(quoteKey(line.productId, this.orderableQuantityOf(line))) ?? null,
      };
    });

    const subtotalCents = lines.reduce((total, line) => total + this.lineTotalCents(line), 0);
    const catalogSubtotalCents = lines.reduce(
      (total, line) => total + this.catalogLineTotalCents(line),
      0,
    );

    const purchaseOrder = await this.checkPo(actor, cart);
    const budget = await this.checkBudget(cart, subtotalCents, now);

    const issues: CartIssue[] = lines.flatMap((line) => [...line.check.issues]);
    const warnings: CartIssue[] = lines.flatMap((line) => [...line.check.warnings]);

    if (!purchaseOrder.valid && purchaseOrder.problem) {
      issues.push({
        code: CartIssueCode[purchaseOrder.problem],
        message: purchaseOrder.message ?? 'The purchase order reference is not valid.',
        lineId: null,
        details: {
          prefix: purchaseOrder.policy.prefix,
          requiredBy: purchaseOrder.policy.requiredBy,
        },
      });
    }

    if (budget.wouldExceed) {
      issues.push({
        code: CartIssueCode.BUDGET_EXCEEDED,
        message:
          budget.capCents === 0
            ? 'This branch is not currently permitted to place orders.'
            : `This order would take the branch ${formatMoney(budget.overageCents)} over its monthly budget.`,
        lineId: null,
        details: {
          cap: formatMoney(budget.capCents ?? 0),
          spent: formatMoney(budget.spentCents),
          remaining: formatMoney(budget.remainingCents ?? 0),
          overage: formatMoney(budget.overageCents),
        },
      });
    }

    if (forCheckout) {
      issues.push(
        ...checkCheckoutDetails({
          hasLines: cart.lines.length > 0,
          siteId: cart.siteId,
          shippingAddressId: cart.shippingAddressId,
          shippingAddressUsable:
            cart.shippingAddress != null && cart.shippingAddress.deletedAt === null,
          paymentMethod: cart.paymentMethod,
          termsAcceptedAt: cart.termsAcceptedAt,
          requestedDeliveryDate: cart.requestedDeliveryDate,
          now,
        }),
      );
    }

    return {
      cart,
      lines,
      issues,
      warnings,
      valid: issues.length === 0,
      purchaseOrder,
      budget,
      billingPeriod: billingPeriodOf(now),
      subtotalCents,
      catalogSubtotalCents,
      savingCents: catalogSubtotalCents - subtotalCents,
    };
  }

  /**
   * The validated basket, refused unless it is ready to become an order.
   *
   * This is the "checkout session payload builder" the SOW asks for: BE-06
   * takes what this returns and writes the order from it, without re-deriving
   * anything. It deliberately does not create the order, reserve stock or
   * change the cart's status — all three belong to the write that BE-06 owns,
   * and doing any of them here would leave the system in a half-committed state
   * whenever the order write failed.
   */
  async checkoutSession(
    actor: AuthenticatedActor,
    requestedSiteId?: string,
  ): Promise<CartValidation> {
    const validation = await this.validate(actor, requestedSiteId, true);

    if (!validation.valid) {
      throw new BusinessRuleError('This basket is not ready to be ordered.', {
        details: { issues: validation.issues },
      });
    }

    return validation;
  }

  // --- Internals --------------------------------------------------------------

  /**
   * Which branch this request may act for.
   *
   * A site user is pinned to their own branch: passing another one is not a
   * request to be corrected with an error that confirms the branch exists. A
   * head-office user may name any branch in their account — the tenant scope
   * already bounds that — plus the ones granted through UserSiteAccess.
   */
  private async resolveSite(actor: AuthenticatedActor, requested?: string): Promise<string | null> {
    if (actor.role === Role.SITE_USER) return actor.siteId ?? null;
    if (!requested) return actor.siteId ?? null;

    const site = await withTenantScope(this.prisma, actor.accountId, (tx) =>
      tx.site.findFirst({
        where: { id: requested, deletedAt: null, status: 'ACTIVE' },
        select: { id: true },
      }),
    );

    // 404, not 403: the tenant scope means a site from another account is
    // already invisible, and a deactivated one should not be distinguishable
    // from a missing one.
    if (!site) throw new NotFoundError('Site');
    return site.id;
  }

  private async requireOwnedLine(actor: AuthenticatedActor, lineId: string): Promise<FullCart> {
    const line = await withTenantScope(this.prisma, actor.accountId, (tx) =>
      tx.cartLine.findFirst({
        where: { id: lineId },
        select: {
          id: true,
          cart: { select: { id: true, userId: true, siteId: true, status: true } },
        },
      }),
    );

    if (!line) throw new NotFoundError('Cart line');

    // The tenant scope has already bounded this to the account. What it cannot
    // express is "this user's basket", so it is checked here.
    if (line.cart.userId !== actor.userId) throw new NotFoundError('Cart line');
    if (line.cart.status !== 'OPEN') {
      throw new BusinessRuleError('This basket has already been checked out.', {
        details: { status: line.cart.status },
      });
    }

    return this.openCart(actor, line.cart.siteId ?? undefined);
  }

  /**
   * The product must exist, be orderable and be one the actor may see.
   *
   * Read through ProductsService's visibility rule via PricingService rather
   * than queried directly, so add-to-cart cannot become a second place that
   * decides what a customer may see.
   */
  private async requireOrderableProduct(
    actor: AuthenticatedActor,
    productId: string,
    variantId: string | null,
  ): Promise<{ sku: string }> {
    const [quote] = await this.pricing.quote(actor, { lines: [{ productId, quantity: 1 }] });

    if (!quote) throw new NotFoundError('Product');

    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { sku: true, status: true, options: { select: { id: true } } },
    });
    if (!product) throw new NotFoundError('Product');

    if (!(ORDERABLE_STATUSES as readonly string[]).includes(product.status)) {
      throw new BusinessRuleError('This product cannot currently be ordered.', {
        details: { sku: product.sku, status: product.status },
      });
    }

    if (variantId) {
      const variant = await this.prisma.productVariant.findFirst({
        where: { id: variantId, productId, deletedAt: null, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!variant) throw new NotFoundError('Product option');
    } else if (product.options.length > 0) {
      // A configurable product ordered without a configuration would reach
      // production with nothing saying what to print.
      throw new BusinessRuleError('Choose an option for this product before adding it.', {
        details: { sku: product.sku },
      });
    }

    return { sku: product.sku };
  }

  private async assertAddressUsable(
    actor: AuthenticatedActor,
    siteId: string | null,
    addressId: string,
    kind: 'SHIPPING' | 'BILLING',
  ): Promise<void> {
    const address = await withTenantScope(this.prisma, actor.accountId, (tx) =>
      tx.address.findFirst({
        where: {
          id: addressId,
          deletedAt: null,
          kind,
          // An account-level address (siteId null) is usable by any branch —
          // that is the head-office bill-to. A site-level one belongs to its
          // branch alone.
          OR: [{ siteId: null }, ...(siteId ? [{ siteId }] : [])],
        },
        select: { id: true },
      }),
    );

    if (!address) {
      throw new NotFoundError(kind === 'SHIPPING' ? 'Delivery address' : 'Billing address');
    }
  }

  private async checkPo(actor: AuthenticatedActor, cart: FullCart): Promise<PurchaseOrderCheck> {
    const [account, user] = await withTenantScope(this.prisma, actor.accountId, (tx) =>
      Promise.all([
        tx.account.findFirstOrThrow({
          where: { id: actor.accountId },
          select: { requirePoNumber: true, poPrefix: true },
        }),
        tx.user.findFirstOrThrow({
          where: { id: actor.userId },
          select: { poPrefix: true },
        }),
      ]),
    );

    const policy = resolvePurchaseOrderPolicy({
      site: cart.site ? { poRequired: cart.site.poRequired, poPrefix: cart.site.poPrefix } : null,
      account,
      userPoPrefix: user.poPrefix,
    });

    return checkPurchaseOrder(cart.poNumber, policy);
  }

  /**
   * The branch's cap against what it has already committed this period.
   *
   * "Committed" deliberately includes orders still awaiting approval. If it did
   * not, a branch could queue ten unapproved orders, each individually within
   * budget, and blow the cap the moment they were approved together. Drafts,
   * rejections and cancellations do not count — see COMMITTED_STATUSES.
   *
   * The sum is over `billingPeriod` on the order rather than over `createdAt`,
   * so it uses the same key BE-09 invoices by and cannot disagree with the
   * invoice by an order placed either side of midnight on the 1st.
   *
   * An account with no branch chosen yet has no cap to check: `evaluateBudget`
   * treats a null cap as uncapped, which is correct — the branch decides the
   * ceiling and there is no branch.
   */
  private async checkBudget(
    cart: FullCart,
    cartTotalCents: number,
    at: Date,
  ): Promise<BudgetStatus> {
    const capCents = cart.site?.monthlyBudget == null ? null : toCents(cart.site.monthlyBudget);

    // Nothing to measure against, so nothing to sum. Skipping the query here is
    // not an optimisation: an uncapped branch must never be blocked, and asking
    // the database first would only make that slower.
    if (capCents === null || !cart.siteId) {
      return evaluateBudget({ capCents, spentCents: 0, cartTotalCents });
    }

    const committed = await withTenantScope(this.prisma, cart.accountId, (tx) =>
      tx.order.aggregate({
        where: {
          siteId: cart.siteId!,
          billingPeriod: billingPeriodOf(at),
          status: { in: [...COMMITTED_STATUSES] },
        },
        _sum: { total: true },
      }),
    );

    return evaluateBudget({
      capCents,
      spentCents: committed._sum.total == null ? 0 : toCents(committed._sum.total),
      cartTotalCents,
    });
  }

  /**
   * Prices every line, in as few calls as the quote endpoint allows.
   *
   * Two things happen here that a naive one-call-per-cart version gets wrong.
   * Identical (product, quantity) pairs are asked for once — a basket with the
   * same SKU on four personalised lines at the same run length is one question,
   * not four. And the request is chunked, because the quote endpoint caps a
   * batch and a large re-order would otherwise be rejected outright rather than
   * priced.
   */
  private async quoteLines(actor: AuthenticatedActor, cart: FullCart): Promise<QuotedLine[]> {
    if (cart.lines.length === 0) return [];

    const wanted = new Map<string, { productId: string; quantity: number }>();
    for (const line of cart.lines) {
      const quantity = this.orderableQuantityOf(line);
      wanted.set(quoteKey(line.productId, quantity), { productId: line.productId, quantity });
    }

    const pending = [...wanted.values()];
    const quotes: QuotedLine[] = [];

    for (let index = 0; index < pending.length; index += QUOTE_BATCH_SIZE) {
      const batch = pending.slice(index, index + QUOTE_BATCH_SIZE);
      quotes.push(...(await this.pricing.quote(actor, { lines: batch })));
    }

    return quotes;
  }

  private factsFor(line: CartLineRow): LineProductFacts {
    return {
      productId: line.productId,
      sku: line.product.sku,
      name: line.product.name,
      orderable: (ORDERABLE_STATUSES as readonly string[]).includes(line.product.status),
      moq: line.product.moq,
      orderMultiple: line.product.orderMultiple,
      trackInventory: line.product.trackInventory,
      // A configured line draws on its variant's shelf, not the product's.
      availableStock: line.variant
        ? Math.max(0, line.variant.stockOnHand - line.variant.stockReserved)
        : Math.max(0, line.product.stockOnHand - line.product.stockReserved),
      variant: line.variant
        ? {
            id: line.variant.id,
            sku: line.variant.sku,
            active: line.variant.status === 'ACTIVE' && line.variant.deletedAt === null,
          }
        : null,
    };
  }

  /**
   * The quantity that would actually be ordered, used for pricing and for the
   * stock check.
   *
   * Priced at the rounded quantity rather than the typed one: rounding 120 up
   * to 500 is what the customer will be charged for, and quoting the 120 would
   * show a total the invoice then disagrees with.
   */
  private orderableQuantityOf(line: CartLineRow): number {
    return roundToOrderable(line.quantity, line.product.moq, line.product.orderMultiple);
  }

  private lineTotalCents(line: ValidatedLine): number {
    return line.quote?.breakdown.lineTotalCents ?? 0;
  }

  private catalogLineTotalCents(line: ValidatedLine): number {
    return line.quote?.breakdown.catalogLineTotalCents ?? 0;
  }
}

function toCents(value: { toFixed(digits: number): string }): number {
  return Math.round(Number(value.toFixed(2)) * 100);
}

function formatMoney(cents: number): string {
  return (cents / 100).toFixed(2);
}

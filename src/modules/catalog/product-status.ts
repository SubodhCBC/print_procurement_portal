import { BusinessRuleError } from '@/common';

/** Mirrors the Prisma `ProductStatus` enum; product-status.spec.ts asserts it. */
export const ProductStatus = {
  DRAFT: 'DRAFT',
  ACTIVE: 'ACTIVE',
  UNAVAILABLE: 'UNAVAILABLE',
  SUPERSEDED: 'SUPERSEDED',
} as const;

export type ProductStatus = (typeof ProductStatus)[keyof typeof ProductStatus];

/**
 * The lifecycle, as a table rather than as a chain of `if`s scattered through
 * the service.
 *
 *   DRAFT ──────────► ACTIVE ◄──────► UNAVAILABLE
 *                       │                  │
 *                       └────────┬─────────┘
 *                                ▼
 *                           SUPERSEDED   (terminal)
 *
 * Two rules are worth stating outright, because both have caught people out:
 *
 * A product never returns to DRAFT. Once it has been orderable, orders and
 * invoices reference it, and "unpublish it back to draft" is asking for a
 * catalog item that live order lines point at but that no longer exists in the
 * catalogue. UNAVAILABLE is what that request actually means.
 *
 * SUPERSEDED is terminal. It is not "unavailable, permanently" — it carries a
 * pointer to the replacement, and re-order flows follow it. Allowing a way back
 * would leave that pointer describing a product that is on sale again.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<ProductStatus, readonly ProductStatus[]>> = {
  [ProductStatus.DRAFT]: [ProductStatus.ACTIVE],
  [ProductStatus.ACTIVE]: [ProductStatus.UNAVAILABLE, ProductStatus.SUPERSEDED],
  [ProductStatus.UNAVAILABLE]: [ProductStatus.ACTIVE, ProductStatus.SUPERSEDED],
  [ProductStatus.SUPERSEDED]: [],
};

export function canTransition(from: ProductStatus, to: ProductStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Whether a status transition needs a replacement product named alongside it.
 *
 * Only SUPERSEDED does, and it is mandatory: a superseded product with no
 * successor is a dead end for every customer trying to re-order it, and there
 * is no later step at which anyone would notice.
 */
export function requiresSuccessor(to: ProductStatus): boolean {
  return to === ProductStatus.SUPERSEDED;
}

/** Statuses a customer may see in the catalogue. DRAFT is ours alone. */
export const CUSTOMER_VISIBLE_STATUSES: readonly ProductStatus[] = [
  ProductStatus.ACTIVE,
  ProductStatus.UNAVAILABLE,
  ProductStatus.SUPERSEDED,
];

/** Statuses that can actually be added to a cart. Checked again by BE-05. */
export const ORDERABLE_STATUSES: readonly ProductStatus[] = [ProductStatus.ACTIVE];

export function isOrderable(status: ProductStatus): boolean {
  return ORDERABLE_STATUSES.includes(status);
}

/**
 * Validates a requested transition, throwing the message an administrator
 * should see rather than a generic rejection.
 */
export function assertTransition(from: ProductStatus, to: ProductStatus): void {
  if (from === to) {
    throw new BusinessRuleError(`This product is already ${to}`, {
      details: { from, to },
    });
  }

  if (from === ProductStatus.SUPERSEDED) {
    throw new BusinessRuleError(
      'A superseded product cannot change status. Create a new product instead.',
      { details: { from, to } },
    );
  }

  if (to === ProductStatus.DRAFT) {
    throw new BusinessRuleError(
      'A product cannot return to draft once it has been published. Mark it unavailable instead.',
      { details: { from, to } },
    );
  }

  if (!canTransition(from, to)) {
    throw new BusinessRuleError(`A ${from} product cannot become ${to}`, {
      details: { from, to, allowed: ALLOWED_TRANSITIONS[from] },
    });
  }
}

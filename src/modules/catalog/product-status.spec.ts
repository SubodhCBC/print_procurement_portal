import { describe, expect, it } from 'vitest';
import { BusinessRuleError } from '@/common';
import {
  assertTransition,
  canTransition,
  CUSTOMER_VISIBLE_STATUSES,
  isOrderable,
  ProductStatus,
  requiresSuccessor,
} from './product-status';

describe('ProductStatus', () => {
  it('has a key equal to its value for every entry', () => {
    // The values are persisted in products.status and compared as strings.
    for (const [key, value] of Object.entries(ProductStatus)) {
      expect(value).toBe(key);
    }
  });

  it('hides DRAFT from customers', () => {
    expect(CUSTOMER_VISIBLE_STATUSES).not.toContain(ProductStatus.DRAFT);
    expect(CUSTOMER_VISIBLE_STATUSES).toContain(ProductStatus.ACTIVE);
  });

  it('lets only ACTIVE products be ordered', () => {
    expect(isOrderable(ProductStatus.ACTIVE)).toBe(true);
    expect(isOrderable(ProductStatus.DRAFT)).toBe(false);
    expect(isOrderable(ProductStatus.UNAVAILABLE)).toBe(false);
    expect(isOrderable(ProductStatus.SUPERSEDED)).toBe(false);
  });
});

describe('canTransition', () => {
  it('publishes a draft', () => {
    expect(canTransition(ProductStatus.DRAFT, ProductStatus.ACTIVE)).toBe(true);
  });

  it('moves freely between ACTIVE and UNAVAILABLE', () => {
    expect(canTransition(ProductStatus.ACTIVE, ProductStatus.UNAVAILABLE)).toBe(true);
    expect(canTransition(ProductStatus.UNAVAILABLE, ProductStatus.ACTIVE)).toBe(true);
  });

  it('supersedes from either saleable state', () => {
    expect(canTransition(ProductStatus.ACTIVE, ProductStatus.SUPERSEDED)).toBe(true);
    expect(canTransition(ProductStatus.UNAVAILABLE, ProductStatus.SUPERSEDED)).toBe(true);
  });

  it('never returns a product to DRAFT', () => {
    // Orders and invoices reference a published product; unpublishing it back
    // to draft leaves live order lines pointing at a catalogue item that is no
    // longer in the catalogue.
    expect(canTransition(ProductStatus.ACTIVE, ProductStatus.DRAFT)).toBe(false);
    expect(canTransition(ProductStatus.UNAVAILABLE, ProductStatus.DRAFT)).toBe(false);
  });

  it('treats SUPERSEDED as terminal', () => {
    for (const to of Object.values(ProductStatus)) {
      expect(canTransition(ProductStatus.SUPERSEDED, to)).toBe(false);
    }
  });

  it('does not let a draft skip straight to unavailable or superseded', () => {
    expect(canTransition(ProductStatus.DRAFT, ProductStatus.UNAVAILABLE)).toBe(false);
    expect(canTransition(ProductStatus.DRAFT, ProductStatus.SUPERSEDED)).toBe(false);
  });
});

describe('requiresSuccessor', () => {
  it('demands a replacement only when superseding', () => {
    expect(requiresSuccessor(ProductStatus.SUPERSEDED)).toBe(true);
    expect(requiresSuccessor(ProductStatus.ACTIVE)).toBe(false);
    expect(requiresSuccessor(ProductStatus.UNAVAILABLE)).toBe(false);
  });
});

describe('assertTransition', () => {
  it('accepts a legal move', () => {
    expect(() => assertTransition(ProductStatus.DRAFT, ProductStatus.ACTIVE)).not.toThrow();
  });

  it('rejects a no-op with a message that says so', () => {
    expect(() => assertTransition(ProductStatus.ACTIVE, ProductStatus.ACTIVE)).toThrow(
      /already ACTIVE/,
    );
  });

  it('explains why a superseded product cannot move', () => {
    expect(() => assertTransition(ProductStatus.SUPERSEDED, ProductStatus.ACTIVE)).toThrow(
      /cannot change status/,
    );
  });

  it('points at UNAVAILABLE when someone asks to unpublish', () => {
    // The most common wrong request, so the error names the right one.
    expect(() => assertTransition(ProductStatus.ACTIVE, ProductStatus.DRAFT)).toThrow(
      /mark it unavailable/i,
    );
  });

  it('throws a BusinessRuleError, not a bare Error', () => {
    // The exception filter maps it to 422 with a stable code; a plain Error
    // would surface as a 500 and page someone.
    expect(() => assertTransition(ProductStatus.DRAFT, ProductStatus.SUPERSEDED)).toThrow(
      BusinessRuleError,
    );
  });

  it('lists what was allowed instead', () => {
    try {
      assertTransition(ProductStatus.DRAFT, ProductStatus.UNAVAILABLE);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as BusinessRuleError).details).toMatchObject({
        allowed: [ProductStatus.ACTIVE],
      });
    }
  });
});

import { describe, expect, it } from 'vitest';
import { checkPurchaseOrder, resolvePurchaseOrderPolicy } from './purchase-order';

/**
 * SOW QA-01 names "PO format validator" as a unit-test target. A purchase order
 * that reaches production malformed is one the customer's finance team cannot
 * reconcile, which is discovered a month later at invoicing.
 */

const noAccountRule = { requirePoNumber: false, poPrefix: null };

describe('resolvePurchaseOrderPolicy — who decides a PO is required', () => {
  it('is not required when neither level asks for one', () => {
    const policy = resolvePurchaseOrderPolicy({ site: null, account: noAccountRule });

    expect(policy.required).toBe(false);
    expect(policy.requiredBy).toBe('NONE');
  });

  it('a branch can require one where the account does not', () => {
    const policy = resolvePurchaseOrderPolicy({
      site: { poRequired: true, poPrefix: null },
      account: noAccountRule,
    });

    expect(policy.required).toBe(true);
    expect(policy.requiredBy).toBe('SITE');
  });

  it('a branch cannot waive one the account requires', () => {
    // The account setting is a floor the customer's finance team set centrally.
    // If a branch could switch it off, the control would mean nothing.
    const policy = resolvePurchaseOrderPolicy({
      site: { poRequired: false, poPrefix: null },
      account: { requirePoNumber: true, poPrefix: null },
    });

    expect(policy.required).toBe(true);
    expect(policy.requiredBy).toBe('ACCOUNT');
  });
});

describe('resolvePurchaseOrderPolicy — which prefix applies', () => {
  it('falls back to the account prefix', () => {
    const policy = resolvePurchaseOrderPolicy({
      site: null,
      account: { requirePoNumber: true, poPrefix: 'ACM' },
    });

    expect(policy.prefix).toBe('ACM');
    expect(policy.prefixFrom).toBe('ACCOUNT');
  });

  it('the branch prefix beats the account one', () => {
    const policy = resolvePurchaseOrderPolicy({
      site: { poRequired: false, poPrefix: 'ACM-VIC' },
      account: { requirePoNumber: true, poPrefix: 'ACM' },
    });

    expect(policy.prefix).toBe('ACM-VIC');
    expect(policy.prefixFrom).toBe('SITE');
  });

  it("the buyer's own prefix beats both, because it is the narrowest allocation", () => {
    const policy = resolvePurchaseOrderPolicy({
      site: { poRequired: false, poPrefix: 'ACM-VIC' },
      account: { requirePoNumber: true, poPrefix: 'ACM' },
      userPoPrefix: 'ACM-VIC-JD',
    });

    expect(policy.prefix).toBe('ACM-VIC-JD');
    expect(policy.prefixFrom).toBe('USER');
  });

  it('treats a blank prefix as no prefix rather than as an empty one', () => {
    // An empty string passes `startsWith` for every input, which would silently
    // disable the check instead of falling through to the level that set one.
    const policy = resolvePurchaseOrderPolicy({
      site: { poRequired: false, poPrefix: '   ' },
      account: { requirePoNumber: false, poPrefix: 'ACM' },
    });

    expect(policy.prefix).toBe('ACM');
    expect(policy.prefixFrom).toBe('ACCOUNT');
  });
});

describe('checkPurchaseOrder', () => {
  const required = resolvePurchaseOrderPolicy({
    site: { poRequired: true, poPrefix: 'ACM' },
    account: noAccountRule,
  });
  const optionalWithPrefix = resolvePurchaseOrderPolicy({
    site: null,
    account: { requirePoNumber: false, poPrefix: 'ACM' },
  });
  const noRule = resolvePurchaseOrderPolicy({ site: null, account: noAccountRule });

  it('accepts a reference that matches the prefix', () => {
    const result = checkPurchaseOrder('ACM-99213', required);

    expect(result.valid).toBe(true);
    expect(result.problem).toBeNull();
    expect(result.provided).toBe('ACM-99213');
  });

  it('refuses a missing reference when one is required', () => {
    const result = checkPurchaseOrder(null, required);

    expect(result.valid).toBe(false);
    expect(result.problem).toBe('PO_REQUIRED');
    // The message names the prefix, so the buyer is not left guessing.
    expect(result.message).toContain('ACM');
  });

  it('treats whitespace as missing', () => {
    expect(checkPurchaseOrder('   ', required).problem).toBe('PO_REQUIRED');
  });

  it('accepts nothing at all when no rule applies', () => {
    const result = checkPurchaseOrder(null, noRule);

    expect(result.valid).toBe(true);
    expect(result.provided).toBeNull();
  });

  it('refuses a reference with the wrong prefix', () => {
    const result = checkPurchaseOrder('XYZ-99213', required);

    expect(result.valid).toBe(false);
    expect(result.problem).toBe('PO_PREFIX_MISMATCH');
  });

  it('enforces the prefix even when the PO itself is optional', () => {
    // A voluntarily-supplied PO still has to reconcile against the customer's
    // own ledger. Accepting a malformed one because it was optional defeats the
    // point of configuring a prefix.
    const result = checkPurchaseOrder('XYZ-1', optionalWithPrefix);

    expect(result.valid).toBe(false);
    expect(result.problem).toBe('PO_PREFIX_MISMATCH');
  });

  it('compares the prefix case-insensitively', () => {
    // Finance systems are inconsistent about case; rejecting this would be a
    // rule about shift keys, not about purchase orders.
    expect(checkPurchaseOrder('acm-99213', required).valid).toBe(true);
  });

  it('stores the reference exactly as typed', () => {
    expect(checkPurchaseOrder('  acm-99213  ', required).provided).toBe('acm-99213');
  });

  it('refuses a reference too short to be one', () => {
    expect(checkPurchaseOrder('A1', noRule).problem).toBe('PO_TOO_SHORT');
  });

  it('refuses characters that will not survive a finance import', () => {
    // A trailing space is invisible and turns one reference into two that never
    // reconcile.
    expect(checkPurchaseOrder('ACM 99213', required).problem).toBe('PO_INVALID_CHARACTERS');
    expect(checkPurchaseOrder('ACM;DROP', required).problem).toBe('PO_INVALID_CHARACTERS');
  });

  it('accepts dash, slash and underscore, which real PO systems use', () => {
    expect(checkPurchaseOrder('ACM/2026_11-004', required).valid).toBe(true);
  });

  it('reports the length problem before the prefix one', () => {
    // "AC" fails both. The length message is the more actionable of the two.
    expect(checkPurchaseOrder('AC', required).problem).toBe('PO_TOO_SHORT');
  });
});

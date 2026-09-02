/**
 * The purchase-order rule, and whether a given reference satisfies it.
 *
 * Pure and free of Prisma: SOW QA-01 names "PO format validator" as a unit-test
 * target, and BE-06 re-checks the same rule when a cart becomes an order —
 * because the rule can change between the two, and an order that reaches
 * production without a valid PO is one finance cannot pay against.
 */

/** Where a purchase-order rule can come from. */
export interface PurchaseOrderPolicySource {
  /** The branch's own rule. Null fields mean "not set here". */
  readonly site: { readonly poRequired: boolean; readonly poPrefix: string | null } | null;
  /** The account-wide default. */
  readonly account: { readonly requirePoNumber: boolean; readonly poPrefix: string | null };
  /**
   * The buyer's own prefix, from `User.poPrefix`. Some customers allocate PO
   * ranges per buyer, and that is narrower than the branch's.
   */
  readonly userPoPrefix?: string | null;
}

export interface PurchaseOrderPolicy {
  readonly required: boolean;
  readonly prefix: string | null;
  /** Which level decided it, so the UI can say why. */
  readonly requiredBy: 'SITE' | 'ACCOUNT' | 'NONE';
  readonly prefixFrom: 'USER' | 'SITE' | 'ACCOUNT' | 'NONE';
}

export type PurchaseOrderProblem =
  'PO_REQUIRED' | 'PO_PREFIX_MISMATCH' | 'PO_TOO_SHORT' | 'PO_INVALID_CHARACTERS';

export interface PurchaseOrderCheck {
  readonly policy: PurchaseOrderPolicy;
  readonly provided: string | null;
  readonly valid: boolean;
  readonly problem: PurchaseOrderProblem | null;
  readonly message: string | null;
}

/**
 * A PO reference is quoted on an invoice and keyed into the customer's own
 * finance system, so it is deliberately narrow: letters, digits, dash, slash
 * and underscore. Spaces are excluded because a trailing one is invisible and
 * turns "PO-1234" and "PO-1234 " into two references that will not reconcile.
 */
const PO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_-]*$/;

/** Short enough to be a typo rather than a reference. */
const MIN_PO_LENGTH = 3;

/**
 * Resolves the rule in force.
 *
 * **The site wins over the account, and requirement only ever tightens.** A
 * branch may demand a PO where the account does not; it may not waive one the
 * account requires. The account-level setting is a floor the customer's finance
 * team set centrally, and letting a branch switch it off would make the control
 * meaningless — which is not what "a site may override both" in the schema means
 * and is worth being explicit about here.
 *
 * The prefix narrows the other way: the most specific one wins, because it is
 * the most specific allocation. A buyer with `ACM-JD` sits inside the branch's
 * `ACM`, and checking the buyer's is the stricter test.
 */
export function resolvePurchaseOrderPolicy(source: PurchaseOrderPolicySource): PurchaseOrderPolicy {
  const siteRequires = source.site?.poRequired ?? false;
  const accountRequires = source.account.requirePoNumber;

  const prefix =
    trimmed(source.userPoPrefix) ??
    trimmed(source.site?.poPrefix) ??
    trimmed(source.account.poPrefix);

  return {
    required: siteRequires || accountRequires,
    prefix,
    requiredBy: siteRequires ? 'SITE' : accountRequires ? 'ACCOUNT' : 'NONE',
    prefixFrom: trimmed(source.userPoPrefix)
      ? 'USER'
      : trimmed(source.site?.poPrefix)
        ? 'SITE'
        : trimmed(source.account.poPrefix)
          ? 'ACCOUNT'
          : 'NONE',
  };
}

/**
 * Checks a reference against the rule.
 *
 * The prefix is enforced **whenever one is configured and a reference was
 * given**, not only when a PO is required. A customer who supplies a PO
 * voluntarily still needs it to reconcile against their own ledger, and
 * accepting a malformed one because it was optional defeats the point of
 * having a prefix at all.
 *
 * The comparison is case-insensitive, but the reference is stored as typed:
 * finance systems are inconsistent about case and rejecting "acm-1234" against
 * a prefix of "ACM" would be a rule about shift keys rather than about
 * purchase orders.
 */
export function checkPurchaseOrder(
  provided: string | null | undefined,
  policy: PurchaseOrderPolicy,
): PurchaseOrderCheck {
  const value = trimmed(provided);

  if (value === null) {
    return policy.required
      ? {
          policy,
          provided: null,
          valid: false,
          problem: 'PO_REQUIRED',
          message: policy.prefix
            ? `A purchase order reference is required, and must start with "${policy.prefix}".`
            : 'A purchase order reference is required.',
        }
      : { policy, provided: null, valid: true, problem: null, message: null };
  }

  if (value.length < MIN_PO_LENGTH) {
    return {
      policy,
      provided: value,
      valid: false,
      problem: 'PO_TOO_SHORT',
      message: `A purchase order reference must be at least ${MIN_PO_LENGTH} characters.`,
    };
  }

  if (!PO_PATTERN.test(value)) {
    return {
      policy,
      provided: value,
      valid: false,
      problem: 'PO_INVALID_CHARACTERS',
      message:
        'A purchase order reference may contain letters, digits, dash, slash and underscore only.',
    };
  }

  if (policy.prefix && !value.toUpperCase().startsWith(policy.prefix.toUpperCase())) {
    return {
      policy,
      provided: value,
      valid: false,
      problem: 'PO_PREFIX_MISMATCH',
      message: `This purchase order reference must start with "${policy.prefix}".`,
    };
  }

  return { policy, provided: value, valid: true, problem: null, message: null };
}

function trimmed(value: string | null | undefined): string | null {
  if (value == null) return null;
  const result = value.trim();
  return result.length > 0 ? result : null;
}

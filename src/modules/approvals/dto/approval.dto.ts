import { z } from 'zod';

const PortalRole = z.enum(['ADMIN', 'HEAD_OFFICE', 'SITE_USER']);

/** Money as a string — a NUMERIC column, and a JSON number would be rounded. */
const Money = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, 'Expected an amount such as "1000.00"');

/**
 * A rule is a set of conditions plus one approver.
 *
 * Every condition is optional and an omitted one does not constrain, so a rule
 * with none matches every order — that is how "all orders need head-office
 * sign-off" is written. It is also why the refinements below matter: a rule
 * with no approver would strand every order it matched, with nobody able to
 * decide and nothing to say why.
 */
const ruleFields = {
  name: z.string().trim().min(1, 'Give the rule a name').max(200),
  description: z.string().trim().max(1000).nullish(),
  active: z.boolean().default(true),
  /** Order total at or above this. Inclusive — see the note in the engine. */
  minTotal: Money.nullish(),
  categoryId: z.string().trim().max(64).nullish(),
  requesterRole: PortalRole.nullish(),
  siteId: z.string().trim().max(64).nullish(),
  /** Which round of approval. Walked lowest first. */
  tier: z.coerce.number().int().min(1).max(20).default(1),
  approverRole: PortalRole.nullish(),
  approverUserId: z.string().trim().max(64).nullish(),
};

const hasExactlyOneApprover = (value: {
  approverRole?: unknown;
  approverUserId?: unknown;
}): boolean => (value.approverRole != null ? 1 : 0) + (value.approverUserId != null ? 1 : 0) === 1;

export const CreateApprovalRuleSchema = z
  .object({
    /** Administrators only; everyone else writes rules for their own account. */
    accountId: z.string().trim().max(64).optional(),
    ...ruleFields,
  })
  .refine(hasExactlyOneApprover, 'Name exactly one approver — a role or a person, not both');

export type CreateApprovalRuleDto = z.infer<typeof CreateApprovalRuleSchema>;

export const UpdateApprovalRuleSchema = z
  .object({
    name: ruleFields.name.optional(),
    description: ruleFields.description,
    active: z.boolean().optional(),
    minTotal: Money.nullish(),
    categoryId: z.string().trim().max(64).nullish(),
    requesterRole: PortalRole.nullish(),
    siteId: z.string().trim().max(64).nullish(),
    tier: z.coerce.number().int().min(1).max(20).optional(),
    approverRole: PortalRole.nullish(),
    approverUserId: z.string().trim().max(64).nullish(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update')
  .refine(
    (value) =>
      // Only checked when the approver is being changed at all: an update that
      // touches neither field leaves whatever the rule already had.
      (value.approverRole === undefined && value.approverUserId === undefined) ||
      hasExactlyOneApprover(value),
    'Name exactly one approver — a role or a person, not both',
  );

export type UpdateApprovalRuleDto = z.infer<typeof UpdateApprovalRuleSchema>;

/**
 * A decision on one step.
 *
 * A refusal must say why — SOW BE-07 is explicit about rejection, and a change
 * request with no note is useless to the buyer who has to act on it. The
 * database enforces the same rule, so no path can produce a silent refusal.
 */
export const DecideApprovalSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED', 'CHANGES_REQUESTED']),
    comment: z.string().trim().max(2000).optional(),
  })
  .refine(
    (value) => value.decision === 'APPROVED' || (value.comment?.length ?? 0) > 0,
    'Say why: a rejection or a change request needs a reason',
  );

export type DecideApprovalDto = z.infer<typeof DecideApprovalSchema>;

export const ListApprovalsQuerySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED', 'CANCELLED']).optional(),
  accountId: z.string().trim().max(64).optional(),
  /**
   * Only what this actor can decide right now: open, at the current tier, and
   * addressed to them by name or by role. The query the approvals hub makes.
   */
  mine: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListApprovalsQueryDto = z.infer<typeof ListApprovalsQuerySchema>;

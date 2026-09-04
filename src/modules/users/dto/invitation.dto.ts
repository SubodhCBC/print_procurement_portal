import { z } from 'zod';
import { PAGINATION_DEFAULT_LIMIT, PAGINATION_MAX_LIMIT } from '@/common';

/**
 * Lower-cased on the way in.
 *
 * The address becomes the invited user's `login`, which is unique
 * case-sensitively in the database. Without normalising here,
 * "Jo@example.com" and "jo@example.com" would be two accounts for one person.
 */
const Email = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);

/**
 * The password an invited user chooses.
 *
 * A minimum is enforced here and deliberately not on the login endpoint: a
 * legacy user's existing password may be shorter than today's policy and
 * rejecting it would lock out the very people the migration exists to carry
 * over. A password being set for the first time has no such excuse.
 *
 * Length only, no character-class rules — NIST dropped composition rules
 * because they push people towards "Password1!" and away from length.
 */
export const NewPassword = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(256, 'Use at most 256 characters');

export const CreateInvitationSchema = z
  .object({
    /** ADMIN only; everyone else invites into their own account. */
    accountId: z.string().trim().max(64).optional(),
    email: Email,
    firstName: z.string().trim().min(1, 'First name is required').max(100),
    lastName: z.string().trim().min(1, 'Last name is required').max(100),
    role: z.enum(['ADMIN', 'HEAD_OFFICE', 'SITE_USER']),
    userType: z.enum(['NEW', 'EXTERNAL']).default('NEW'),
    /** Required for EXTERNAL and for SITE_USER — see the refinement below. */
    siteId: z.string().trim().max(64).optional(),
  })
  .refine((value) => value.userType !== 'EXTERNAL' || value.siteId !== undefined, {
    // An external collaborator with no site is account-wide by omission, which
    // is the opposite of the least-privilege rule the architecture document
    // sets for this category.
    message: 'An external user must be attached to a site',
    path: ['siteId'],
  })
  .refine((value) => value.role !== 'SITE_USER' || value.siteId !== undefined, {
    message: 'A site user must be attached to a site',
    path: ['siteId'],
  })
  .refine((value) => value.userType !== 'EXTERNAL' || value.role !== 'ADMIN', {
    message: 'An external user cannot be an administrator',
    path: ['role'],
  });

export type CreateInvitationDto = z.infer<typeof CreateInvitationSchema>;

export const AcceptInvitationSchema = z.object({
  token: z.string().min(1, 'Invitation token is required').max(256),
  password: NewPassword,
});

export type AcceptInvitationDto = z.infer<typeof AcceptInvitationSchema>;

export const ListInvitationsQuerySchema = z.object({
  accountId: z.string().trim().max(64).optional(),
  status: z.enum(['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED']).optional(),
  cursor: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(PAGINATION_MAX_LIMIT).default(PAGINATION_DEFAULT_LIMIT),
});

export type ListInvitationsQueryDto = z.infer<typeof ListInvitationsQuerySchema>;

/**
 * Accepts a login or an email, because a user who has forgotten their password
 * has usually also forgotten which of the two we asked for.
 */
export const RequestPasswordResetSchema = z.object({
  identifier: z.string().trim().min(1, 'Enter your login or email address').max(254),
});

export type RequestPasswordResetDto = z.infer<typeof RequestPasswordResetSchema>;

export const ResetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required').max(256),
  password: NewPassword,
});

export type ResetPasswordDto = z.infer<typeof ResetPasswordSchema>;

/**
 * A signed-in user changing their own password.
 *
 * The current password is required even though the caller already holds a
 * valid access token: a token can have been picked up from a shared machine,
 * and re-proving the credential is what stops a borrowed session from locking
 * its owner out. It is deliberately not run through `NewPassword` — the
 * existing password has to be accepted whatever rules were in force when it
 * was set.
 */
export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: NewPassword,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'The new password must be different from the current one',
    path: ['newPassword'],
  });

export type ChangePasswordDto = z.infer<typeof ChangePasswordSchema>;

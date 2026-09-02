import { z } from 'zod';
import { ALL_PERMISSIONS, PAGINATION_DEFAULT_LIMIT, PAGINATION_MAX_LIMIT } from '@/common';

export const ListUsersQuerySchema = z.object({
  accountId: z.string().trim().max(64).optional(),
  siteId: z.string().trim().max(64).optional(),
  role: z.enum(['ADMIN', 'HEAD_OFFICE', 'SITE_USER']).optional(),
  status: z.enum(['ACTIVE', 'PENDING', 'DISABLED']).optional(),
  userType: z.enum(['EXISTING', 'NEW', 'EXTERNAL']).optional(),
  /** Case-insensitive match against login, email, first or last name. */
  search: z.string().trim().max(120).optional(),
  cursor: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(PAGINATION_MAX_LIMIT).default(PAGINATION_DEFAULT_LIMIT),
});

export type ListUsersQueryDto = z.infer<typeof ListUsersQuerySchema>;

/**
 * What an administrator may change about a user.
 *
 * Not here: email, login, first and last name for a legacy user. Those are
 * replicated from the legacy database on every re-sync, so editing them would
 * produce a change that silently reverts within LEGACY_USER_SYNC_TTL_SECONDS —
 * worse than refusing, because the administrator believes it worked.
 */
export const UpdateUserSchema = z
  .object({
    role: z.enum(['ADMIN', 'HEAD_OFFICE', 'SITE_USER']).optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    /** Null detaches the user from their branch (account-wide head office). */
    siteId: z.string().trim().max(64).nullish(),
    /** Extra branches a HEAD_OFFICE user oversees. Replaces the whole set. */
    additionalSiteIds: z.array(z.string().trim().max(64)).max(200).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');

export type UpdateUserDto = z.infer<typeof UpdateUserSchema>;

/**
 * A per-user departure from the role baseline.
 *
 * `permission` is checked against the code catalog rather than accepted as free
 * text: a typo would otherwise be stored happily and then never match anything,
 * which looks exactly like a permission that does not work.
 */
export const GrantPermissionSchema = z.object({
  permission: z.enum(ALL_PERMISSIONS as unknown as [string, ...string[]]),
  effect: z.enum(['ALLOW', 'DENY']).default('ALLOW'),
  /** Narrows the grant to one object — a document id, a site id. */
  resourceId: z.string().trim().max(128).nullish(),
  reason: z.string().trim().max(500).optional(),
  /** ISO 8601. Omit for a permanent grant. */
  expiresAt: z.coerce.date().optional(),
});

export type GrantPermissionDto = z.infer<typeof GrantPermissionSchema>;

export const RevokePermissionSchema = z.object({
  permission: z.enum(ALL_PERMISSIONS as unknown as [string, ...string[]]),
  resourceId: z.string().trim().max(128).nullish(),
});

export type RevokePermissionDto = z.infer<typeof RevokePermissionSchema>;

import { z } from 'zod';

/**
 * Login credentials.
 *
 * `login`, not email: `Users.Email` is not unique in the legacy database (159
 * groups of users share an address), so it cannot identify an account.
 * `Users.Login` is unique case-insensitively across all 4432 rows.
 */
export const LoginSchema = z.object({
  login: z.string().trim().min(1, 'Login is required').max(128),
  // Upper bound only. A minimum length would reject legacy users whose existing
  // password is shorter than today's policy, locking out the very people this
  // flow exists to migrate.
  password: z.string().min(1, 'Password is required').max(256),
});

export type LoginDto = z.infer<typeof LoginSchema>;

export const RefreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export type RefreshDto = z.infer<typeof RefreshSchema>;

export const LogoutSchema = RefreshSchema;
export type LogoutDto = RefreshDto;

import { pbkdf2Sync, randomBytes } from 'node:crypto';

/**
 * Builds a hash in ASP.NET SimpleMembership's format, for tests only.
 *
 * Written from the format spec rather than from the verifier's constants, so a
 * round trip cannot pass by having both sides wrong in the same way:
 *
 *   0x00 marker | 16-byte salt | PBKDF2-HMAC-SHA1(password, salt, 1000) -> 32 bytes
 *
 * Not exported from the module barrel — nothing in production should be
 * producing legacy-format hashes.
 */
export function hashSimpleMembership(password: string, salt = randomBytes(16)): string {
  const subkey = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, 1000, 32, 'sha1');
  return Buffer.concat([Buffer.from([0x00]), salt, subkey]).toString('base64');
}

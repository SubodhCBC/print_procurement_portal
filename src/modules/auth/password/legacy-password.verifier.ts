import { pbkdf2, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { compare as bcryptCompare } from 'bcryptjs';

const pbkdf2Async = promisify(pbkdf2);

/**
 * Which legacy scheme accepted the password. Recorded on the login so the
 * rollout of the newer bcrypt column can be tracked, and so a spike in
 * PBKDF2 logins after that rollout is visible.
 */
export type LegacyHashScheme = 'bcrypt' | 'aspnet-simple-membership';

export interface LegacyPasswordVerification {
  readonly valid: boolean;
  readonly scheme?: LegacyHashScheme;
}

// --- ASP.NET SimpleMembership (webpages_Membership.Password) ----------------
//
// System.Web.Helpers.Crypto.HashPassword produces:
//
//   byte 0        0x00  format marker
//   bytes 1..16   salt      (16 bytes)
//   bytes 17..48  subkey    (32 bytes)  = PBKDF2-HMAC-SHA1(password, salt, 1000)
//
// 49 bytes, Base64-encoded to exactly 68 characters — which is what all 5406
// rows in webpages_Membership measure. The salt is embedded, which is why the
// separate PasswordSalt column is empty for every row.

const MARKER_BYTE = 0x00;
const SALT_LENGTH = 16;
const SUBKEY_LENGTH = 32;
const HASH_LENGTH = 1 + SALT_LENGTH + SUBKEY_LENGTH;
const PBKDF2_ITERATIONS = 1000;

/**
 * Verifies a password against an ASP.NET SimpleMembership hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupt row upstream
 * must read as "wrong password", never as a 500 that tells an attacker their
 * guess hit an interesting account.
 */
export async function verifySimpleMembershipPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(storedHash, 'base64');
  } catch {
    return false;
  }

  if (decoded.length !== HASH_LENGTH || decoded[0] !== MARKER_BYTE) return false;

  const salt = decoded.subarray(1, 1 + SALT_LENGTH);
  const expectedSubkey = decoded.subarray(1 + SALT_LENGTH);

  // .NET's Rfc2898DeriveBytes(string, ...) encodes the password as UTF-8.
  const actualSubkey = await pbkdf2Async(
    Buffer.from(password, 'utf8'),
    salt,
    PBKDF2_ITERATIONS,
    SUBKEY_LENGTH,
    'sha1',
  );

  return timingSafeEqual(actualSubkey, expectedSubkey);
}

/** `$2a$11$…` — the newer scheme, present on Users.UserPassword for some users. */
export async function verifyBcryptPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    return await bcryptCompare(password, storedHash);
  } catch {
    // bcryptjs throws on a malformed hash; same reasoning as above.
    return false;
  }
}

export interface LegacyCredentialMaterial {
  /** `Users.UserPassword` — bcrypt. Set for 938 of 4432 users. */
  readonly bcryptHash?: string | null;
  /** `webpages_Membership.Password` — PBKDF2. Set for every user. */
  readonly membershipHash?: string | null;
}

/**
 * Verifies a password against whichever legacy hashes exist for the user.
 *
 * Both columns are checked, not just the newest one present. The two are
 * written by different parts of the legacy application and there is no
 * guarantee that a password change updates both — 938 users carry both hashes,
 * and treating either as authoritative alone would lock out whichever half is
 * stale. Accepting either matches what the legacy application itself does.
 *
 * bcrypt is tried first purely because it is the newer scheme and therefore the
 * more likely match; the outcome does not depend on the order.
 */
export async function verifyLegacyPassword(
  password: string,
  material: LegacyCredentialMaterial,
): Promise<LegacyPasswordVerification> {
  if (material.bcryptHash && (await verifyBcryptPassword(password, material.bcryptHash))) {
    return { valid: true, scheme: 'bcrypt' };
  }

  if (
    material.membershipHash &&
    (await verifySimpleMembershipPassword(password, material.membershipHash))
  ) {
    return { valid: true, scheme: 'aspnet-simple-membership' };
  }

  return { valid: false };
}

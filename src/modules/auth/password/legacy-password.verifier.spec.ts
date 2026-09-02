import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { hashSync } from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import {
  verifyBcryptPassword,
  verifyLegacyPassword,
  verifySimpleMembershipPassword,
} from './legacy-password.verifier';

/**
 * Produces a hash in ASP.NET SimpleMembership's format.
 *
 * Test-only, and deliberately written from the format spec rather than by
 * reusing the verifier's own constants — a round trip through shared constants
 * would pass just as happily if both sides were wrong together.
 */
function hashSimpleMembership(password: string, salt = randomBytes(16)): string {
  const subkey = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, 1000, 32, 'sha1');
  return Buffer.concat([Buffer.from([0x00]), salt, subkey]).toString('base64');
}

describe('verifySimpleMembershipPassword', () => {
  it('produces the 68-character, 49-byte shape observed in webpages_Membership', () => {
    // Every one of the 5406 rows in the live database matches this shape, and
    // 300 sampled rows decode to exactly 49 bytes with a 0x00 marker.
    const hash = hashSimpleMembership('whatever');
    const decoded = Buffer.from(hash, 'base64');

    expect(hash).toHaveLength(68);
    expect(decoded).toHaveLength(49);
    expect(decoded[0]).toBe(0x00);
  });

  it('accepts the correct password', async () => {
    const hash = hashSimpleMembership('correct horse battery staple');
    await expect(
      verifySimpleMembershipPassword('correct horse battery staple', hash),
    ).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = hashSimpleMembership('correct horse battery staple');
    await expect(
      verifySimpleMembershipPassword('Correct horse battery staple', hash),
    ).resolves.toBe(false);
  });

  it('handles non-ASCII passwords as UTF-8, the way .NET does', async () => {
    const password = 'pässwörd–ünïcode';
    const hash = hashSimpleMembership(password);
    await expect(verifySimpleMembershipPassword(password, hash)).resolves.toBe(true);
  });

  it.each([
    ['empty string', ''],
    ['not base64', '!!!not-base64!!!'],
    ['right length, wrong marker', Buffer.alloc(49, 0x01).toString('base64')],
    ['base64 of the wrong length', Buffer.alloc(32).toString('base64')],
    ['a bcrypt hash', '$2a$11$abcdefghijklmnopqrstuv'],
  ])('returns false rather than throwing for %s', async (_label, hash) => {
    await expect(verifySimpleMembershipPassword('anything', hash)).resolves.toBe(false);
  });
});

describe('verifyBcryptPassword', () => {
  // Cost 4 keeps the suite fast; the live column uses $2a$11$.
  const hash = hashSync('s3cret', 4);

  it('accepts the correct password', async () => {
    await expect(verifyBcryptPassword('s3cret', hash)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    await expect(verifyBcryptPassword('s3cret ', hash)).resolves.toBe(false);
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    await expect(verifyBcryptPassword('s3cret', 'not-a-bcrypt-hash')).resolves.toBe(false);
  });
});

describe('verifyLegacyPassword', () => {
  const password = 'Sh4red-P4ssw0rd';

  it('accepts a bcrypt-only user and reports the scheme', async () => {
    await expect(
      verifyLegacyPassword(password, { bcryptHash: hashSync(password, 4), membershipHash: null }),
    ).resolves.toEqual({ valid: true, scheme: 'bcrypt' });
  });

  it('accepts a membership-only user and reports the scheme', async () => {
    await expect(
      verifyLegacyPassword(password, {
        bcryptHash: null,
        membershipHash: hashSimpleMembership(password),
      }),
    ).resolves.toEqual({ valid: true, scheme: 'aspnet-simple-membership' });
  });

  it('falls through to the membership hash when the bcrypt one is stale', async () => {
    // The 938 users carrying both hashes can have them disagree: nothing
    // guarantees a legacy password change writes both columns. Accepting either
    // is what stops a stale column from locking a user out.
    await expect(
      verifyLegacyPassword(password, {
        bcryptHash: hashSync('an-older-password', 4),
        membershipHash: hashSimpleMembership(password),
      }),
    ).resolves.toEqual({ valid: true, scheme: 'aspnet-simple-membership' });
  });

  it('accepts a stale membership hash when bcrypt is current', async () => {
    await expect(
      verifyLegacyPassword(password, {
        bcryptHash: hashSync(password, 4),
        membershipHash: hashSimpleMembership('an-older-password'),
      }),
    ).resolves.toEqual({ valid: true, scheme: 'bcrypt' });
  });

  it('rejects when neither hash matches', async () => {
    await expect(
      verifyLegacyPassword('wrong', {
        bcryptHash: hashSync(password, 4),
        membershipHash: hashSimpleMembership(password),
      }),
    ).resolves.toEqual({ valid: false });
  });

  it('rejects a user with no credential material at all', async () => {
    await expect(
      verifyLegacyPassword(password, { bcryptHash: null, membershipHash: null }),
    ).resolves.toEqual({ valid: false });
  });

  it('rejects an empty password against an empty stored hash', async () => {
    // Guards the nastiest failure mode: a blank column reading as a match and
    // letting anyone in as that user.
    await expect(verifyLegacyPassword('', { bcryptHash: '', membershipHash: '' })).resolves.toEqual(
      { valid: false },
    );
  });
});

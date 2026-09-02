import { Inject, Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';
import { APP_CONFIG, type AppConfig } from '@/config';

/**
 * Parses the cost parameters out of an Argon2 PHC string:
 * `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`.
 *
 * @node-rs/argon2 has no needsRehash of its own, so this reads the encoded
 * parameters directly. Returns undefined for anything unparseable.
 */
export function parseArgon2Parameters(
  encoded: string,
): { memoryCost: number; timeCost: number; parallelism: number } | undefined {
  const match = /^\$argon2(?:id|i|d)\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(encoded);
  if (!match) return undefined;

  const [, memory, time, parallel] = match;
  return {
    memoryCost: Number(memory),
    timeCost: Number(time),
    parallelism: Number(parallel),
  };
}

/**
 * Hashes passwords for the portal's own database.
 *
 * Argon2id, not the legacy scheme. The legacy hashes are deliberately not
 * carried across: `webpages_Membership` uses PBKDF2-HMAC-SHA1 at 1000
 * iterations, which is roughly four orders of magnitude short of current
 * guidance and would have frozen a 2012 decision into the new system. Because
 * the plaintext is in hand at the moment of first login, re-hashing costs
 * nothing and upgrades every user as they arrive.
 *
 * Parameters come from config (PASSWORD_HASH_MEMORY_COST / _TIME_COST) so they
 * can be raised as hardware improves without a code change.
 */
@Injectable()
export class PasswordHasherService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private get options() {
    return {
      algorithm: Algorithm.Argon2id,
      // KiB. 19456 (19 MiB) with timeCost 2 is the OWASP baseline.
      memoryCost: this.config.auth.passwordHash.memoryCost,
      timeCost: this.config.auth.passwordHash.timeCost,
      parallelism: 1,
    };
  }

  async hash(plaintext: string): Promise<string> {
    return hash(plaintext, this.options);
  }

  /**
   * Returns false rather than throwing on a malformed or foreign hash — a bad
   * stored value must read as "wrong password", not as a 500 that distinguishes
   * this account from any other.
   */
  async verify(plaintext: string, storedHash: string): Promise<boolean> {
    try {
      // No options: Argon2 encodes its own parameters in the hash string, and
      // passing the *current* configuration here would make every hash written
      // under older settings fail to verify.
      return await verify(storedHash, plaintext);
    } catch {
      return false;
    }
  }

  /**
   * True when `storedHash` was produced with weaker parameters than the ones
   * now configured, so the caller can transparently upgrade it while it still
   * has the plaintext.
   */
  needsRehash(storedHash: string): boolean {
    const parsed = parseArgon2Parameters(storedHash);
    // Unparseable: treat as stale so the next successful login replaces it.
    if (!parsed) return true;

    const { memoryCost, timeCost, parallelism } = this.options;
    return (
      parsed.memoryCost < memoryCost ||
      parsed.timeCost < timeCost ||
      parsed.parallelism !== parallelism
    );
  }
}

import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Prefixed, sortable-ish public identifiers (`ord_01j9x…`).
 *
 * Why not expose the database primary key: a prefixed opaque id is
 * self-describing in logs and support tickets, is safe to paste into a URL,
 * and does not leak table row counts the way an auto-increment integer does.
 */
const ENCODING = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32, no I/L/O/U

function encodeBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ENCODING[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ENCODING[(value << (5 - bits)) & 31];

  return output;
}

/** 48-bit millisecond timestamp prefix keeps ids roughly time-ordered. */
function timeComponent(now: number): string {
  const buffer = Buffer.alloc(6);
  buffer.writeUIntBE(now, 0, 6);
  return encodeBase32(buffer);
}

export function createId(prefix: string, now: number = Date.now()): string {
  return `${prefix}_${timeComponent(now)}${encodeBase32(randomBytes(10))}`;
}

/** Correlation id for a single request; also used as the Sentry event tag. */
export function createRequestId(): string {
  return randomUUID();
}

export function createSecretToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

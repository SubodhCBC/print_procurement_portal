import { describe, expect, it } from 'vitest';
import { createId, createRequestId, createSecretToken } from './ids';

describe('ids', () => {
  it('prefixes the id and uses the safe alphabet', () => {
    const id = createId('ord');
    expect(id).toMatch(/^ord_[0-9abcdefghjkmnpqrstvwxyz]+$/);
  });

  it('produces unique ids within the same millisecond', () => {
    const now = Date.now();
    const ids = new Set(Array.from({ length: 500 }, () => createId('tpl', now)));
    expect(ids.size).toBe(500);
  });

  it('sorts lexicographically by creation time', () => {
    const earlier = createId('ord', 1_700_000_000_000);
    const later = createId('ord', 1_700_000_001_000);
    expect(earlier < later).toBe(true);
  });

  it('creates uuid request ids and url-safe secrets', () => {
    expect(createRequestId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(createSecretToken(32)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

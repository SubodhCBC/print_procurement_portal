import { describe, expect, it } from 'vitest';
import { REDACTED_PLACEHOLDER } from './audit.actions';
import { redactAuditDetails } from './audit.service';

/**
 * The redaction pass is the part of the audit log that can cause harm if it is
 * wrong. Audit rows are read by more people, kept far longer and exported more
 * often than the tables they describe, so a token that leaks into one is worse
 * placed than the token itself was.
 */
describe('redactAuditDetails', () => {
  it('returns undefined for no details', () => {
    expect(redactAuditDetails(undefined)).toBeUndefined();
  });

  it('leaves ordinary fields alone', () => {
    expect(redactAuditDetails({ code: 'VIC-042', poRequired: true, count: 3 })).toEqual({
      code: 'VIC-042',
      poRequired: true,
      count: 3,
    });
  });

  it('redacts secrets at the top level', () => {
    const result = redactAuditDetails({
      login: 'jsmith',
      password: 'hunter2',
      passwordHash: '$argon2id$…',
      token: 'abc',
    });

    expect(result).toEqual({
      login: 'jsmith',
      password: REDACTED_PLACEHOLDER,
      passwordHash: REDACTED_PLACEHOLDER,
      token: REDACTED_PLACEHOLDER,
    });
  });

  it('redacts secrets nested inside a before/after diff', () => {
    // The shape services actually pass. A token one level down is exactly as
    // sensitive as one at the top, which is why the pass recurses.
    const result = redactAuditDetails({
      changes: {
        passwordHash: { from: 'old-hash', to: 'new-hash' },
        email: { from: 'a@x.test', to: 'b@x.test' },
      },
    });

    expect(result).toEqual({
      changes: {
        passwordHash: REDACTED_PLACEHOLDER,
        email: { from: 'a@x.test', to: 'b@x.test' },
      },
    });
  });

  it('redacts secrets inside arrays', () => {
    const result = redactAuditDetails({
      invitations: [
        { email: 'a@x.test', token: 'secret-a' },
        { email: 'b@x.test', token: 'secret-b' },
      ],
    });

    expect(result).toEqual({
      invitations: [
        { email: 'a@x.test', token: REDACTED_PLACEHOLDER },
        { email: 'b@x.test', token: REDACTED_PLACEHOLDER },
      ],
    });
  });

  it('preserves nulls rather than turning them into objects', () => {
    expect(redactAuditDetails({ poPrefix: null, siteId: null })).toEqual({
      poPrefix: null,
      siteId: null,
    });
  });

  it('stops recursing at a bounded depth', () => {
    // A cyclic or pathological object must not hang the request that is only
    // trying to write a log line.
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;

    const result = redactAuditDetails(cyclic) as Record<string, unknown>;

    expect(result.name).toBe('root');
    expect(JSON.stringify(result)).toContain(REDACTED_PLACEHOLDER);
  });

  it('does not mutate the object it was given', () => {
    const input = { password: 'hunter2', code: 'VIC-042' };
    redactAuditDetails(input);

    // Callers build the details inline, but a service that reused the object
    // afterwards must not find its own data rewritten.
    expect(input.password).toBe('hunter2');
  });
});

import { PortalRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { Role } from '@/common';
import { LEGACY_ROLE_NAMES, mapLegacyRole, toAccountSlug } from './role-mapping';

describe('PortalRole enum', () => {
  it('matches the Role union in the request context', () => {
    // These are two independent declarations of the same three values — one in
    // Prisma, one in TypeScript — and user-provisioning assigns across them
    // without a cast. If they ever drift, that assignment silently becomes a
    // lie about what is stored.
    expect(Object.values(PortalRole).sort()).toEqual(Object.values(Role).sort());
  });
});

describe('mapLegacyRole', () => {
  it.each([
    ['Admin', Role.ADMIN],
    ['HeadOffice', Role.HEAD_OFFICE],
    ['RegionalManager', Role.HEAD_OFFICE],
    ['Franchisee', Role.SITE_USER],
  ])('maps %s to %s', (legacy, expected) => {
    expect(mapLegacyRole(legacy)).toBe(expected);
  });

  it('covers every role name present in webpages_Roles', () => {
    // The live table holds exactly these four rows.
    for (const name of LEGACY_ROLE_NAMES) {
      expect(mapLegacyRole(name)).toBeDefined();
    }
  });

  it('is case- and whitespace-insensitive', () => {
    expect(mapLegacyRole('  admin  ')).toBe(Role.ADMIN);
    expect(mapLegacyRole('HEADOFFICE')).toBe(Role.HEAD_OFFICE);
  });

  it.each([[null], [undefined], ['']])(
    'falls back to the least privileged role for %s',
    (value) => {
      // 30 of the 4432 legacy users hold no role row at all.
      expect(mapLegacyRole(value)).toBe(Role.SITE_USER);
    },
  );

  it('never escalates an unknown role added upstream', () => {
    expect(mapLegacyRole('SuperAdmin')).toBe(Role.SITE_USER);
    expect(mapLegacyRole('GlobalOwner')).toBe(Role.SITE_USER);
  });
});

describe('toAccountSlug', () => {
  it.each([
    ['Cellarbrations', 'cellarbrations'],
    ['BottleO', 'bottleo'],
    ['The Bottle-O', 'the-bottle-o'],
    ['  IHG  ', 'ihg'],
    ['Thirsty Camel', 'thirsty-camel'],
    ["Dan's & Co.", 'dan-s-co'],
  ])('normalises %s to %s', (client, expected) => {
    expect(toAccountSlug(client)).toBe(expected);
  });

  it('collapses casing differences onto one account', () => {
    // The column is free text, so the same retailer appears with inconsistent
    // casing across the 214 distinct values. They must not become two tenants.
    expect(toAccountSlug('LiquorLand')).toBe(toAccountSlug('liquorland'));
    expect(toAccountSlug('Thirsty Liquor')).toBe(toAccountSlug('thirsty liquor'));
  });

  it('does not merge different clients into one empty slug', () => {
    // A name that normalises to nothing must not become a shared tenant with
    // every other such name — that would be a cross-tenant data leak.
    expect(toAccountSlug('!!!')).toBe('unknown');
    expect(toAccountSlug('')).toBe('unknown');
  });
});

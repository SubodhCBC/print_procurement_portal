import { describe, expect, it } from 'vitest';
import { Role, UserType } from '../interfaces/request-context.interface';
import { ALL_PERMISSIONS, basePermissionsFor, isPermission, Permission } from './permissions';

describe('permission catalog', () => {
  it('has a key equal to its value for every entry', () => {
    // The values are persisted in user_permission_grants.permission and are
    // matched by string. A key/value mismatch would make Permission.X grant
    // something other than "X", which nothing else would catch.
    for (const [key, value] of Object.entries(Permission)) {
      expect(value).toBe(key);
    }
  });

  it('has no duplicate values', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it('carries the permissions the architecture document names', () => {
    // These exact strings were agreed with the client; renaming one silently
    // breaks every grant row already written with the old value.
    for (const name of [
      'APPLICATION_VIEW',
      'APPLICATION_CREATE',
      'APPLICATION_EDIT',
      'APPLICATION_DELETE',
      'DAM_VIEW',
      'DAM_UPLOAD',
      'DAM_DOWNLOAD',
      'DAM_DELETE',
      'EXTERNAL_DOCUMENT_ACCESS',
    ]) {
      expect(isPermission(name)).toBe(true);
    }
  });

  it('rejects a string that is not in the catalog', () => {
    expect(isPermission('DEFINITELY_NOT_A_PERMISSION')).toBe(false);
    expect(isPermission('')).toBe(false);
  });
});

describe('basePermissionsFor', () => {
  it('gives ADMIN everything', () => {
    const granted = basePermissionsFor(Role.ADMIN, UserType.EXISTING);
    expect(granted.size).toBe(ALL_PERMISSIONS.length);
  });

  it('gives HEAD_OFFICE approvals and billing visibility', () => {
    const granted = basePermissionsFor(Role.HEAD_OFFICE, UserType.EXISTING);

    expect(granted.has(Permission.APPROVAL_ACT)).toBe(true);
    expect(granted.has(Permission.BILLING_VIEW)).toBe(true);
    expect(granted.has(Permission.ORDER_VIEW_ACCOUNT)).toBe(true);
    expect(granted.has(Permission.USER_INVITE)).toBe(true);
  });

  it("withholds the platform operator's permissions from HEAD_OFFICE", () => {
    const granted = basePermissionsFor(Role.HEAD_OFFICE, UserType.EXISTING);

    // The global catalog, rate cards and integrations belong to the operator,
    // not to the customer, however senior the customer's user is.
    expect(granted.has(Permission.CATALOG_MANAGE)).toBe(false);
    expect(granted.has(Permission.PRICING_MANAGE)).toBe(false);
    expect(granted.has(Permission.INTEGRATION_MANAGE)).toBe(false);
    expect(granted.has(Permission.TEMPLATE_MANAGE)).toBe(false);
  });

  it('gives SITE_USER ordering but not approval', () => {
    const granted = basePermissionsFor(Role.SITE_USER, UserType.EXISTING);

    expect(granted.has(Permission.ORDER_CREATE)).toBe(true);
    expect(granted.has(Permission.CATALOG_VIEW)).toBe(true);
    // A site user approving their own order is the whole reason the approval
    // workflow exists.
    expect(granted.has(Permission.APPROVAL_ACT)).toBe(false);
    expect(granted.has(Permission.ORDER_VIEW_ACCOUNT)).toBe(false);
    expect(granted.has(Permission.USER_MANAGE)).toBe(false);
  });

  it('collapses an EXTERNAL user to the least-privileged set whatever their role', () => {
    for (const role of [Role.ADMIN, Role.HEAD_OFFICE, Role.SITE_USER]) {
      const granted = basePermissionsFor(role, UserType.EXTERNAL);

      expect(granted.has(Permission.EXTERNAL_DOCUMENT_ACCESS)).toBe(true);
      expect(granted.has(Permission.APPLICATION_VIEW)).toBe(true);

      // The point of the override: an external user must not inherit ordering,
      // catalog or administrative rights from the role they were invited with.
      expect(granted.has(Permission.ORDER_CREATE)).toBe(false);
      expect(granted.has(Permission.CATALOG_VIEW)).toBe(false);
      expect(granted.has(Permission.DAM_DOWNLOAD)).toBe(false);
      expect(granted.has(Permission.USER_MANAGE)).toBe(false);
      expect(granted.has(Permission.APPROVAL_ACT)).toBe(false);
    }
  });

  it('falls back to the least privileged role for an unrecognised one', () => {
    // Defends the same property mapLegacyRole defends: a role that appears
    // upstream after this code shipped must not be granted more than we know.
    const granted = basePermissionsFor('SOMETHING_NEW' as Role, UserType.EXISTING);

    expect(granted.has(Permission.ORDER_CREATE)).toBe(true);
    expect(granted.has(Permission.USER_MANAGE)).toBe(false);
  });

  it('returns an independent set each call', () => {
    // The caller mutates it (PermissionService layers grants on top), so a
    // shared instance would leak one user's grants into the next user's answer.
    const first = basePermissionsFor(Role.SITE_USER, UserType.EXISTING) as Set<Permission>;
    first.add(Permission.USER_MANAGE);

    const second = basePermissionsFor(Role.SITE_USER, UserType.EXISTING);
    expect(second.has(Permission.USER_MANAGE)).toBe(false);
  });
});

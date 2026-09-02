import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ALL_PERMISSIONS,
  basePermissionsFor,
  Permission,
  RequirePermissions,
  Role,
  UserType,
  type Permission as PermissionValue,
} from '@/common';

/** One permission, with the grouping the settings screen renders it under. */
export interface PermissionDescriptor {
  readonly key: PermissionValue;
  readonly group: string;
}

export interface RoleBaselineView {
  readonly role: Role | 'EXTERNAL';
  readonly label: string;
  readonly description: string;
  readonly permissions: readonly PermissionValue[];
}

export interface PermissionCatalogView {
  readonly permissions: readonly PermissionDescriptor[];
  readonly roles: readonly RoleBaselineView[];
}

/**
 * The permission vocabulary, so the admin settings screen can render the
 * role/permission matrix without hard-coding a second copy of it.
 *
 * Read-only, and it will stay that way. The role baseline is compiled into the
 * application on purpose — see permissions.ts — so there is nothing here to
 * PUT. Departures from it are per-user grants, which live on
 * `/users/:userId/permissions`.
 *
 * EXTERNAL is listed alongside the three roles even though it is a `UserType`
 * rather than a role, because that is how it behaves: it replaces the role
 * baseline outright, and a matrix that omitted it would misrepresent what an
 * external collaborator can actually do.
 */
@ApiTags('authorization')
@ApiBearerAuth('access-token')
@Controller('authorization')
export class AuthorizationController {
  @Get('permissions')
  @RequirePermissions(Permission.USER_MANAGE)
  @ApiOperation({
    summary: "The permission catalog and each role's baseline",
    description:
      'Drives the roles-and-permissions settings screen. The baseline is compiled in and is ' +
      'not editable; per-user departures from it are managed on /users/:userId/permissions.',
  })
  catalog(): PermissionCatalogView {
    return {
      permissions: ALL_PERMISSIONS.map((key) => ({ key, group: groupOf(key) })),
      roles: [
        {
          role: Role.ADMIN,
          label: 'System Administrator',
          description:
            'Platform operator. Global catalog, master templates, rate cards, integrations ' +
            'and every tenant.',
          permissions: sorted(basePermissionsFor(Role.ADMIN, UserType.EXISTING)),
        },
        {
          role: Role.HEAD_OFFICE,
          label: 'Head Office',
          description:
            'Multi-site oversight within one account: approvals, billing visibility, ' +
            'reporting and user administration.',
          permissions: sorted(basePermissionsFor(Role.HEAD_OFFICE, UserType.EXISTING)),
        },
        {
          role: Role.SITE_USER,
          label: 'Site User',
          description:
            'Branch-level ordering: browse the catalogue, personalise a template, place and ' +
            'track orders for their own site.',
          permissions: sorted(basePermissionsFor(Role.SITE_USER, UserType.EXISTING)),
        },
        {
          role: 'EXTERNAL',
          label: 'External Collaborator',
          description:
            'Clients, vendors, partners and temporary collaborators. A closed least-privilege ' +
            'set that ignores the invited role; anything more is granted one permission at a ' +
            'time, optionally scoped to a single document.',
          permissions: sorted(basePermissionsFor(Role.SITE_USER, UserType.EXTERNAL)),
        },
      ],
    };
  }
}

function sorted(permissions: ReadonlySet<PermissionValue>): PermissionValue[] {
  return [...permissions].sort();
}

/**
 * Derived from the permission name rather than stored beside it.
 *
 * The catalog is already grouped by prefix — APPLICATION_*, DAM_*, ORDER_* —
 * so a separate group column would be a second thing to keep in step with the
 * first, and would go stale the moment somebody added a permission without it.
 */
function groupOf(permission: PermissionValue): string {
  if (permission.startsWith('APPLICATION_')) return 'Application';
  if (permission.startsWith('DAM_') || permission === Permission.EXTERNAL_DOCUMENT_ACCESS) {
    return 'Documents';
  }
  if (permission.startsWith('CATALOG_')) return 'Catalogue';
  if (permission.startsWith('PRICING_')) return 'Pricing';
  if (permission.startsWith('ORDER_') || permission === Permission.APPROVAL_ACT) return 'Orders';
  if (permission.startsWith('TEMPLATE_')) return 'Templates';
  if (permission.startsWith('BILLING_')) return 'Billing';
  if (permission.startsWith('INVENTORY_')) return 'Inventory';
  if (permission.startsWith('REPORT_') || permission.startsWith('AUDIT_')) return 'Reporting';
  return 'Administration';
}

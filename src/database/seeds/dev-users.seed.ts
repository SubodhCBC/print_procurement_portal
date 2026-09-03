import { hash, Algorithm } from '@node-rs/argon2';
import type { PrismaClient } from '@prisma/client';
import { createId } from '@/common';
import { loadConfig } from '@/config';

/**
 * One demo tenant with a user per portal, so the three front-end portals can be
 * exercised end to end without a legacy Ticket-IT credential.
 *
 * Local accounts on purpose: the real login flow reads the legacy database on
 * first login, which is an Azure SQL instance no developer or CI job can be
 * assumed to reach. These users already carry an Argon2 hash, so they take the
 * `loginExistingUser` path — the same code every returning user takes — and the
 * legacy database is never touched.
 *
 * Refuses to run outside development. The passwords below are published in the
 * README; seeding them into a deployed environment would be handing out three
 * working logins.
 */

export const DEV_PASSWORD = 'Password123!';

const ACCOUNT_SLUG = 'apex-healthcare-group';

interface SeededUser {
  readonly login: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly role: 'ADMIN' | 'HEAD_OFFICE' | 'SITE_USER';
  readonly department: string;
  /** Null for ADMIN and account-wide HEAD_OFFICE users, matching the schema. */
  readonly siteCode: string | null;
  readonly isHeadOfficeAdmin: boolean;
}

const USERS: readonly SeededUser[] = [
  {
    login: 'dev.admin',
    email: 'dev.admin@ticket-it.local',
    firstName: 'Sarah',
    lastName: 'Jenkins',
    role: 'ADMIN',
    department: 'Central Fulfilment & DAM Operations',
    siteCode: null,
    isHeadOfficeAdmin: true,
  },
  {
    login: 'dev.headoffice',
    email: 'dev.headoffice@apexhealth.local',
    firstName: 'Elena',
    lastName: 'Rostova',
    role: 'HEAD_OFFICE',
    department: 'Multi-Site Marketing Oversight',
    siteCode: null,
    isHeadOfficeAdmin: true,
  },
  {
    login: 'dev.siteuser',
    email: 'dev.siteuser@apexhealth.local',
    firstName: 'Marcus',
    lastName: 'Vance',
    role: 'SITE_USER',
    department: 'Dispensary Operations',
    siteCode: 'APX-MID-101',
    isHeadOfficeAdmin: false,
  },
];

/**
 * Each branch carries a bill-to and a ship-to address.
 *
 * Not optional decoration: checkout refuses without a delivery address, because
 * an order has to ship somewhere. A branch seeded without one cannot be bought
 * from at all.
 */
const SITES = [
  {
    code: 'APX-MID-101',
    name: 'Apex Midtown Central Pharmacy',
    monthlyBudget: 8500,
    shipTo: {
      label: 'Goods-in, rear entrance',
      line1: '18 Midtown Parade',
      line2: 'Rear service yard',
      city: 'Manchester',
      region: 'Greater Manchester',
      postcode: 'M1 4BT',
    },
    billTo: {
      label: 'Accounts payable',
      line1: '18 Midtown Parade',
      city: 'Manchester',
      region: 'Greater Manchester',
      postcode: 'M1 4BT',
    },
  },
  {
    code: 'APX-NTH-102',
    name: 'Apex Northgate Pharmacy',
    monthlyBudget: 6000,
    shipTo: {
      label: 'Front of house',
      line1: '4 Northgate Retail Park',
      city: 'Leeds',
      region: 'West Yorkshire',
      postcode: 'LS1 7DP',
    },
    billTo: {
      label: 'Accounts payable',
      line1: '4 Northgate Retail Park',
      city: 'Leeds',
      region: 'West Yorkshire',
      postcode: 'LS1 7DP',
    },
  },
] as const;

export async function seedDevUsers(prisma: PrismaClient): Promise<void> {
  const config = loadConfig();
  if (config.app.isProduction) {
    throw new Error('The development seed refuses to run against a production configuration.');
  }

  const passwordHash = await hash(DEV_PASSWORD, {
    algorithm: Algorithm.Argon2id,
    memoryCost: config.auth.passwordHash.memoryCost,
    timeCost: config.auth.passwordHash.timeCost,
    parallelism: 1,
  });

  const account = await prisma.account.upsert({
    where: { slug: ACCOUNT_SLUG },
    update: {},
    create: {
      id: createId('acc'),
      slug: ACCOUNT_SLUG,
      accountCode: 'APEX',
      name: 'Apex Healthcare Group',
      contactEmail: 'accounts@apexhealth.local',
      approvalThreshold: 1000,
      requirePoNumber: true,
      poPrefix: 'PO-APEX',
    },
  });

  const sites = new Map<string, string>();
  for (const site of SITES) {
    const row = await prisma.site.upsert({
      where: { accountId_code: { accountId: account.id, code: site.code } },
      update: {},
      create: {
        id: createId('site'),
        accountId: account.id,
        code: site.code,
        name: site.name,
        monthlyBudget: site.monthlyBudget,
        poRequired: true,
        poPrefix: `PO-${site.code}`,
      },
    });
    sites.set(site.code, row.id);

    // Replaced rather than upserted: an address has no natural key beyond its
    // own id, so matching on one would mean inventing a key the model does not
    // have.
    await prisma.address.deleteMany({ where: { siteId: row.id } });
    await prisma.address.createMany({
      data: [
        {
          id: createId('adr'),
          accountId: account.id,
          siteId: row.id,
          kind: 'SHIPPING',
          isDefault: true,
          country: 'GB',
          ...site.shipTo,
        },
        {
          id: createId('adr'),
          accountId: account.id,
          siteId: row.id,
          kind: 'BILLING',
          isDefault: true,
          country: 'GB',
          ...site.billTo,
        },
      ],
    });
  }

  for (const user of USERS) {
    const siteId = user.siteCode ? (sites.get(user.siteCode) ?? null) : null;

    await prisma.user.upsert({
      where: { login: user.login },
      // The password is reset on every run on purpose: the seed's contract is
      // "these three logins work with this password", and a developer who
      // changed one locally should get it back rather than a puzzle.
      update: { passwordHash, status: 'ACTIVE', role: user.role, siteId, deletedAt: null },
      create: {
        id: createId('usr'),
        accountId: account.id,
        siteId,
        userType: 'NEW',
        login: user.login,
        loginDisplay: user.login,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        passwordHash,
        role: user.role,
        status: 'ACTIVE',
        department: user.department,
        isHeadOfficeAdmin: user.isHeadOfficeAdmin,
        activatedAt: new Date(),
      },
    });
  }

  console.log(
    `[seed] account ${account.accountCode}, ${SITES.length} sites ` +
      `(each with a bill-to and ship-to address), ` +
      `${USERS.length} users (${USERS.map((u) => u.login).join(', ')}) — password "${DEV_PASSWORD}"`,
  );
}

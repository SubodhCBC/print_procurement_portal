-- Sites, role-based access control, and the invitation flow.
--
-- Three things land together because they are one change: the portal stops
-- being a read-only mirror of legacy users and becomes able to model an
-- organisation of its own.
--
--   Sites and addresses  the branch level that orders are placed for and
--                        billed to, sourced from legacy `Outlets` but also
--                        creatable here.
--   RBAC                 per-user departures from the role -> permission map
--                        that lives in code, plus multi-site oversight.
--   Invitations          portal-native and external users, who have no legacy
--                        counterpart. This is why every `legacy*` column on
--                        `users` becomes nullable.
--
-- `users.identityUserId` is the stable cross-system key the architecture
-- document requires. It is added with a database-side default so the existing
-- rows are backfilled in the same statement, and so a row inserted outside
-- Prisma still gets one.
--
-- Row-Level Security for the new tenant-owned tables is the next migration.
--
-- Authored with `prisma migrate diff` so it can be reviewed as SQL. Applied
-- with `npm run db:deploy`.
-- CreateEnum
CREATE TYPE "UserType" AS ENUM ('EXISTING', 'NEW', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "SiteStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "AddressKind" AS ENUM ('BILLING', 'SHIPPING');

-- CreateEnum
CREATE TYPE "GrantEffect" AS ENUM ('ALLOW', 'DENY');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- AlterEnum
ALTER TYPE "UserStatus" ADD VALUE 'PENDING';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "activatedAt" TIMESTAMPTZ(3),
ADD COLUMN     "identityUserId" UUID NOT NULL DEFAULT gen_random_uuid(),
ADD COLUMN     "siteId" TEXT,
ADD COLUMN     "userType" "UserType" NOT NULL DEFAULT 'EXISTING',
ALTER COLUMN "legacyUserId" DROP NOT NULL,
ALTER COLUMN "legacySyncedAt" DROP NOT NULL,
ALTER COLUMN "legacyFingerprint" DROP NOT NULL;

-- CreateTable
CREATE TABLE "sites" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legacyOutletId" INTEGER,
    "status" "SiteStatus" NOT NULL DEFAULT 'ACTIVE',
    "monthlyBudget" DECIMAL(12,2),
    "poRequired" BOOLEAN NOT NULL DEFAULT false,
    "poPrefix" TEXT,
    "costCentre" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addresses" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT,
    "kind" "AddressKind" NOT NULL,
    "label" TEXT,
    "recipientName" TEXT,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "region" TEXT,
    "postcode" TEXT NOT NULL,
    "country" CHAR(2) NOT NULL,
    "phone" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_site_access" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_site_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_permission_grants" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "effect" "GrantEffect" NOT NULL DEFAULT 'ALLOW',
    "resourceId" TEXT,
    "grantedById" TEXT,
    "reason" TEXT,
    "expiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_permission_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT,
    "email" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "role" "PortalRole" NOT NULL,
    "userType" "UserType" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3),
    "acceptedUserId" TEXT,
    "revokedAt" TIMESTAMPTZ(3),
    "invitedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sites_legacyOutletId_key" ON "sites"("legacyOutletId");

-- CreateIndex
CREATE INDEX "sites_accountId_status_idx" ON "sites"("accountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sites_accountId_code_key" ON "sites"("accountId", "code");

-- CreateIndex
CREATE INDEX "addresses_accountId_idx" ON "addresses"("accountId");

-- CreateIndex
CREATE INDEX "addresses_siteId_kind_idx" ON "addresses"("siteId", "kind");

-- CreateIndex
CREATE INDEX "user_site_access_accountId_idx" ON "user_site_access"("accountId");

-- CreateIndex
CREATE INDEX "user_site_access_siteId_idx" ON "user_site_access"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "user_site_access_userId_siteId_key" ON "user_site_access"("userId", "siteId");

-- CreateIndex
CREATE INDEX "user_permission_grants_accountId_idx" ON "user_permission_grants"("accountId");

-- CreateIndex
CREATE INDEX "user_permission_grants_userId_expiresAt_idx" ON "user_permission_grants"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_permission_grants_userId_permission_resourceId_key" ON "user_permission_grants"("userId", "permission", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_tokenHash_key" ON "invitations"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_acceptedUserId_key" ON "invitations"("acceptedUserId");

-- CreateIndex
CREATE INDEX "invitations_accountId_status_idx" ON "invitations"("accountId", "status");

-- CreateIndex
CREATE INDEX "invitations_email_idx" ON "invitations"("email");

-- CreateIndex
CREATE INDEX "invitations_expiresAt_idx" ON "invitations"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_tokenHash_key" ON "password_reset_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_userId_usedAt_idx" ON "password_reset_tokens"("userId", "usedAt");

-- CreateIndex
CREATE INDEX "password_reset_tokens_expiresAt_idx" ON "password_reset_tokens"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "users_identityUserId_key" ON "users"("identityUserId");

-- CreateIndex
CREATE INDEX "users_siteId_idx" ON "users"("siteId");

-- AddForeignKey
ALTER TABLE "sites" ADD CONSTRAINT "sites_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_site_access" ADD CONSTRAINT "user_site_access_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_site_access" ADD CONSTRAINT "user_site_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_site_access" ADD CONSTRAINT "user_site_access_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permission_grants" ADD CONSTRAINT "user_permission_grants_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permission_grants" ADD CONSTRAINT "user_permission_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permission_grants" ADD CONSTRAINT "user_permission_grants_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_acceptedUserId_fkey" FOREIGN KEY ("acceptedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;



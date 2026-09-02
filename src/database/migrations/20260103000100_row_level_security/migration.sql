-- Row-Level Security: the database-level half of tenant isolation.
--
-- src/database/tenant-scope.ts has always set `app.current_account_id` on the
-- transaction's connection. Until this migration nothing read it, so
-- withTenantScope() enforced nothing. This adds the policies that make it real.
--
-- ---------------------------------------------------------------------------
-- Why a separate role rather than FORCE ROW LEVEL SECURITY
-- ---------------------------------------------------------------------------
-- PostgreSQL exempts two kinds of connection from RLS: superusers (always), and
-- the table owner (unless the table is FORCEd). The portal connects as the role
-- that owns these tables, because it also runs migrations — so policies alone
-- would never apply.
--
-- FORCE is not the answer either. Authentication has to look a user up *before*
-- it knows which account they belong to: `SELECT … FROM users WHERE login = $1`
-- runs with no tenant in scope, and under FORCE it would return zero rows and
-- every login would fail.
--
-- So: policies are attached to a dedicated, unprivileged role, and
-- withTenantScope() does `SET LOCAL ROLE ticketit_app` for the duration of the
-- transaction. Inside a tenant scope the connection is subject to RLS; outside
-- one — login, provisioning, migrations, seeds — it is the owner and is not.
-- The scope boundary is therefore explicit and greppable rather than implicit
-- in which credentials a deployment happens to use.
--
-- `SET LOCAL` is reverted when the transaction ends, so a pooled connection can
-- never leak the role (or the tenant id) into the next request.

-- ---------------------------------------------------------------------------
-- 1. The application role
-- ---------------------------------------------------------------------------

-- NOLOGIN: nothing connects as this role, it is only ever assumed with SET
-- ROLE. No BYPASSRLS, no superuser — that is the entire point of it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ticketit_app') THEN
    CREATE ROLE ticketit_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO ticketit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ticketit_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ticketit_app;

-- Tables created by later migrations must be reachable too, or the first query
-- inside a tenant scope after a deploy fails with "permission denied".
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ticketit_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ticketit_app;

-- The connecting role must be a member of ticketit_app for SET ROLE to be
-- allowed. PostgreSQL 16 gives the creator ADMIN OPTION automatically, so this
-- normally succeeds; it is guarded because a role pre-created by a DBA may be
-- owned by someone else, in which case the grant is their job and this
-- migration should not fail the deploy.
DO $$
BEGIN
  EXECUTE format('GRANT ticketit_app TO %I', current_user);
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE WARNING
      'Could not grant ticketit_app to %. Run "GRANT ticketit_app TO %" as a superuser, '
      'or withTenantScope() will fail at runtime.', current_user, current_user;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. The tenant accessor
-- ---------------------------------------------------------------------------

-- `true` as the second argument makes current_setting() return NULL instead of
-- raising when the variable was never set. NULLIF then maps the empty-string
-- default (see docker/postgres/init) onto NULL as well, so "no tenant in scope"
-- is a single value.
--
-- Every policy compares a column to this. A NULL comparison is NULL, which is
-- not true, so an unset tenant matches no rows — the failure mode is an empty
-- result, never someone else's data.
CREATE OR REPLACE FUNCTION app_current_account_id()
  RETURNS text
  LANGUAGE sql
  STABLE
  -- Empty search_path: the body must not be resolvable through a caller-set
  -- search_path, which is how a SECURITY DEFINER-adjacent function gets
  -- hijacked. Nothing here needs schema qualification.
  SET search_path = ''
AS $$
  SELECT NULLIF(current_setting('app.current_account_id', true), '')
$$;

COMMENT ON FUNCTION app_current_account_id() IS
  'The account id set by withTenantScope(); NULL outside a tenant scope.';

GRANT EXECUTE ON FUNCTION app_current_account_id() TO ticketit_app;

-- ---------------------------------------------------------------------------
-- 3. Policies
-- ---------------------------------------------------------------------------
--
-- One permissive policy per table, covering ALL commands. WITH CHECK is stated
-- as well as USING so that an INSERT or UPDATE cannot *write* a row into
-- another account — a read-only policy would leave the more damaging direction
-- open.
--
-- refresh_tokens and password_reset_tokens are deliberately absent: both are
-- reached only by the unauthenticated auth flow, which has no tenant in scope,
-- and neither carries an accountId to filter on. They are keyed by an
-- unguessable token digest.

-- accounts: the tenant row itself, matched on its own primary key.
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "accounts_tenant_isolation" ON "accounts"
  FOR ALL
  USING ("id" = app_current_account_id())
  WITH CHECK ("id" = app_current_account_id());

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_tenant_isolation" ON "users"
  FOR ALL
  USING ("accountId" = app_current_account_id())
  WITH CHECK ("accountId" = app_current_account_id());

ALTER TABLE "sites" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sites_tenant_isolation" ON "sites"
  FOR ALL
  USING ("accountId" = app_current_account_id())
  WITH CHECK ("accountId" = app_current_account_id());

ALTER TABLE "addresses" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "addresses_tenant_isolation" ON "addresses"
  FOR ALL
  USING ("accountId" = app_current_account_id())
  WITH CHECK ("accountId" = app_current_account_id());

ALTER TABLE "user_site_access" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_site_access_tenant_isolation" ON "user_site_access"
  FOR ALL
  USING ("accountId" = app_current_account_id())
  WITH CHECK ("accountId" = app_current_account_id());

ALTER TABLE "user_permission_grants" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_permission_grants_tenant_isolation" ON "user_permission_grants"
  FOR ALL
  USING ("accountId" = app_current_account_id())
  WITH CHECK ("accountId" = app_current_account_id());

ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "invitations_tenant_isolation" ON "invitations"
  FOR ALL
  USING ("accountId" = app_current_account_id())
  WITH CHECK ("accountId" = app_current_account_id());

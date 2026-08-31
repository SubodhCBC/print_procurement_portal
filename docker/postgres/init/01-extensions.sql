-- Local convenience only: runs once, at first container start, so a fresh
-- clone has a usable database before any migration is applied. The
-- authoritative definition lives in packages/db/prisma/migrations —
-- managed PostgreSQL has no init hook.
--
-- citext      : case-insensitive email/SKU uniqueness without LOWER() indexes
-- pg_trgm     : trigram indexes for catalog search (ILIKE '%term%')
-- pgcrypto    : gen_random_uuid() and digest() for checksums
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Row-Level Security reads the tenant from this session variable. Declaring a
-- default here means a connection that forgets to set it sees nothing, rather
-- than erroring out and revealing that the policy exists.
ALTER DATABASE ticketit SET "app.current_account_id" TO '';

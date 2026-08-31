-- Baseline migration: database capabilities every environment needs.
--
-- The local Docker image also creates these from an init script, but that only
-- runs for a brand-new container. Managed PostgreSQL (RDS / Neon / Supabase)
-- has no such hook, so the extensions must be owned by a migration or the
-- first deploy to a fresh production database fails.

-- Case-insensitive text: email and SKU uniqueness without LOWER() indexes.
CREATE EXTENSION IF NOT EXISTS citext;

-- Trigram indexes for catalog search (ILIKE '%term%' stays index-backed).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- gen_random_uuid() and digest() for artwork/render checksums.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

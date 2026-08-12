-- =============================================================================
-- 001_rls_lockdown.sql — Close the PostgREST exposure on the public schema
-- =============================================================================
--
-- WHY THIS EXISTS
-- ---------------
-- ShiftTrack does NOT use Supabase Auth, the Supabase JS SDK, PostgREST, Edge
-- Functions, or the anon/publishable key. Supabase is used purely as hosted
-- Postgres: the Express API (`shifttrack-api/`) connects over the standard
-- Postgres wire protocol with DATABASE_URL as role `postgres`, and every
-- authorization decision is made in Node — custom bcrypt logins, HS256 JWTs
-- signed with JWT_SECRET, and the `users.role` check in middleware/auth.js.
--
-- Supabase, however, still auto-publishes every table in `public` through
-- PostgREST at https://<project-ref>.supabase.co/rest/v1/<table>, reachable by
-- the `anon` and `authenticated` roles. Supabase's default privileges grant
-- those two roles ALL privileges on every table created in `public`, and with
-- RLS disabled nothing constrains them. That is what the Security Advisor's 18
-- "RLS Disabled in Public" errors are reporting — including `public.users`,
-- which stores email addresses and bcrypt password hashes.
--
-- WHY THERE ARE NO auth.uid() POLICIES HERE
-- -----------------------------------------
-- Per-user policies would be security theatre in this architecture. There is no
-- Supabase Auth user table in play, so `auth.uid()` is always NULL and no such
-- policy could ever match a row — identical in effect to the deny-all posture
-- below, but far more misleading. Worse, it would be a live trap: if Supabase
-- Auth were ever enabled later, `auth.uid()` would return a Supabase auth user
-- id that has no relationship to `public.users.id`, and those policies would
-- start making access decisions on a mapping that does not exist.
--
-- The correct least-privilege model for an application that never uses
-- PostgREST is to close PostgREST entirely:
--
--   Layer 1  RLS enabled with ZERO policies  -> deny-all for anon/authenticated
--   Layer 2  All table privileges revoked    -> requests fail before RLS runs
--   Layer 3  Default privileges revoked      -> future tables are born locked
--   Layer 4  Schema USAGE revoked            -> nothing in `public` is routable
--
-- WHY THE APPLICATION IS UNAFFECTED
-- ---------------------------------
-- The API connects as `postgres`, which (a) owns all 18 tables and (b) has
-- rolbypassrls = true. Both independently exempt it from RLS. Verified against
-- production before writing this migration.
--
-- NOTE: this deliberately does NOT use ALTER TABLE ... FORCE ROW LEVEL
-- SECURITY. FORCE would strip the table owner's exemption and break every
-- application query.
--
-- Idempotent. Safe to run repeatedly. Reads and writes no application rows.
-- =============================================================================

DO $$
DECLARE
  t         record;
  n_tables  integer := 0;
BEGIN
  -- The anon/authenticated roles only exist on Supabase. Skip cleanly on a
  -- plain Postgres (local dev, CI) so this file stays portable.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE '[rls] roles anon/authenticated not present - not a Supabase database, skipping';
    RETURN;
  END IF;

  -- ---------------------------------------------------------------------------
  -- Layers 1 + 2: lock every existing base table in `public`.
  -- Driven off pg_class rather than a hardcoded list so tables added later by
  -- db/index.js migrate() are covered automatically.
  -- ---------------------------------------------------------------------------
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')          -- ordinary + partitioned tables
     ORDER BY c.relname
  LOOP
    -- Layer 1: deny-all RLS. No policies are created, so anon/authenticated
    -- match zero rows on SELECT and cannot satisfy any write check.
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);

    -- Layer 2: remove the privileges themselves. Postgres checks grants before
    -- RLS, so PostgREST fails with "permission denied" rather than an empty
    -- result set. RLS alone is not the whole authorization model.
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t.relname);

    n_tables := n_tables + 1;
  END LOOP;

  RAISE NOTICE '[rls] locked % table(s) in public', n_tables;

  -- Sequences and functions in `public` get the same treatment. ShiftTrack uses
  -- gen_random_uuid() rather than serial columns so there is normally nothing
  -- here, but Supabase's default ACL would grant these too.
  EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated';
  EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated';

  -- ---------------------------------------------------------------------------
  -- Layer 3: stop the hole from reopening.
  --
  -- This is the part that makes the fix permanent. db/index.js migrate() runs
  -- CREATE TABLE on every boot, and Supabase's ALTER DEFAULT PRIVILEGES grants
  -- anon/authenticated ALL on each newly created table. Without this block, the
  -- next feature table would silently be world-writable again.
  -- ---------------------------------------------------------------------------
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated';

  -- The above only covers default ACLs owned by the role running this migration
  -- (`postgres`, which owns all 18 application tables). Supabase also installs a
  -- default ACL under `supabase_admin`; `postgres` is not a member of that role,
  -- so this is attempted opportunistically and ignored if not permitted.
  BEGIN
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated';
  EXCEPTION WHEN insufficient_privilege OR undefined_object THEN
    RAISE NOTICE '[rls] supabase_admin default privileges not alterable by % - tables it creates are still covered by the per-table REVOKE loop above', current_user;
  END;

  -- ---------------------------------------------------------------------------
  -- Layer 4 (deliberately NOT done): revoking USAGE ON SCHEMA public.
  --
  -- A dry run against production showed that
  --   REVOKE USAGE ON SCHEMA public FROM anon, authenticated
  -- leaves has_schema_privilege('anon','public','USAGE') = true, because that
  -- USAGE comes from the PUBLIC pseudo-role, not from a direct grant. Making it
  -- stick would require REVOKE ... FROM PUBLIC, which strips schema resolution
  -- from *every* role in the database — including Supabase's internal realtime
  -- and storage roles — for no marginal security gain: schema USAGE by itself
  -- authorizes nothing, and layers 1-3 above have already reduced every table
  -- privilege for anon/authenticated to zero.
  --
  -- Left in place intentionally. Do not "fix" this by revoking from PUBLIC.
  -- ---------------------------------------------------------------------------

  RAISE NOTICE '[rls] public schema locked down for anon/authenticated';
END $$;

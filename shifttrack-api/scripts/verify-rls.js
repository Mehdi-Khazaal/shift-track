// =============================================================================
// verify-rls.js — proves the public schema is closed to Supabase's PostgREST API
// =============================================================================
//
// ShiftTrack does all authorization in Node (bcrypt + JWT + users.role). The
// database-side risk is not "can employee A read employee B's shifts through the
// app" — it is "can anyone reach these tables through Supabase's auto-generated
// REST API, bypassing the app entirely". These tests answer that question.
//
// Run:  npm run verify:rls
//
// READ-ONLY. Every probe runs inside a transaction that is always rolled back,
// and the write probes are no-ops (WHERE false / non-existent id) so they are
// rejected at the privilege check without ever matching a row.
//
// Exits non-zero on the first failing assertion so it can gate a deploy.
// =============================================================================

const { Pool } = require('pg');
require('dotenv').config();

const EXPOSED_ROLES = ['anon', 'authenticated'];
const WRITE_PRIVS   = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
  } else {
    failures.push(detail ? `${name}\n      ${detail}` : name);
  }
}

async function main() {
  const { rows: [who] } = await pool.query('SELECT current_user');
  console.log(`\nConnected as: ${who.current_user}\n`);

  const { rows: roleCheck } = await pool.query(
    `SELECT rolname FROM pg_roles WHERE rolname = ANY($1)`, [EXPOSED_ROLES]
  );
  if (roleCheck.length === 0) {
    console.log('anon/authenticated roles absent — not a Supabase database. Nothing to verify.');
    await pool.end();
    return;
  }

  const { rows: tables } = await pool.query(`
    SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
           pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
     ORDER BY c.relname
  `);

  check('at least one public table found', tables.length > 0);
  console.log(`Auditing ${tables.length} tables in public.\n`);

  // -- 1. RLS enabled everywhere -------------------------------------------
  // This is the exact condition Supabase Security Advisor reports on.
  for (const t of tables) {
    check(`[RLS enabled]        public.${t.name}`, t.rls === true,
      'ALTER TABLE public.' + t.name + ' ENABLE ROW LEVEL SECURITY;');
  }

  // -- 2. RLS must NOT be forced -------------------------------------------
  // FORCE would strip the owner exemption and break every application query.
  for (const t of tables) {
    check(`[RLS not forced]     public.${t.name}`, t.forced === false,
      'FORCE ROW LEVEL SECURITY breaks the API, which connects as the table owner.');
  }

  // -- 3. No policy may re-open access to the exposed roles -----------------
  const { rows: policies } = await pool.query(`
    SELECT tablename, policyname, roles::text[] AS roles, cmd, qual, with_check
      FROM pg_policies WHERE schemaname = 'public'
  `);
  for (const p of policies) {
    const reaches = p.roles.some(r => EXPOSED_ROLES.includes(r) || r === 'public');
    check(`[no anon policy]     ${p.tablename}.${p.policyname}`, !reaches,
      `Policy targets ${p.roles.join(',')} — ShiftTrack has no Supabase Auth identity, so no policy should grant these roles anything.`);
  }
  if (policies.length === 0) console.log('No policies defined (expected: deny-all posture).\n');

  // -- 4. Table privileges revoked -----------------------------------------
  // Postgres checks grants BEFORE RLS, so this is the outer of the two layers.
  for (const t of tables) {
    for (const role of EXPOSED_ROLES) {
      const { rows: [g] } = await pool.query(
        `SELECT bool_or(has_table_privilege($1, $2, p)) AS any_priv
           FROM unnest($3::text[]) AS p`,
        [role, `public.${t.name}`, WRITE_PRIVS]
      );
      check(`[no grants: ${role}] public.${t.name}`, g.any_priv === false,
        `REVOKE ALL ON public.${t.name} FROM ${role};`);
    }
  }

  // -- 5. Schema USAGE — informational only ---------------------------------
  // Not asserted. anon/authenticated inherit USAGE on `public` from the PUBLIC
  // pseudo-role, and revoking it would require REVOKE ... FROM PUBLIC, which
  // affects every role in the database. USAGE alone authorizes nothing once the
  // table privileges checked above are gone. See 001_rls_lockdown.sql, Layer 4.
  for (const role of EXPOSED_ROLES) {
    const { rows: [s] } = await pool.query(
      `SELECT has_schema_privilege($1, 'public', 'USAGE') AS usage`, [role]
    );
    console.log(`  info: ${role} schema USAGE = ${s.usage} (expected true; harmless without table grants)`);
  }

  // -- 6. Default privileges revoked (future tables born locked) -----------
  const { rows: defacl } = await pool.query(`
    SELECT pg_get_userbyid(d.defaclrole) AS grantor, d.defaclacl::text AS acl
      FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
     WHERE n.nspname = 'public' AND d.defaclobjtype = 'r'
  `);
  for (const d of defacl) {
    for (const role of EXPOSED_ROLES) {
      // Only assert on ACLs we can actually alter; supabase_admin's is out of reach.
      if (d.grantor !== who.current_user) continue;
      check(`[no default privs]   ${d.grantor} -> ${role}`, !d.acl.includes(`${role}=`),
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${role};`);
    }
  }

  // -- 7. LIVE ENFORCEMENT: impersonate the exposed roles -------------------
  // The assertions above read catalog state; this one proves behaviour.

  // One updatable (non-generated, non-identity) column per table, for the write
  // probe below. Quoted to survive any unusual identifier.
  const { rows: cols } = await pool.query(`
    SELECT DISTINCT ON (table_name) table_name, quote_ident(column_name) AS col
      FROM information_schema.columns
     WHERE table_schema = 'public' AND is_generated = 'NEVER'
     ORDER BY table_name, ordinal_position
  `);
  const columnOf = Object.fromEntries(cols.map(c => [c.table_name, c.col]));

  for (const role of EXPOSED_ROLES) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');            // everything below is rolled back
      await client.query(`SET LOCAL ROLE ${role}`);

      // Each probe runs inside its own SAVEPOINT. A denied probe raises 42501,
      // which puts the whole transaction into the aborted state — every later
      // statement would then fail with 25P02 ("transaction is aborted") and be
      // misread as "not denied". Rolling back to the savepoint after each probe
      // keeps the failures independent.
      const probe = async (sql) => {
        await client.query('SAVEPOINT probe');
        try {
          await client.query(sql);
          await client.query('RELEASE SAVEPOINT probe');
          return null;                       // statement succeeded — not denied
        } catch (e) {
          await client.query('ROLLBACK TO SAVEPOINT probe');
          return e.code;
        }
      };
      const isDenied = code => code === '42501' || code === '3F000';

      for (const t of tables) {
        // Read probe.
        const readCode = await probe(`SELECT * FROM public.${t.name} LIMIT 1`);
        check(`[${role} cannot read]  public.${t.name}`, isDenied(readCode),
          readCode === null
            ? `Role ${role} can SELECT from public.${t.name} via PostgREST.`
            : `Unexpected error code ${readCode} — expected 42501 (permission denied).`);

        // Write probe — self-assignment guarded by WHERE false, so even a
        // permitted statement changes nothing; Postgres still enforces the
        // UPDATE privilege at plan time. Rolled back regardless.
        const col = columnOf[t.name];
        if (col) {
          const writeCode = await probe(`UPDATE public.${t.name} SET ${col} = ${col} WHERE false`);
          check(`[${role} cannot write] public.${t.name}`, isDenied(writeCode),
            writeCode === null
              ? `Role ${role} can UPDATE public.${t.name} via PostgREST.`
              : `Unexpected error code ${writeCode} — expected 42501 (permission denied).`);
        }
      }
    } finally {
      await client.query('ROLLBACK');
      await client.query('RESET ROLE');
      client.release();
    }
  }

  // -- 8. REGRESSION: the application role still has full access ------------
  // Guards against a future FORCE ROW LEVEL SECURITY or an over-broad revoke
  // silently breaking the API.
  for (const t of tables) {
    let ok = false;
    try {
      await pool.query(`SELECT 1 FROM public.${t.name} LIMIT 1`);
      ok = true;
    } catch (e) {
      ok = false;
    }
    check(`[app role can read]  public.${t.name}`, ok,
      `The API role ${who.current_user} lost access to public.${t.name} — this WOULD break production.`);
  }

  // -- Report ---------------------------------------------------------------
  console.log('='.repeat(70));
  if (failures.length === 0) {
    console.log(`PASS  ${passed} security assertions passed across ${tables.length} tables.`);
    console.log('      public schema is closed to anon/authenticated;');
    console.log('      application role retains full access.');
    console.log('='.repeat(70) + '\n');
    await pool.end();
    return;
  }

  console.log(`FAIL  ${failures.length} of ${passed + failures.length} assertions failed:\n`);
  for (const f of failures) console.log(`  x   ${f}`);
  console.log('\n      Fix: psql "$DATABASE_URL" -f db/migrations/001_rls_lockdown.sql');
  console.log('='.repeat(70) + '\n');
  await pool.end();
  process.exitCode = 1;
}

main().catch(err => {
  console.error('\nverify-rls failed to run:', err.message, '\n');
  pool.end();
  process.exitCode = 1;
});

// Dry-run: applies the RLS lockdown inside a transaction, verifies the outcome,
// then ROLLS BACK so nothing persists. Proves the SQL is valid and that the
// application role keeps full access, without changing production.
//
// Run:  node scripts/dryrun-rls.js

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '001_rls_lockdown.sql'), 'utf8');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const c = await pool.connect();
  c.on('notice', n => console.log(`  notice: ${n.message}`));
  try {
    await c.query('BEGIN');
    console.log('\n--- applying migration inside transaction ---');
    await c.query(sql);

    console.log('\n--- state INSIDE transaction ---');
    const { rows: [r] } = await c.query(`
      SELECT count(*) FILTER (WHERE c.relrowsecurity)      AS rls_on,
             count(*) FILTER (WHERE c.relforcerowsecurity) AS forced,
             count(*)                                      AS total
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p')`);
    console.log(`  RLS enabled: ${r.rls_on}/${r.total}   forced: ${r.forced} (must be 0)`);

    const { rows: [g] } = await c.query(`
      SELECT count(*) AS remaining FROM information_schema.role_table_grants
       WHERE table_schema='public' AND grantee IN ('anon','authenticated')`);
    console.log(`  anon/authenticated grants remaining: ${g.remaining} (must be 0)`);

    const { rows: [u] } = await c.query(`
      SELECT has_schema_privilege('anon','public','USAGE') AS a,
             has_schema_privilege('authenticated','public','USAGE') AS b`);
    // Informational: USAGE is inherited from the PUBLIC pseudo-role and is
    // expected to stay true. It authorizes nothing without table grants.
    console.log(`  schema USAGE  anon=${u.a} authenticated=${u.b} (expected true; see Layer 4 note)`);

    // The critical regression check: can the API role still query everything?
    const { rows: tables } = await c.query(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY 1`);
    let ok = 0;
    for (const t of tables) {
      await c.query(`SELECT 1 FROM public.${t.relname} LIMIT 1`);
      ok++;
    }
    console.log(`  app role (${(await c.query('SELECT current_user')).rows[0].current_user}) can still read: ${ok}/${tables.length} tables`);

    // Representative real application queries from the route layer.
    console.log('\n--- sample production queries ---');
    const probes = [
      ['auth middleware',  'SELECT is_active, role FROM users LIMIT 1'],
      ['bootstrap shifts', 'SELECT s.*, l.name FROM shifts s JOIN locations l ON l.id=s.location_id LIMIT 1'],
      ['leave balances',   'SELECT lb.*, lt.name FROM leave_balances lb JOIN leave_types lt ON lt.id=lb.leave_type_id LIMIT 1'],
      ['open shifts',      'SELECT * FROM open_shifts WHERE status=$1 LIMIT 1'],
      ['user settings',    'SELECT * FROM user_settings LIMIT 1'],
      ['shift swaps',      'SELECT * FROM shift_swaps WHERE status=$1 LIMIT 1'],
      ['shift pulls',      'SELECT * FROM shift_pulls LIMIT 1'],
      ['notification log', 'SELECT * FROM notification_log LIMIT 1'],
      ['push subs',        'SELECT * FROM push_subscriptions LIMIT 1'],
      ['unavailability',   'SELECT * FROM user_unavailability LIMIT 1'],
      ['base schedule',    'SELECT * FROM base_schedule LIMIT 1'],
      ['sick payouts',     'SELECT * FROM sick_time_payouts LIMIT 1'],
    ];
    for (const [name, q] of probes) {
      const params = q.includes('$1') ? ['pending'] : [];
      try {
        const res = await c.query(q.replace('$1', "'x'").includes('$1') ? q : q, params.length && q.includes('$1') ? params : undefined);
        console.log(`  ok   ${name} (${res.rowCount} row(s))`);
      } catch (e) {
        console.log(`  FAIL ${name}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error('\nDRY RUN ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await c.query('ROLLBACK');
    console.log('\n--- ROLLED BACK: production unchanged ---');
    const { rows: [after] } = await c.query(`
      SELECT count(*) FILTER (WHERE c.relrowsecurity) AS rls_on, count(*) AS total
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p')`);
    console.log(`  post-rollback RLS enabled: ${after.rls_on}/${after.total} (back to original)\n`);
    c.release();
    await pool.end();
  }
})();

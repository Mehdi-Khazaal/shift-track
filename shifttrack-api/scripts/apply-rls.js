// Applies db/migrations/001_rls_lockdown.sql against DATABASE_URL.
//
// The API also runs this automatically on boot (db/index.js migrate()), so this
// script only exists to apply the lockdown immediately without a deploy.
//
// Changes privileges and RLS flags only — it never reads, writes, or deletes
// application rows. Idempotent.
//
// Run:  npm run migrate:rls

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const file = path.join(__dirname, '..', 'db', 'migrations', '001_rls_lockdown.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  const client = await pool.connect();
  client.on('notice', n => console.log(`  ${n.message}`));
  try {
    const { rows: [who] } = await client.query('SELECT current_user, current_database()');
    console.log(`\nApplying RLS lockdown as ${who.current_user} on ${who.current_database}...\n`);

    await client.query(fs.readFileSync(file, 'utf8'));

    console.log('\nOK  RLS lockdown applied. Verify with: npm run verify:rls\n');
  } catch (err) {
    console.error('\nFAILED:', err.message, '\n');
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();

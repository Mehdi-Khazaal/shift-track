// Drops the schema, lets migrate() rebuild it, then reseeds.
//
// Use this when a migration changed shape, or when you have poked the sandbox
// into a state you no longer trust. Safe to run as often as you like — it can
// only ever address a local database (see assert-local-db).
'use strict';

require('./assert-local-db'); // MUST be first: refuses non-local databases

const { Pool } = require('pg');

async function dropSchema() {
  // A dedicated pool: requiring db/index.js immediately starts migrate(),
  // and we need the schema gone BEFORE that runs.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.end();
  console.log('  Dropped and recreated schema "public"');
}

async function main() {
  await dropSchema();

  // Requiring this triggers migrate(), which rebuilds all 18 tables.
  // The Supabase RLS lockdown step will log a warning here — expected and
  // harmless on plain Postgres, where the anon/authenticated roles do not exist.
  const { seed } = require('./seed');
  await seed();
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('\n  Reset failed:', err.message, '\n'); process.exit(1); });

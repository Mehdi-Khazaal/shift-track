// Refuses to let destructive tooling touch anything but a local database.
//
// Every script in here that drops, wipes, or seeds MUST require this file
// FIRST, before it opens a pool or issues a single statement:
//
//     require('./assert-local-db');
//
// The whole point of the sandbox is that "wipe the database" is a safe
// command to type. Without this guard, one shell with a stale DATABASE_URL
// pointed at production Supabase would drop the real tables.
'use strict';

const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'db',        // the docker-compose service name
  'postgres',
]);

function fail(reason, detail) {
  console.error('\n  REFUSED: ' + reason);
  if (detail) console.error('  ' + detail);
  console.error('\n  This command only runs against a local database.');
  console.error('  Start one with:  npm run db:up');
  console.error('  and point .env.local / .env.test at localhost:5433.\n');
  process.exit(1);
}

const raw = process.env.DATABASE_URL;

if (!raw) {
  fail(
    'DATABASE_URL is not set.',
    'Did you forget --env-file=.env.local ? (npm run db:reset sets it for you)'
  );
}

let host;
try {
  host = new URL(raw).hostname;
} catch {
  fail('DATABASE_URL is not a parseable connection string.');
}

// URL() keeps IPv6 hosts in brackets: [::1] -> strip them for comparison.
const bare = host.replace(/^\[|\]$/g, '');

if (!LOCAL_HOSTS.has(bare)) {
  fail(
    `DATABASE_URL points at a non-local host: ${bare}`,
    'That looks like production. Nothing was executed.'
  );
}

module.exports = { host: bare };

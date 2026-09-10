// Test harness: boots the REAL server as a child process and talks to it over
// HTTP. Black-box on purpose — this way the boot path (including migrate()) is
// covered too, and there is no risk of a test accidentally sharing module state
// with the app.
//
// Everything here runs against .env.test (shifttrack_test), never the dev
// database and certainly never production.
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const assert = require('node:assert');

const API_ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(API_ROOT, '.env.test');
const BASE = 'http://127.0.0.1:3101';

let child = null;

async function waitForHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'no response';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/health');
      const body = await res.json();
      if (body.ok && body.db_migrated) return body;
      lastErr = JSON.stringify(body);
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`API never became healthy on ${BASE} — last: ${lastErr}`);
}

async function startServer() {
  if (child) return;
  child = spawn(
    process.execPath,
    ['--env-file=' + ENV_FILE, path.join(API_ROOT, 'server.js')],
    { cwd: API_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  // Keep server output out of the test report unless something goes wrong.
  const log = [];
  child.stdout.on('data', d => log.push(d.toString()));
  child.stderr.on('data', d => log.push(d.toString()));
  child.on('exit', code => {
    if (code !== 0 && code !== null) console.error('[server exited ' + code + ']\n' + log.join(''));
  });

  try {
    await waitForHealth();
  } catch (e) {
    console.error('[server output]\n' + log.join(''));
    throw e;
  }
}

async function stopServer() {
  if (!child) return;
  child.kill();
  child = null;
}

// Wipe the test schema, rebuild it, and load the fixture — then boot the API.
//
// Order matters: seed.js requires db/index.js, which runs migrate() and
// recreates all 18 tables. So dropping the schema and then seeding leaves a
// clean, fully-migrated, fully-populated database before the server starts.
async function resetAndSeed() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.end();

  const origLog = console.log;
  console.log = () => {}; // keep seed chatter out of the test report
  try {
    const { seed } = require('../scripts/seed');
    await seed();
  } finally {
    console.log = origLog;
  }
}

// One-time setup shared by every suite.
async function setup() {
  await resetAndSeed();
  await startServer();
}

// Minimal request helper. Returns { status, body } rather than throwing, so
// tests can assert on failure codes as easily as success ones.
async function api(method, pathname, { token, body } = {}) {
  // fetch throws outright if a GET/HEAD carries a body, so drop it — callers
  // sweeping many endpoints shouldn't have to special-case the verb.
  const sendBody = body !== undefined && method !== 'GET' && method !== 'HEAD';
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: sendBody ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: parsed };
}

async function login(email, password = 'localdev123') {
  const res = await api('POST', '/api/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, `login failed for ${email}: ${JSON.stringify(res.body)}`);
  return { token: res.body.token, user: res.body.user };
}

module.exports = { setup, startServer, stopServer, resetAndSeed, api, login, BASE };

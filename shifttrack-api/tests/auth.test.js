'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { setup, stopServer, api, login } = require('./helpers');

describe('auth and authorization', () => {
  before(setup);
  after(stopServer);

  test('valid credentials return a token', async () => {
    const res = await api('POST', '/api/auth/login', {
      body: { email: 'admin@local.test', password: 'localdev123' },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.token, 'expected a JWT');
    assert.equal(res.body.user.role, 'admin');
  });

  test('wrong password is rejected', async () => {
    const res = await api('POST', '/api/auth/login', {
      body: { email: 'admin@local.test', password: 'wrong-password' },
    });
    assert.equal(res.status, 401);
  });

  test('unknown email is rejected', async () => {
    const res = await api('POST', '/api/auth/login', {
      body: { email: 'nobody@local.test', password: 'localdev123' },
    });
    assert.equal(res.status, 401);
  });

  test('protected route refuses a missing token', async () => {
    const res = await api('GET', '/api/shifts');
    assert.equal(res.status, 401);
  });

  test('protected route refuses a garbage token', async () => {
    const res = await api('GET', '/api/shifts', { token: 'not-a-real-jwt' });
    assert.equal(res.status, 401);
  });

  // The guarantee that matters most: a normal employee must not reach the
  // admin surface, including the shift endpoints added for managers.
  test('adminOnly blocks a non-admin employee', async () => {
    const { token } = await login('ayman@local.test');
    for (const [method, path] of [
      ['GET',    '/api/admin/users'],
      ['POST',   '/api/admin/shifts'],
      ['DELETE', '/api/admin/shifts/00000000-0000-0000-0000-000000000000'],
      ['POST',   '/api/admin/suppress-date'],
    ]) {
      const res = await api(method, path, { token, body: {} });
      assert.equal(res.status, 403, `${method} ${path} should be admin-only`);
    }
  });

  test('an admin does reach the admin surface', async () => {
    const { token } = await login('admin@local.test');
    const res = await api('GET', '/api/admin/users', { token });
    assert.equal(res.status, 200);
    assert.ok(res.body.users.length >= 7, 'seeded admin + 6 employees');
  });
});

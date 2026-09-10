'use strict';

// Covers the admin shift endpoints: assign, delete, and cancel-one-base-date.
// These are the manager capabilities, so the guard behaviour is the point —
// an admin must be able to remove an awarded shift, but must NOT be able to
// orphan a pull or a swap by deleting its shift row out from under it.

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { setup, stopServer, api, login } = require('./helpers');
const { ppDay } = require('../scripts/pp-dates'); // no db import: see pp-dates.js

let admin, ayman, muzan;

describe('admin shift management', () => {
  before(async () => {
    await setup();
    admin = await login('admin@local.test');
    ayman = await login('ayman@local.test');
    muzan = await login('muzan@local.test');
  });
  after(stopServer);

  async function shiftsOf(user) {
    const res = await api('GET', '/api/shifts', { token: user.token });
    assert.equal(res.status, 200);
    return res.body.shifts;
  }
  async function locations() {
    const res = await api('GET', '/api/locations', { token: admin.token });
    return res.body.locations;
  }

  // ── assign ────────────────────────────────────────────────────────────
  test('assigns a dated shift to an employee', async () => {
    const locs = await api('GET', '/api/locations', { token: admin.token });
    const loc = locs.body.locations[0];
    const date = ppDay(2, 0); // Sunday: Muzan has no base entry that day

    const res = await api('POST', '/api/admin/shifts', {
      token: admin.token,
      body: {
        user_id: muzan.user.id, location_id: loc.id,
        date, start_time: '09:00', end_time: '17:00', notes: 'assigned by test',
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const mine = await shiftsOf(muzan);
    assert.ok(mine.find(s => s.id === res.body.shift.id), 'employee should see it');
  });

  test('rejects an assignment over 18 hours', async () => {
    const loc = (await locations())[0];
    const res = await api('POST', '/api/admin/shifts', {
      token: admin.token,
      body: {
        user_id: muzan.user.id, location_id: loc.id,
        date: ppDay(2, 5), start_time: '04:00', end_time: '23:30', // Friday, free
      },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /18 hours/i);
  });

  test('rejects an assignment overlapping an existing shift', async () => {
    const loc = (await locations())[0];
    const body = {
      user_id: muzan.user.id, location_id: loc.id,
      date: ppDay(2, 6), start_time: '08:00', end_time: '16:00', // Saturday, free
    };
    assert.equal((await api('POST', '/api/admin/shifts', { token: admin.token, body })).status, 201);
    const dup = await api('POST', '/api/admin/shifts', { token: admin.token, body });
    assert.equal(dup.status, 409);
  });

  // Reported from real use: assigning a shift to someone who already had one
  // was sometimes allowed. The old check compared clock times on a single date,
  // so overnight shifts and midnight spill slipped straight through.
  test('refuses to assign over an existing overnight shift', async () => {
    const loc = (await locations())[0];
    const d = ppDay(4, 6); // Saturday: Muzan has no base entry

    assert.equal((await api('POST', '/api/admin/shifts', {
      token: admin.token,
      body: { user_id: muzan.user.id, location_id: loc.id, date: d,
              start_time: '22:00', end_time: '08:00' },
    })).status, 201);

    const clash = await api('POST', '/api/admin/shifts', {
      token: admin.token,
      body: { user_id: muzan.user.id, location_id: loc.id, date: d,
              start_time: '23:00', end_time: '05:00' },
    });
    assert.equal(clash.status, 409, 'overnight vs overnight must conflict');
    assert.match(clash.body.error, /overlap/i);
  });

  test('refuses to assign into the morning an overnight shift runs into', async () => {
    const loc = (await locations())[0];
    const night = ppDay(6, 6);      // Saturday night, free of base entries
    const morning = ppDay(6, 7);    // the Sunday it spills into, also free

    assert.equal((await api('POST', '/api/admin/shifts', {
      token: admin.token,
      body: { user_id: muzan.user.id, location_id: loc.id, date: night,
              start_time: '22:00', end_time: '08:00' },
    })).status, 201);

    const clash = await api('POST', '/api/admin/shifts', {
      token: admin.token,
      body: { user_id: muzan.user.id, location_id: loc.id, date: morning,
              start_time: '02:00', end_time: '06:00' },
    });
    assert.equal(clash.status, 409, 'a shift the night before still occupies this morning');
  });

  test('refuses to assign over the employee base schedule', async () => {
    const loc = (await locations())[0];
    // Ayman: week-1 Monday overnight base entry at 22:00-08:00.
    const res = await api('POST', '/api/admin/shifts', {
      token: admin.token,
      body: { user_id: ayman.user.id, location_id: loc.id, date: ppDay(7, 1),
              start_time: '23:00', end_time: '05:00' },
    });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /base schedule/i);
  });

  test('rejects incomplete payloads', async () => {
    const res = await api('POST', '/api/admin/shifts', {
      token: admin.token, body: { user_id: muzan.user.id },
    });
    assert.equal(res.status, 400);
  });

  // ── delete ────────────────────────────────────────────────────────────
  test('deletes a plain shift', async () => {
    const before = await shiftsOf(muzan);
    const plain = before.find(s => s.notes === 'plain seeded shift');
    assert.ok(plain, 'fixture should contain a plain shift');

    const res = await api('DELETE', `/api/admin/shifts/${plain.id}`, { token: admin.token });
    assert.equal(res.status, 200);

    const after = await shiftsOf(muzan);
    assert.ok(!after.find(s => s.id === plain.id), 'shift should be gone');
  });

  test('deletes an AWARDED shift — the case the employee app defers to admin', async () => {
    const alex = await login('alex@local.test');
    const awarded = (await shiftsOf(alex)).find(s => s.open_shift_id);
    assert.ok(awarded, 'fixture should contain an awarded shift');

    // The employee themselves is refused...
    const asEmployee = await api('DELETE', `/api/shifts/${awarded.id}`, { token: alex.token });
    assert.equal(asEmployee.status, 403);

    // ...but the admin can remove it.
    const asAdmin = await api('DELETE', `/api/admin/shifts/${awarded.id}`, { token: admin.token });
    assert.equal(asAdmin.status, 200, JSON.stringify(asAdmin.body));
  });

  test('refuses to delete a PULLED shift, pointing at the undo flow', async () => {
    const pulled = (await shiftsOf(muzan)).find(s => s.is_pulled);
    assert.ok(pulled, 'fixture should contain a pulled shift');

    const res = await api('DELETE', `/api/admin/shifts/${pulled.id}`, { token: admin.token });
    assert.equal(res.status, 409, 'must not orphan the pull record');
    assert.match(res.body.error, /pull/i);

    assert.ok((await shiftsOf(muzan)).find(s => s.id === pulled.id), 'shift must survive');
  });

  test('deleting a missing shift is a no-op, not an error', async () => {
    const res = await api('DELETE', '/api/admin/shifts/00000000-0000-0000-0000-000000000000',
      { token: admin.token });
    assert.equal(res.status, 200);
  });

  // ── cancel one base occurrence ────────────────────────────────────────
  test('suppress-date cancels one date and leaves the recurring pattern intact', async () => {
    const date = ppDay(3, 1); // a Monday: Ayman has a week-1 base entry

    const beforeSched = await api('GET', `/api/admin/users/${ayman.user.id}/schedule`,
      { token: admin.token });
    const countBefore = beforeSched.body.schedule.length;

    const res = await api('POST', '/api/admin/suppress-date', {
      token: admin.token, body: { user_id: ayman.user.id, date },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const mine = await api('GET', '/api/shifts', { token: ayman.token });
    assert.ok(mine.body.suppressed_bases.includes(date), 'date should be suppressed');

    const afterSched = await api('GET', `/api/admin/users/${ayman.user.id}/schedule`,
      { token: admin.token });
    assert.equal(afterSched.body.schedule.length, countBefore,
      'the recurring base schedule must be untouched');
  });

  test('suppress-date is idempotent', async () => {
    const date = ppDay(3, 3);
    const body = { user_id: ayman.user.id, date };
    assert.equal((await api('POST', '/api/admin/suppress-date', { token: admin.token, body })).status, 200);
    assert.equal((await api('POST', '/api/admin/suppress-date', { token: admin.token, body })).status, 200);
  });

  test('a cancelled base date can be restored', async () => {
    const date = ppDay(3, 5);
    const body = { user_id: ayman.user.id, date };
    await api('POST', '/api/admin/suppress-date', { token: admin.token, body });
    const res = await api('DELETE', '/api/admin/suppress-date', { token: admin.token, body });
    assert.equal(res.status, 200);

    const mine = await api('GET', '/api/shifts', { token: ayman.token });
    assert.ok(!mine.body.suppressed_bases.includes(date), 'suppression should be lifted');
  });

  test('suppress-date requires both fields', async () => {
    const res = await api('POST', '/api/admin/suppress-date', {
      token: admin.token, body: { user_id: ayman.user.id },
    });
    assert.equal(res.status, 400);
  });
});

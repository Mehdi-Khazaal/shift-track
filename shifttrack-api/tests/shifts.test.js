'use strict';

// Employee-facing shift rules. These are the invariants that protect payroll
// correctness, so they should fail loudly if anyone loosens them.

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { setup, stopServer, api, login } = require('./helpers');
const { ppDay } = require('../scripts/pp-dates'); // no db import: see pp-dates.js

let sam, ayman, muzan, locId;

describe('employee shift rules', () => {
  before(async () => {
    await setup();
    sam = await login('sam@local.test');
    ayman = await login('ayman@local.test');
    muzan = await login('muzan@local.test');
    const locs = await api('GET', '/api/locations', { token: sam.token });
    locId = locs.body.locations[0].id;
  });
  after(stopServer);

  const make = (date, start, end) => ({
    location_id: locId, date, start_time: start, end_time: end, notes: '',
  });

  test('creates, edits and deletes a shift', async () => {
    const created = await api('POST', '/api/shifts', {
      token: sam.token, body: make(ppDay(4, 1), '08:00', '16:00'),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.shift.id;

    const edited = await api('PUT', `/api/shifts/${id}`, {
      token: sam.token, body: make(ppDay(4, 1), '09:00', '17:00'),
    });
    assert.equal(edited.status, 200);

    const removed = await api('DELETE', `/api/shifts/${id}`, { token: sam.token });
    assert.equal(removed.status, 200);

    const mine = await api('GET', '/api/shifts', { token: sam.token });
    assert.ok(!mine.body.shifts.find(s => s.id === id));
  });

  test('rejects a shift longer than 18 hours', async () => {
    const res = await api('POST', '/api/shifts', {
      token: sam.token, body: make(ppDay(4, 3), '04:00', '23:30'),
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /18 hours/i);
  });

  test('accepts a legitimate overnight shift', async () => {
    // 22:00-08:00 crosses midnight: 10h, not a negative or 14h span.
    const res = await api('POST', '/api/shifts', {
      token: sam.token, body: make(ppDay(4, 5), '22:00', '08:00'),
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  test('rejects a shift overlapping one already logged that day', async () => {
    const date = ppDay(5, 2);
    assert.equal((await api('POST', '/api/shifts', {
      token: sam.token, body: make(date, '08:00', '16:00'),
    })).status, 201);

    const overlap = await api('POST', '/api/shifts', {
      token: sam.token, body: make(date, '12:00', '20:00'),
    });
    assert.equal(overlap.status, 409);
    assert.match(overlap.body.error, /overlap/i);
  });

  test('rejects a shift that collides with the base schedule', async () => {
    // Muzan has a week-1 Monday base entry at 08:00-16:00.
    const res = await api('POST', '/api/shifts', {
      token: muzan.token, body: make(ppDay(5, 1), '09:00', '12:00'),
    });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /base schedule/i);
  });

  // Overnight conflicts. These are the cases the old same-date clock-time
  // comparison missed entirely, and the ones reported from real use.
  test('rejects an overnight shift laid over an overnight base entry', async () => {
    // Ayman has a week-1 Monday base entry at 22:00-08:00.
    // Old check: "22:00 < 05:00" was false, so this was wrongly accepted.
    const res = await api('POST', '/api/shifts', {
      token: ayman.token, body: make(ppDay(5, 1), '23:00', '05:00'),
    });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /base schedule/i);
  });

  test('rejects a shift colliding with the prior overnight shift', async () => {
    // 22:00-08:00 on day N really occupies 00:00-08:00 on day N+1.
    const night = ppDay(7, 1);
    assert.equal((await api('POST', '/api/shifts', {
      token: sam.token, body: make(night, '22:00', '08:00'),
    })).status, 201);

    const nextMorning = await api('POST', '/api/shifts', {
      token: sam.token, body: make(ppDay(7, 2), '02:00', '06:00'),
    });
    assert.equal(nextMorning.status, 409, 'spill past midnight must conflict');
  });

  test('rejects two overlapping overnight shifts', async () => {
    const d = ppDay(8, 1);
    assert.equal((await api('POST', '/api/shifts', {
      token: sam.token, body: make(d, '22:00', '08:00'),
    })).status, 201);

    const dup = await api('POST', '/api/shifts', {
      token: sam.token, body: make(d, '23:00', '05:00'),
    });
    assert.equal(dup.status, 409);
  });

  test('still allows a shift that merely touches, without overlapping', async () => {
    // 08:00-16:00 then 16:00-22:00 share an endpoint but do not overlap.
    const d = ppDay(9, 1);
    assert.equal((await api('POST', '/api/shifts', {
      token: sam.token, body: make(d, '08:00', '16:00'),
    })).status, 201);
    const adjacent = await api('POST', '/api/shifts', {
      token: sam.token, body: make(d, '16:00', '22:00'),
    });
    assert.equal(adjacent.status, 201, 'back-to-back shifts are legal');
  });

  test('the morning after an overnight shift is still bookable once clear', async () => {
    const night = ppDay(10, 1);
    assert.equal((await api('POST', '/api/shifts', {
      token: sam.token, body: make(night, '22:00', '06:00'),
    })).status, 201);
    // 06:00 end, new shift starts 07:00 the next day: no overlap.
    const later = await api('POST', '/api/shifts', {
      token: sam.token, body: make(ppDay(10, 2), '07:00', '12:00'),
    });
    assert.equal(later.status, 201, JSON.stringify(later.body));
  });

  test('one employee cannot touch another employee\'s shift', async () => {
    const created = await api('POST', '/api/shifts', {
      token: sam.token, body: make(ppDay(6, 1), '08:00', '16:00'),
    });
    const id = created.body.shift.id;

    // Deletes are scoped by user_id, so this must not remove Sam's shift.
    await api('DELETE', `/api/shifts/${id}`, { token: ayman.token });

    const mine = await api('GET', '/api/shifts', { token: sam.token });
    assert.ok(mine.body.shifts.find(s => s.id === id), 'shift must still belong to Sam');
  });

  test('GET /api/shifts only ever returns your own shifts', async () => {
    const res = await api('GET', '/api/shifts', { token: sam.token });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.shifts));
    assert.ok(Array.isArray(res.body.suppressed_bases));
  });
});

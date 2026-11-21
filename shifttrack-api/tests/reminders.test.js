// The reminder ledger: the thing that lets the cron and /send-upcoming both
// exist without either sending a reminder twice.
//
// Before it, duplicates were prevented by keeping the cron's match window
// exactly as wide as the cron interval (48370f7). That coupling broke silently
// when the interval changed from 1 minute to 5 (c277893) and the window did not,
// leaving roughly 4 of every 5 reminders undelivered.
'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { setup, stopServer, api, login } = require('./helpers');

describe('shift reminder delivery', () => {
  let employee;

  before(async () => {
    await setup();
    employee = await login('ayman@local.test');
  });
  after(stopServer);

  test('send-upcoming does not fire before the reminder is due', async () => {
    const res = await api('POST', '/api/notifications/send-upcoming', { token: employee.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    // The seeded schedule has nothing whose notify moment has already passed,
    // so nothing goes out. The old rule fired for anything due within the next
    // hour, which is what made reminders arrive early.
    assert.equal(res.body.sent, 0, 'expected no early sends');
  });

  test('calling send-upcoming repeatedly never re-sends', async () => {
    const first  = await api('POST', '/api/notifications/send-upcoming', { token: employee.token });
    const second = await api('POST', '/api/notifications/send-upcoming', { token: employee.token });
    const third  = await api('POST', '/api/notifications/send-upcoming', { token: employee.token });

    assert.equal(first.status, 200);
    assert.equal(second.body.sent, 0, 'a second call must not repeat anything');
    assert.equal(third.body.sent, 0, 'nor a third');
  });

  test('the endpoint requires authentication', async () => {
    const res = await api('POST', '/api/notifications/send-upcoming');
    assert.equal(res.status, 401);
  });

  test('notification history is readable', async () => {
    const res = await api('GET', '/api/notifications/history', { token: employee.token });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.notifications));
  });

  test('a targeted user gets a history entry even with no push subscription', async () => {
    // notification_log used to be written inside the per-subscription send loop,
    // so anyone who never enabled push ended up with an empty in-app bell.
    const admin = await login('admin@local.test');
    const before = await api('GET', '/api/notifications/history', { token: employee.token });

    const sent = await api('POST', '/api/notifications/broadcast', {
      token: admin.token,
      body: { title: 'Test Notice', body: 'ledger check' },
    });
    assert.equal(sent.status, 200);

    const after = await api('GET', '/api/notifications/history', { token: employee.token });
    assert.ok(
      after.body.notifications.length > before.body.notifications.length,
      'the employee has no push subscription but should still have a history row'
    );
    assert.equal(after.body.notifications[0].title, 'Test Notice');
  });
});

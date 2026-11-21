const cron    = require('node-cron');
const webpush = require('./utils/webpush');
const db      = require('./db/index');
const { payWeekOf, DEFAULT_ANCHOR } = require('./utils/ppAnchor');
const { getPtoAnnualHours, availableHours } = require('./routes/leave');
const { reminderKey, claimReminder, releaseReminder, pushToSubs, logNotification } = require('./utils/push');

function groupBy(arr, key) {
  return arr.reduce((acc, item) => {
    (acc[item[key]] ||= []).push(item);
    return acc;
  }, {});
}

// Runs every 5 minutes - sends push notifications when it's time
cron.schedule('*/5 * * * *', async () => {
  try {
    const now = new Date();
    // The look-back window must match the cron interval, or reminders whose
    // moment lands between ticks are never sent at all. It was left at 60s when
    // c277893 moved this job from every minute to every five, which meant only
    // ~1 minute in every 5 was covered and most reminders silently vanished.
    // Duplicates are now prevented by the reminder_sends ledger, not by keeping
    // this window artificially narrow.
    const windowBackMs = 5 * 60 * 1000;
    const windowFwdMs  = 5  * 1000;

    // Cheap count check before fetching all subscription data
    const { rows: [{ count }] } = await db.query('SELECT COUNT(*) FROM push_subscriptions');
    if (Number(count) === 0) return;

    const subsRes = await db.query('SELECT * FROM push_subscriptions');
    if (!subsRes.rows.length) return;

    const userIds = [...new Set(subsRes.rows.map(s => s.user_id))];

    // Batch fetch all data needed for every subscribed user in 4 queries.
    // Logged reminders only need shifts near the current date, not full history.
    const [shiftsRes, baseRes, suppressedRes, anchorsRes] = await Promise.all([
      db.query(
        // id is part of each reminder's ledger key. Without it every key read
        // "logged:undefined:<date>", so a second shift on the same day was
        // treated as already reminded, and keys never matched send-upcoming's.
        `SELECT s.id, s.user_id, s.date, s.start_time, s.end_time, l.name AS location_name
         FROM shifts s JOIN locations l ON s.location_id = l.id
         WHERE s.user_id = ANY($1)
           AND s.date BETWEEN CURRENT_DATE - INTERVAL '2 days'
                          AND CURRENT_DATE + INTERVAL '2 days'`,
        [userIds]
      ),
      db.query(
        `SELECT b.id, b.user_id, b.week, b.day_of_week, b.start_time, b.end_time, l.name AS location_name
         FROM base_schedule b JOIN locations l ON b.location_id = l.id
         WHERE b.user_id = ANY($1)`,
        [userIds]
      ),
      db.query(
        'SELECT user_id, date FROM base_suppressed_dates WHERE user_id = ANY($1)',
        [userIds]
      ),
      db.query(
        'SELECT user_id, pp_anchor FROM user_settings WHERE user_id = ANY($1)',
        [userIds]
      ),
    ]);

    const shiftsByUser = groupBy(shiftsRes.rows, 'user_id');
    const baseByUser   = groupBy(baseRes.rows,   'user_id');

    const suppressedByUser = {};
    for (const r of suppressedRes.rows) {
      (suppressedByUser[r.user_id] ||= new Set()).add(String(r.date).slice(0, 10));
    }
    const anchorByUser = {};
    for (const r of anchorsRes.rows) {
      anchorByUser[r.user_id] = String(r.pp_anchor).slice(0, 10);
    }

    // Walk users rather than subscriptions: a reminder is claimed once per user
    // per shift, then delivered to every device they have registered. Iterating
    // subscriptions instead would let the first device claim the reminder and
    // leave the others silent.
    const subsByUser = groupBy(subsRes.rows, 'user_id');

    for (const userId of Object.keys(subsByUser)) {
      const userSubs      = subsByUser[userId];
      const userShifts    = shiftsByUser[userId]     || [];
      const userBase      = baseByUser[userId]       || [];
      const suppressedSet = suppressedByUser[userId] || new Set();
      const anchorStr     = anchorByUser[userId]     || DEFAULT_ANCHOR;

      // Devices can carry different notify_minutes / tz_offset, so collect the
      // union of what is due across them, keyed so duplicates collapse.
      const due = new Map();

      for (const sub of userSubs) {
        const notifyMs = Number(sub.notify_minutes) * 60 * 1000;
        // tz_offset from getTimezoneOffset(): positive = behind UTC (e.g. Eastern = 240)
        // UTC = local + tz_offset  =>  add offset to convert stored local time to UTC
        const tzOffset = Number(sub.tz_offset || 0);

        const isDue = (dateStr, startTime) => {
          const shiftTime = new Date(`${dateStr}T${startTime}`);
          shiftTime.setMinutes(shiftTime.getMinutes() + tzOffset);
          const notifTime = new Date(shiftTime.getTime() - notifyMs);
          return notifTime >= now.getTime() - windowBackMs
              && notifTime <= now.getTime() + windowFwdMs;
        };

        // Logged shifts - date/time stored in user's local timezone
        for (const s of userShifts) {
          const dateStr = String(s.date).slice(0, 10);
          if (isDue(dateStr, s.start_time)) {
            due.set(reminderKey('logged', s.id, dateStr),
              { name: s.location_name, time: s.start_time.slice(0, 5) });
          }
        }

        // Base schedule - check next 14 days in user's local time
        const localNowMs = now.getTime() - tzOffset * 60 * 1000;
        for (let offset = 0; offset < 14; offset++) {
          const localD    = new Date(localNowMs + offset * 86400000);
          const dayStr    = localD.toISOString().slice(0, 10);
          const dayOfWeek = localD.getUTCDay();
          const weekNum   = payWeekOf(dayStr, anchorStr);

          if (suppressedSet.has(dayStr)) continue;

          for (const b of userBase) {
            if (Number(b.week) === weekNum && Number(b.day_of_week) === dayOfWeek) {
              if (isDue(dayStr, b.start_time)) {
                due.set(reminderKey('base', b.id, dayStr),
                  { name: b.location_name, time: b.start_time.slice(0, 5) });
              }
            }
          }
        }
      }

      for (const [shiftKey, shift] of due) {
        // Skip anything send-upcoming already delivered when the app was opened.
        if (!(await claimReminder(userId, shiftKey))) continue;

        const notifBody = `Your shift at ${shift.name} starts at ${shift.time}`;
        const delivered = await pushToSubs(userSubs, JSON.stringify({
          title: 'Shift Reminder',
          body:  notifBody,
          icon:  '/shift-track/icons/icon-192.png',
          tag:   shiftKey,
        }));
        if (!delivered) {
          await releaseReminder(userId, shiftKey);   // let send-upcoming retry it
          continue;
        }
        await logNotification(userId, 'Shift Reminder', notifBody);
        console.log(`[notify] Sent reminder to user ${userId} for ${shift.name} at ${shift.time}`);
      }
    }
  } catch (err) {
    console.error('[scheduler] Error:', err.message);
  }
});

// Runs every 5 minutes - process expired house-type open shifts (assign winner + notify)
cron.schedule('*/5 * * * *', async () => {
  try {
    const expired = await db.query(
      `SELECT os.*, l.name AS location_name
       FROM open_shifts os
       JOIN locations l ON os.location_id = l.id
       WHERE os.status = 'open'
         AND os.target_type = 'house'
         AND os.deadline <= NOW()`
    );

    for (const shift of expired.rows) {
      const claims = await db.query(
        `SELECT c.user_id, u.hire_date, u.name
         FROM open_shift_claims c
         JOIN users u ON c.user_id = u.id
         WHERE c.open_shift_id = $1 AND c.response = 'claimed'
         ORDER BY u.hire_date ASC NULLS LAST, c.responded_at ASC
         LIMIT 1`,
        [shift.id]
      );

      if (!claims.rows.length) {
        await db.query(`UPDATE open_shifts SET status='expired' WHERE id=$1`, [shift.id]);
        console.log(`[scheduler] House shift ${shift.id} expired with no claimers`);
        continue;
      }

      const winner = claims.rows[0];
      const dateStr = String(shift.date).slice(0, 10);

      // Atomic claim: only the first cron tick to run this wins the race
      const claimed = await db.query(
        `UPDATE open_shifts SET status='claimed', claimed_by=$1 WHERE id=$2 AND status='open' RETURNING id`,
        [winner.user_id, shift.id]
      );
      if (!claimed.rows.length) continue; // another tick already processed this shift

      const adminRes = await db.query('SELECT name FROM users WHERE id=$1', [shift.created_by]);
      const adminName = adminRes.rows[0]?.name || 'Admin';
      await db.query(
        `INSERT INTO shifts (user_id, location_id, date, start_time, end_time, notes, open_shift_id, awarded_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [winner.user_id, shift.location_id, shift.date, shift.start_time, shift.end_time, shift.notes || '', shift.id, adminName]
      );

      const notifBody = `You got the open shift at ${shift.location_name} on ${dateStr} (${shift.start_time.slice(0,5)}-${shift.end_time.slice(0,5)})`;
      const payload = JSON.stringify({ title: 'Shift Assigned', body: notifBody, icon: '/shift-track/icons/icon-192.png' });
      const subs = await db.query('SELECT * FROM push_subscriptions WHERE user_id=$1', [winner.user_id]);
      for (const sub of subs.rows) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload
          );
        } catch (e) {
          if (e.statusCode === 410)
            await db.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [sub.endpoint]);
          else
            console.error(`[scheduler] Push failed for user ${winner.user_id}: ${e.statusCode || e.message}`);
        }
      }
      await db.query(
        'INSERT INTO notification_log (user_id, title, body) VALUES ($1,$2,$3)',
        [winner.user_id, 'Shift Assigned', notifBody]
      );
      console.log(`[scheduler] House shift ${shift.id} assigned to user ${winner.user_id}`);
    }
  } catch (err) {
    console.error('[scheduler] Open shift deadline error:', err.message);
  }
});

console.log('[scheduler] Notification cron started (every 5 minutes)');

// -- Daily at 00:20 - prune the reminder ledger --------------------------------
// Rows only exist to stop a reminder being sent twice; once the shift is well
// past they are dead weight. Kept separate from the leave cron below so the two
// concerns stay independent.
cron.schedule('20 0 * * *', async () => {
  try {
    const r = await db.query(`DELETE FROM reminder_sends WHERE sent_at < NOW() - INTERVAL '30 days'`);
    if (r.rowCount) console.log(`[scheduler] Pruned ${r.rowCount} reminder ledger rows`);
  } catch (err) {
    console.error('[scheduler] Reminder ledger prune error:', err.message);
  }
});

// -- Daily at 00:05 - PTO accrual + anniversary processing --------------------
cron.schedule('5 0 * * *', async () => {
  try {
    const typesRes = await db.query('SELECT * FROM leave_types');
    const ptoType  = typesRes.rows.find(t => t.name === 'pto');
    const sickType = typesRes.rows.find(t => t.name === 'sick_time');
    if (!ptoType || !sickType) return;

    const users = await db.query(
      `SELECT id, hire_date, name, location_id FROM users
       WHERE is_active=TRUE AND hire_date IS NOT NULL`
    );
    if (!users.rows.length) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().slice(0, 10);

    // Batch fetch all leave balances and location rates up front — eliminates N+1 reads.
    const userIds     = users.rows.map(u => u.id);
    const locationIds = [...new Set(users.rows.map(u => u.location_id).filter(Boolean))];

    const [balancesRes, locRatesRes] = await Promise.all([
      db.query(
        `SELECT lb.*, lt.name AS type_name
         FROM leave_balances lb
         JOIN leave_types lt ON lb.leave_type_id = lt.id
         WHERE lb.user_id = ANY($1)`,
        [userIds]
      ),
      locationIds.length
        ? db.query('SELECT id, rate FROM locations WHERE id = ANY($1)', [locationIds])
        : Promise.resolve({ rows: [] }),
    ]);

    const balancesByUser = {};
    for (const b of balancesRes.rows) {
      (balancesByUser[b.user_id] ||= {})[b.type_name] = b;
    }
    const rateById = {};
    for (const l of locRatesRes.rows) {
      rateById[l.id] = parseFloat(l.rate);
    }

    for (const user of users.rows) {
      try {
        const hire = new Date(user.hire_date);
        hire.setHours(0, 0, 0, 0);

        const isAnniversary = (
          today.getMonth()    === hire.getMonth() &&
          today.getDate()     === hire.getDate()  &&
          today.getFullYear() >  hire.getFullYear()
        );

        if (isAnniversary) {
          const completedYears = today.getFullYear() - hire.getFullYear();
          const ptoBal  = balancesByUser[user.id]?.pto;
          const sickBal = balancesByUser[user.id]?.sick_time;

          if (ptoBal) {
            const carryover = Math.min(availableHours(ptoBal), 40);
            await db.query(
              `UPDATE leave_balances
               SET accrued_hours=0, used_hours=0, carried_over_hours=$1, anniversary_year_start=$2
               WHERE user_id=$3 AND leave_type_id=$4`,
              [carryover, todayStr, user.id, ptoType.id]
            );
          } else {
            await db.query(
              `INSERT INTO leave_balances
                 (user_id, leave_type_id, accrued_hours, used_hours, carried_over_hours, anniversary_year_start)
               VALUES ($1,$2,0,0,0,$3)
               ON CONFLICT DO NOTHING`,
              [user.id, ptoType.id, todayStr]
            );
          }

          if (sickBal) {
            const sickAvail = availableHours(sickBal);
            const rate = user.location_id ? (rateById[user.location_id] || 0) : 0;
            if (sickAvail > 0) {
              await db.query(
                `INSERT INTO sick_time_payouts (user_id, hours_paid, hourly_rate, total_amount)
                 VALUES ($1,$2,$3,$4)`,
                [user.id, sickAvail, rate, sickAvail * rate]
              );
              console.log(`[scheduler] Sick payout: ${user.name} - ${sickAvail} hrs @ $${rate} = $${(sickAvail * rate).toFixed(2)}`);
            }
            await db.query(
              `UPDATE leave_balances
               SET accrued_hours=40, used_hours=0, carried_over_hours=0, anniversary_year_start=$1
               WHERE user_id=$2 AND leave_type_id=$3`,
              [todayStr, user.id, sickType.id]
            );
          } else {
            await db.query(
              `INSERT INTO leave_balances
                 (user_id, leave_type_id, accrued_hours, used_hours, carried_over_hours, anniversary_year_start)
               VALUES ($1,$2,40,0,0,$3)
               ON CONFLICT DO NOTHING`,
              [user.id, sickType.id, todayStr]
            );
          }

          console.log(`[scheduler] Anniversary processed for ${user.name} (year ${completedYears})`);
        }

        // Daily PTO accrual - skip employees in their first year
        const msPerYear  = 365.25 * 86400000;
        const totalYears = (today - hire) / msPerYear;
        if (totalYears < 1) continue;

        // Find the anniversary year start (most recent anniversary on or before today)
        let anniversaryYearStart = new Date(hire);
        while (true) {
          const next = new Date(anniversaryYearStart);
          next.setFullYear(next.getFullYear() + 1);
          if (next > today) break;
          anniversaryYearStart = next;
        }
        const completedYearsAtAy = Math.floor((anniversaryYearStart - hire) / msPerYear);
        const annualHours  = getPtoAnnualHours(completedYearsAtAy);
        const dailyAccrual = annualHours / 365;

        if (dailyAccrual > 0) {
          await db.query(
            `UPDATE leave_balances
             SET accrued_hours = accrued_hours + $1
             WHERE user_id=$2 AND leave_type_id=$3`,
            [Math.round(dailyAccrual * 100) / 100, user.id, ptoType.id]
          );
        }
      } catch (userErr) {
        console.error(`[scheduler] Leave processing error for user ${user.id}:`, userErr.message);
      }
    }
    console.log(`[scheduler] Daily leave accrual complete - ${users.rows.length} users processed`);
  } catch (err) {
    console.error('[scheduler] Daily leave cron error:', err.message);
  }
});
console.log('[scheduler] Daily leave accrual cron started (00:05 daily)');

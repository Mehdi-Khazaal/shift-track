const express  = require('express');
const router   = express.Router();
const db       = require('../db/index');
const auth     = require('../middleware/auth');
const webpush  = require('../utils/webpush');

// ── Helpers ───────────────────────────────────────────────────────────────────

function adminOnly(req, res, next) {
  if (req.role !== 'admin')
    return res.status(403).json({ ok: false, error: 'Admin access required' });
  next();
}

async function logNotification(userId, title, body) {
  try {
    await db.query(
      'INSERT INTO notification_log (user_id, title, body) VALUES ($1,$2,$3)',
      [userId, title, body]
    );
  } catch (e) { /* non-fatal */ }
}

async function sendPushToUser(userId, title, body) {
  const subs = await db.query(
    'SELECT * FROM push_subscriptions WHERE user_id=$1', [userId]
  );
  const payload = JSON.stringify({ title, body, icon: '/shift-track/icon-192.png' });
  for (const sub of subs.rows) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
    } catch (e) {
      if (e.statusCode === 410)
        await db.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [sub.endpoint]);
    }
  }
  await logNotification(userId, title, body);
}

async function sendPushToAllAdmins(title, body) {
  const admins = await db.query(
    `SELECT ps.* FROM push_subscriptions ps
     JOIN users u ON ps.user_id = u.id
     WHERE u.role = 'admin' AND u.is_active = TRUE`
  );
  const payload = JSON.stringify({ title, body, icon: '/shift-track/icon-192.png' });
  const notified = new Set();
  for (const sub of admins.rows) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
      if (!notified.has(sub.user_id)) {
        notified.add(sub.user_id);
        await logNotification(sub.user_id, title, body);
      }
    } catch (e) {
      if (e.statusCode === 410)
        await db.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [sub.endpoint]);
    }
  }
}

// PTO annual hours by completed years of service
function getPtoAnnualHours(completedYears) {
  if (completedYears < 1)  return 0;
  if (completedYears < 2)  return 8;
  if (completedYears < 3)  return 32;
  if (completedYears < 4)  return 60;
  if (completedYears < 6)  return 120;
  if (completedYears < 11) return 138;
  return 164;
}

// Compute available hours for a balance row
function availableHours(bal) {
  return Math.max(0,
    parseFloat(bal.accrued_hours) +
    parseFloat(bal.carried_over_hours) -
    parseFloat(bal.used_hours)
  );
}

// Initialize leave balances for a user (idempotent — safe to call any time)
async function initUserLeaveBalances(userId, hireDate) {
  const typesRes = await db.query('SELECT id, name FROM leave_types');
  const today = new Date();
  const hire  = new Date(hireDate);

  // Compute anniversary year start (most recent anniversary on or before today)
  let anniversaryYearStart = new Date(hire);
  while (true) {
    const next = new Date(anniversaryYearStart);
    next.setFullYear(next.getFullYear() + 1);
    if (next > today) break;
    anniversaryYearStart = next;
  }
  const ayStr = anniversaryYearStart.toISOString().slice(0, 10);

  // Days since anniversary year start
  const daysSinceAnniversary = Math.floor((today - anniversaryYearStart) / 86400000);

  // Completed years on anniversary year start
  const msPerYear = 365.25 * 86400000;
  const completedYearsAtAnniversary = Math.floor((anniversaryYearStart - hire) / msPerYear);

  for (const lt of typesRes.rows) {
    if (lt.name === 'call_off') {
      // call_off has no balance tracking — skip
      continue;
    }

    let accrued = 0;
    if (lt.name === 'sick_time') {
      accrued = 40; // lump sum
    } else if (lt.name === 'pto') {
      const annual = getPtoAnnualHours(completedYearsAtAnniversary);
      accrued = Math.min(annual, (annual / 365) * daysSinceAnniversary);
      accrued = Math.round(accrued * 100) / 100;
    }

    await db.query(
      `INSERT INTO leave_balances (user_id, leave_type_id, accrued_hours, used_hours, carried_over_hours, anniversary_year_start)
       VALUES ($1, $2, $3, 0, 0, $4)
       ON CONFLICT (user_id, leave_type_id) DO NOTHING`,
      [userId, lt.id, accrued, ayStr]
    );
  }
}

// ── GET /api/leave/balances ── employee views own balances ───────────────────
router.get('/balances', auth, async (req, res) => {
  try {
    // Ensure balances exist
    const userRes = await db.query('SELECT hire_date FROM users WHERE id=$1', [req.userId]);
    if (!userRes.rows.length) return res.status(404).json({ ok: false, error: 'User not found' });
    if (userRes.rows[0].hire_date)
      await initUserLeaveBalances(req.userId, userRes.rows[0].hire_date);

    const result = await db.query(
      `SELECT lb.*, lt.name AS type_name, lt.label AS type_label, lt.color AS type_color
       FROM leave_balances lb
       JOIN leave_types lt ON lb.leave_type_id = lt.id
       WHERE lb.user_id = $1`,
      [req.userId]
    );
    const balances = result.rows.map(b => ({
      ...b,
      available_hours: availableHours(b)
    }));
    res.json({ ok: true, balances });
  } catch (err) {
    console.error('[leave/balances]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── GET /api/leave/requests ── employee views own requests ───────────────────
router.get('/requests', auth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT lr.*, lt.name AS type_name, lt.label AS type_label, lt.color AS type_color,
              u_sub.name AS submitted_by_name, u_rev.name AS reviewed_by_name
       FROM leave_requests lr
       JOIN leave_types lt ON lr.leave_type_id = lt.id
       LEFT JOIN users u_sub ON lr.submitted_by = u_sub.id
       LEFT JOIN users u_rev ON lr.reviewed_by  = u_rev.id
       WHERE lr.user_id = $1
       ORDER BY lr.created_at DESC`,
      [req.userId]
    );
    res.json({ ok: true, requests: result.rows });
  } catch (err) {
    console.error('[leave/requests]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── POST /api/leave/requests ── employee submits leave request ───────────────
router.post('/requests', auth, async (req, res) => {
  const { leave_type_name, date, hours_requested, notes, start_time, end_time } = req.body;
  if (!leave_type_name || !date || !hours_requested)
    return res.status(400).json({ ok: false, error: 'leave_type_name, date, hours_requested required' });

  const hrs = parseFloat(hours_requested);
  if (isNaN(hrs) || hrs <= 0)
    return res.status(400).json({ ok: false, error: 'Invalid hours_requested' });

  try {
    // Get leave type
    const ltRes = await db.query('SELECT * FROM leave_types WHERE name=$1', [leave_type_name]);
    if (!ltRes.rows.length) return res.status(400).json({ ok: false, error: 'Invalid leave type' });
    const lt = ltRes.rows[0];

    // Ensure balance exists
    const userRes = await db.query('SELECT hire_date FROM users WHERE id=$1', [req.userId]);
    if (userRes.rows[0].hire_date)
      await initUserLeaveBalances(req.userId, userRes.rows[0].hire_date);

    // For call_off, no balance check — admin handles sick time deduction later
    if (leave_type_name !== 'call_off') {
      // Check balance
      const balRes = await db.query(
        'SELECT * FROM leave_balances WHERE user_id=$1 AND leave_type_id=$2',
        [req.userId, lt.id]
      );
      if (!balRes.rows.length)
        return res.status(400).json({ ok: false, error: 'No leave balance found' });

      const available = availableHours(balRes.rows[0]);
      if (hrs > available)
        return res.status(400).json({
          ok: false,
          error: `Insufficient ${lt.label} balance. Available: ${available.toFixed(2)} hrs`
        });
    }

    // Check no duplicate pending/approved request on same date for same type
    const dupCheck = await db.query(
      `SELECT id FROM leave_requests
       WHERE user_id=$1 AND leave_type_id=$2 AND date=$3
         AND status IN ('pending','approved')`,
      [req.userId, lt.id, date]
    );
    if (dupCheck.rows.length)
      return res.status(409).json({ ok: false, error: 'A request for that date already exists' });

    const result = await db.query(
      `INSERT INTO leave_requests
         (user_id, leave_type_id, date, hours_requested, notes, submitted_by, start_time, end_time)
       VALUES ($1,$2,$3,$4,$5,$1,$6,$7) RETURNING *`,
      [req.userId, lt.id, date, hrs, notes || '', start_time || null, end_time || null]
    );

    // Notify all admins
    const empRes = await db.query('SELECT name FROM users WHERE id=$1', [req.userId]);
    const empName = empRes.rows[0]?.name || 'An employee';
    const timeStr = start_time && end_time ? ` (${start_time}–${end_time})` : '';
    await sendPushToAllAdmins(
      'Leave Request Submitted',
      `${empName} requested ${hrs} hrs of ${lt.label} on ${date}${timeStr}`
    );

    res.status(201).json({ ok: true, request: result.rows[0] });
  } catch (err) {
    console.error('[leave/requests POST]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── PATCH /api/leave/requests/:id/cancel ── employee cancels pending ─────────
router.patch('/requests/:id/cancel', auth, async (req, res) => {
  try {
    const reqRes = await db.query(
      'SELECT * FROM leave_requests WHERE id=$1 AND user_id=$2',
      [req.params.id, req.userId]
    );
    if (!reqRes.rows.length)
      return res.status(404).json({ ok: false, error: 'Request not found' });
    const lr = reqRes.rows[0];
    if (lr.status !== 'pending')
      return res.status(400).json({ ok: false, error: 'Only pending requests can be cancelled by employee' });

    await db.query(
      `UPDATE leave_requests SET status='cancelled' WHERE id=$1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[leave/cancel]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── GET /api/leave/admin/requests ── admin gets all requests ─────────────────
router.get('/admin/requests', auth, adminOnly, async (req, res) => {
  try {
    const { status, user_id } = req.query;
    let q = `
      SELECT lr.*, lt.name AS type_name, lt.label AS type_label, lt.color AS type_color,
             u.name AS employee_name, u.position AS employee_position,
             u_sub.name AS submitted_by_name, u_rev.name AS reviewed_by_name
      FROM leave_requests lr
      JOIN leave_types lt ON lr.leave_type_id = lt.id
      JOIN users u ON lr.user_id = u.id
      LEFT JOIN users u_sub ON lr.submitted_by = u_sub.id
      LEFT JOIN users u_rev ON lr.reviewed_by  = u_rev.id
      WHERE 1=1`;
    const params = [];
    if (status) { params.push(status); q += ` AND lr.status=$${params.length}`; }
    if (user_id) { params.push(user_id); q += ` AND lr.user_id=$${params.length}`; }
    q += ' ORDER BY lr.created_at DESC LIMIT 200';

    const result = await db.query(q, params);
    res.json({ ok: true, requests: result.rows });
  } catch (err) {
    console.error('[leave/admin/requests]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── GET /api/leave/admin/balances/:userId ── admin views a user's balances ───
router.get('/admin/balances/:userId', auth, adminOnly, async (req, res) => {
  try {
    const userRes = await db.query('SELECT hire_date, name FROM users WHERE id=$1', [req.params.userId]);
    if (!userRes.rows.length) return res.status(404).json({ ok: false, error: 'User not found' });
    if (userRes.rows[0].hire_date)
      await initUserLeaveBalances(req.params.userId, userRes.rows[0].hire_date);

    const result = await db.query(
      `SELECT lb.*, lt.name AS type_name, lt.label AS type_label, lt.color AS type_color
       FROM leave_balances lb
       JOIN leave_types lt ON lb.leave_type_id = lt.id
       WHERE lb.user_id = $1`,
      [req.params.userId]
    );
    const balances = result.rows.map(b => ({ ...b, available_hours: availableHours(b) }));
    res.json({ ok: true, balances, user: userRes.rows[0] });
  } catch (err) {
    console.error('[leave/admin/balances]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── PATCH /api/leave/requests/:id/approve ── admin approves ─────────────────
router.patch('/requests/:id/approve', auth, adminOnly, async (req, res) => {
  try {
    const lrRes = await db.query(
      `SELECT lr.*, lt.name AS type_name, lt.label AS type_label
       FROM leave_requests lr
       JOIN leave_types lt ON lr.leave_type_id = lt.id
       WHERE lr.id=$1`,
      [req.params.id]
    );
    if (!lrRes.rows.length)
      return res.status(404).json({ ok: false, error: 'Request not found' });
    const lr = lrRes.rows[0];

    if (lr.status !== 'pending')
      return res.status(400).json({ ok: false, error: `Request is already ${lr.status}` });

    // Deduct from balance (not for call_off — handled separately)
    if (lr.type_name !== 'call_off') {
      await db.query(
        `UPDATE leave_balances
         SET used_hours = used_hours + $1
         WHERE user_id=$2 AND leave_type_id=$3`,
        [lr.hours_requested, lr.user_id, lr.leave_type_id]
      );
    }

    await db.query(
      `UPDATE leave_requests
       SET status='approved', reviewed_by=$1, reviewed_at=NOW()
       WHERE id=$2`,
      [req.userId, req.params.id]
    );

    // Notify employee
    const empRes = await db.query('SELECT name FROM users WHERE id=$1', [lr.user_id]);
    const empName = empRes.rows[0]?.name || 'Employee';
    await sendPushToUser(
      lr.user_id,
      'Leave Request Approved',
      `Your ${lr.type_label} request for ${lr.date ? String(lr.date).slice(0,10) : ''} (${lr.hours_requested} hrs) has been approved`
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[leave/approve]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── PATCH /api/leave/requests/:id/deny ── admin denies with reason ────────────
router.patch('/requests/:id/deny', auth, adminOnly, async (req, res) => {
  const { denial_reason } = req.body;
  if (!denial_reason || !denial_reason.trim())
    return res.status(400).json({ ok: false, error: 'A denial reason is required' });

  try {
    const lrRes = await db.query(
      `SELECT lr.*, lt.label AS type_label
       FROM leave_requests lr
       JOIN leave_types lt ON lr.leave_type_id = lt.id
       WHERE lr.id=$1`,
      [req.params.id]
    );
    if (!lrRes.rows.length)
      return res.status(404).json({ ok: false, error: 'Request not found' });
    const lr = lrRes.rows[0];

    if (lr.status !== 'pending')
      return res.status(400).json({ ok: false, error: `Request is already ${lr.status}` });

    await db.query(
      `UPDATE leave_requests
       SET status='denied', denial_reason=$1, reviewed_by=$2, reviewed_at=NOW()
       WHERE id=$3`,
      [denial_reason.trim(), req.userId, req.params.id]
    );

    // Notify employee
    await sendPushToUser(
      lr.user_id,
      'Leave Request Denied',
      `Your ${lr.type_label} request for ${lr.date ? String(lr.date).slice(0,10) : ''} was denied: ${denial_reason.trim()}`
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[leave/deny]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── PATCH /api/leave/requests/:id/reverse ── admin reverses an approved request
router.patch('/requests/:id/reverse', auth, adminOnly, async (req, res) => {
  try {
    const lrRes = await db.query(
      `SELECT lr.*, lt.name AS type_name, lt.label AS type_label
       FROM leave_requests lr
       JOIN leave_types lt ON lr.leave_type_id = lt.id
       WHERE lr.id=$1`,
      [req.params.id]
    );
    if (!lrRes.rows.length)
      return res.status(404).json({ ok: false, error: 'Request not found' });
    const lr = lrRes.rows[0];

    if (lr.status !== 'approved')
      return res.status(400).json({ ok: false, error: 'Only approved requests can be reversed' });

    // Restore balance
    if (lr.type_name !== 'call_off') {
      await db.query(
        `UPDATE leave_balances
         SET used_hours = GREATEST(0, used_hours - $1)
         WHERE user_id=$2 AND leave_type_id=$3`,
        [lr.hours_requested, lr.user_id, lr.leave_type_id]
      );
    }

    // If a call_off had sick hours applied, restore those too
    if (lr.type_name === 'call_off' && parseFloat(lr.sick_hours_applied) > 0) {
      const sickType = await db.query(`SELECT id FROM leave_types WHERE name='sick_time'`);
      if (sickType.rows.length) {
        await db.query(
          `UPDATE leave_balances
           SET used_hours = GREATEST(0, used_hours - $1)
           WHERE user_id=$2 AND leave_type_id=$3`,
          [lr.sick_hours_applied, lr.user_id, sickType.rows[0].id]
        );
      }
    }

    await db.query(
      `UPDATE leave_requests
       SET status='cancelled', sick_hours_applied=0, reviewed_by=$1, reviewed_at=NOW()
       WHERE id=$2`,
      [req.userId, req.params.id]
    );

    // Notify employee
    await sendPushToUser(
      lr.user_id,
      'Leave Request Cancelled',
      `Your ${lr.type_label} request for ${lr.date ? String(lr.date).slice(0,10) : ''} has been cancelled by admin`
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[leave/reverse]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── POST /api/leave/calloff ── admin creates a call-off for an employee ───────
router.post('/calloff', auth, adminOnly, async (req, res) => {
  const { user_id, date, hours_requested, notes, apply_sick_time } = req.body;
  if (!user_id || !date || !hours_requested)
    return res.status(400).json({ ok: false, error: 'user_id, date, hours_requested required' });

  const hrs = parseFloat(hours_requested);
  if (isNaN(hrs) || hrs <= 0)
    return res.status(400).json({ ok: false, error: 'Invalid hours_requested' });

  try {
    const callOffType = await db.query(`SELECT * FROM leave_types WHERE name='call_off'`);
    const sickType    = await db.query(`SELECT * FROM leave_types WHERE name='sick_time'`);
    if (!callOffType.rows.length) return res.status(500).json({ ok: false, error: 'leave_types not seeded' });

    const callOffLt = callOffType.rows[0];
    const sickLt    = sickType.rows[0];

    // Ensure balances exist for the employee
    const userRes = await db.query('SELECT hire_date, name FROM users WHERE id=$1', [user_id]);
    if (!userRes.rows.length) return res.status(404).json({ ok: false, error: 'User not found' });
    if (userRes.rows[0].hire_date)
      await initUserLeaveBalances(user_id, userRes.rows[0].hire_date);

    let sickApplied = 0;

    // If admin chose to apply sick time
    if (apply_sick_time && sickLt) {
      const sickBal = await db.query(
        'SELECT * FROM leave_balances WHERE user_id=$1 AND leave_type_id=$2',
        [user_id, sickLt.id]
      );
      if (sickBal.rows.length) {
        const available = availableHours(sickBal.rows[0]);
        sickApplied = Math.min(available, hrs);
        if (sickApplied > 0) {
          await db.query(
            `UPDATE leave_balances SET used_hours = used_hours + $1
             WHERE user_id=$2 AND leave_type_id=$3`,
            [sickApplied, user_id, sickLt.id]
          );
        }
      }
    }

    const result = await db.query(
      `INSERT INTO leave_requests
         (user_id, leave_type_id, date, hours_requested, notes, submitted_by, reviewed_by, reviewed_at, status, sick_hours_applied)
       VALUES ($1,$2,$3,$4,$5,$6,$6,NOW(),'approved',$7)
       RETURNING *`,
      [user_id, callOffLt.id, date, hrs, notes || '', req.userId, sickApplied]
    );

    // Notify employee
    const empName = userRes.rows[0]?.name || 'Employee';
    let notifBody = `A call-off has been recorded for you on ${date} (${hrs} hrs)`;
    if (sickApplied > 0)
      notifBody += `. ${sickApplied} hrs applied from Sick Time balance.`;
    await sendPushToUser(user_id, 'Call-Off Recorded', notifBody);

    res.status(201).json({ ok: true, request: result.rows[0], sick_hours_applied: sickApplied });
  } catch (err) {
    console.error('[leave/calloff POST]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── PATCH /api/leave/calloff/:id/convert-sick ── admin converts call-off to sick
router.patch('/calloff/:id/convert-sick', auth, adminOnly, async (req, res) => {
  try {
    const lrRes = await db.query(
      `SELECT lr.*, lt.name AS type_name
       FROM leave_requests lr
       JOIN leave_types lt ON lr.leave_type_id = lt.id
       WHERE lr.id=$1`,
      [req.params.id]
    );
    if (!lrRes.rows.length)
      return res.status(404).json({ ok: false, error: 'Request not found' });
    const lr = lrRes.rows[0];

    if (lr.type_name !== 'call_off')
      return res.status(400).json({ ok: false, error: 'Only call-offs can be converted' });
    if (lr.status !== 'approved')
      return res.status(400).json({ ok: false, error: 'Only approved call-offs can be converted' });

    const sickType = await db.query(`SELECT * FROM leave_types WHERE name='sick_time'`);
    if (!sickType.rows.length) return res.status(500).json({ ok: false, error: 'Sick time type not found' });
    const sickLt = sickType.rows[0];

    // Check how many sick hours are already applied
    const alreadyApplied = parseFloat(lr.sick_hours_applied) || 0;
    const remaining = parseFloat(lr.hours_requested) - alreadyApplied;

    if (remaining <= 0)
      return res.status(400).json({ ok: false, error: 'Sick time is already fully applied to this call-off' });

    // Get available sick balance
    const sickBal = await db.query(
      'SELECT * FROM leave_balances WHERE user_id=$1 AND leave_type_id=$2',
      [lr.user_id, sickLt.id]
    );
    const available = sickBal.rows.length ? availableHours(sickBal.rows[0]) : 0;
    const toApply   = Math.min(available, remaining);

    if (toApply <= 0)
      return res.status(400).json({ ok: false, error: 'No sick time balance available' });

    // Deduct from sick balance
    await db.query(
      `UPDATE leave_balances SET used_hours = used_hours + $1
       WHERE user_id=$2 AND leave_type_id=$3`,
      [toApply, lr.user_id, sickLt.id]
    );

    // Update request
    const newApplied = alreadyApplied + toApply;
    await db.query(
      `UPDATE leave_requests SET sick_hours_applied=$1, reviewed_by=$2, reviewed_at=NOW()
       WHERE id=$3`,
      [newApplied, req.userId, req.params.id]
    );

    // Notify employee
    await sendPushToUser(
      lr.user_id,
      'Call-Off Updated',
      `${toApply} hrs of Sick Time applied to your call-off on ${lr.date ? String(lr.date).slice(0,10) : ''}`
    );

    res.json({ ok: true, sick_hours_applied: newApplied, sick_hours_added: toApply });
  } catch (err) {
    console.error('[leave/convert-sick]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── GET /api/leave/admin/pending-count ── quick badge count for admins ────────
router.get('/admin/pending-count', auth, adminOnly, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT COUNT(*) AS count FROM leave_requests WHERE status='pending'`
    );
    res.json({ ok: true, count: parseInt(result.rows[0].count, 10) });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
module.exports.initUserLeaveBalances = initUserLeaveBalances;
module.exports.getPtoAnnualHours     = getPtoAnnualHours;
module.exports.availableHours        = availableHours;

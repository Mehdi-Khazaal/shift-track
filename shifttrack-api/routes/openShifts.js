const express = require('express');
const router  = express.Router();
const db      = require('../db/index');
const auth    = require('../middleware/auth');
const webpush = require('../utils/webpush');

function adminOnly(req, res, next){
  if(req.role !== 'admin') return res.status(403).json({ ok:false, error:'Admin access required' });
  next();
}

// Send push + log notification to a list of user IDs
async function notifyUsers(userIds, title, body){
  if(!userIds.length) return;
  const subs = await db.query('SELECT * FROM push_subscriptions WHERE user_id = ANY($1)', [userIds]);
  const payload = JSON.stringify({ title, body, icon: '/shift-track/icon-192.png' });
  const logged = new Set();
  for(const sub of subs.rows){
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
      if(!logged.has(sub.user_id)){
        logged.add(sub.user_id);
        await db.query(
          'INSERT INTO notification_log (user_id, title, body) VALUES ($1,$2,$3)',
          [sub.user_id, title, body]
        );
      }
    } catch(e){
      if(e.statusCode === 410)
        await db.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [sub.endpoint]);
      else
        console.error(`[notify] Push failed for user ${sub.user_id}: ${e.statusCode || e.message}`);
    }
  }
}

// Process a shift whose deadline has passed (assign by seniority for house, expire otherwise)
async function processIfExpired(shift){
  if(shift.status !== 'open') return shift;
  if(new Date(shift.deadline) > new Date()) return shift;

  if(shift.target_type === 'house'){
    // Assign to most senior claimer (earliest hire_date)
    const claims = await db.query(
      `SELECT c.user_id, u.hire_date, u.name, u.email
       FROM open_shift_claims c
       JOIN users u ON c.user_id = u.id
       WHERE c.open_shift_id=$1 AND c.response='claimed'
       ORDER BY u.hire_date ASC NULLS LAST, c.responded_at ASC
       LIMIT 1`,
      [shift.id]
    );
    if(claims.rows.length){
      const winner = claims.rows[0];
      const adminRes = await db.query('SELECT name FROM users WHERE id=$1', [shift.created_by]);
      const adminName = adminRes.rows[0]?.name || 'Admin';
      await db.query(
        `INSERT INTO shifts (user_id, location_id, date, start_time, end_time, notes, open_shift_id, awarded_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [winner.user_id, shift.location_id, shift.date, shift.start_time, shift.end_time, shift.notes||'', shift.id, adminName]
      );
      await db.query(
        `UPDATE open_shifts SET status='claimed', claimed_by=$1 WHERE id=$2`,
        [winner.user_id, shift.id]
      );
      const loc = await db.query('SELECT name FROM locations WHERE id=$1', [shift.location_id]);
      const locName = loc.rows[0]?.name || 'the location';
      await notifyUsers([winner.user_id], 'Shift Assigned', `You got the open shift at ${locName} on ${shift.date} (${shift.start_time.slice(0,5)}–${shift.end_time.slice(0,5)})`);
      return { ...shift, status:'claimed', claimed_by: winner.user_id };
    } else {
      await db.query(`UPDATE open_shifts SET status='expired' WHERE id=$1`, [shift.id]);
      return { ...shift, status:'expired' };
    }
  } else {
    await db.query(`UPDATE open_shifts SET status='expired' WHERE id=$1`, [shift.id]);
    return { ...shift, status:'expired' };
  }
}

// ─── ADMIN ROUTES ──────────────────────────────────────────────────

// POST /api/open-shifts/admin — create an open shift and notify targets
router.post('/admin', auth, adminOnly, async (req, res) => {
  const { location_id, date, start_time, end_time, notes, target_type, target_user_ids, deadline_hours } = req.body;
  if(!location_id || !date || !start_time || !end_time || !target_type || !deadline_hours)
    return res.status(400).json({ ok:false, error:'Missing required fields' });
  if(!['specific','house','everyone'].includes(target_type))
    return res.status(400).json({ ok:false, error:'Invalid target_type' });
  const dh = Number(deadline_hours);
  if(isNaN(dh) || dh < 0.5 || dh > 720)
    return res.status(400).json({ ok:false, error:'deadline_hours must be between 0.5 and 720' });

  const deadline = new Date(Date.now() + dh * 3600 * 1000);

  try {
    const result = await db.query(
      `INSERT INTO open_shifts (location_id, date, start_time, end_time, notes, target_type, target_user_ids, deadline, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [location_id, date, start_time, end_time, notes||'', target_type,
       target_type === 'specific' ? (target_user_ids||[]) : [], deadline, req.userId]
    );
    const shift = result.rows[0];

    // Resolve who to notify
    let notifyIds = [];
    if(target_type === 'everyone'){
      const r = await db.query(`SELECT id FROM users WHERE role='user'`);
      notifyIds = r.rows.map(u => u.id);
    } else if(target_type === 'house'){
      const r = await db.query('SELECT id FROM users WHERE location_id=$1', [location_id]);
      notifyIds = r.rows.map(u => u.id);
    } else if(target_type === 'specific'){
      notifyIds = target_user_ids || [];
    }

    const loc = await db.query('SELECT name FROM locations WHERE id=$1', [location_id]);
    const locName = loc.rows[0]?.name || 'Unknown';
    const deadlineStr = deadline.toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
    await notifyUsers(notifyIds, 'Open Shift Available',
      `${locName} · ${date} · ${start_time.slice(0,5)}–${end_time.slice(0,5)} · Respond by ${deadlineStr}`);

    res.json({ ok:true, shift });
  } catch(err){
    console.error(err);
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// GET /api/open-shifts/admin — all open shifts with claim details
router.get('/admin', auth, adminOnly, async (req, res) => {
  try {
    const shifts = await db.query(
      `SELECT os.*, l.name AS location_name, l.color AS location_color,
              cu.name AS claimed_by_name, cu.email AS claimed_by_email
       FROM open_shifts os
       JOIN locations l ON os.location_id = l.id
       LEFT JOIN users cu ON os.claimed_by = cu.id
       ORDER BY os.created_at DESC LIMIT 60`
    );

    const processed = [];
    for(const s of shifts.rows) processed.push(await processIfExpired(s));

    const shiftIds = processed.map(s => s.id);
    let claims = [];
    if(shiftIds.length){
      const cr = await db.query(
        `SELECT c.*, u.name, u.email, u.hire_date
         FROM open_shift_claims c
         JOIN users u ON c.user_id = u.id
         WHERE c.open_shift_id = ANY($1)
         ORDER BY u.hire_date ASC NULLS LAST, c.responded_at ASC`,
        [shiftIds]
      );
      claims = cr.rows;
    }

    const out = processed.map(s => ({
      ...s,
      claims: claims.filter(c => c.open_shift_id === s.id)
    }));

    res.json({ ok:true, shifts: out });
  } catch(err){
    console.error(err);
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// DELETE /api/open-shifts/admin/:id — cancel an open shift
router.delete('/admin/:id', auth, adminOnly, async (req, res) => {
  try {
    await db.query('DELETE FROM open_shifts WHERE id=$1', [req.params.id]);
    res.json({ ok:true });
  } catch(err){
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// ─── USER ROUTES ───────────────────────────────────────────────────

// GET /api/open-shifts — shifts available to the logged-in user
router.get('/', auth, async (req, res) => {
  try {
    const userRes = await db.query('SELECT location_id FROM users WHERE id=$1', [req.userId]);
    const userLocId = userRes.rows[0]?.location_id;

    const shifts = await db.query(
      `SELECT os.*, l.name AS location_name, l.color AS location_color
       FROM open_shifts os
       JOIN locations l ON os.location_id = l.id
       WHERE os.status = 'open'
       ORDER BY os.date ASC, os.start_time ASC`
    );

    const processed = [];
    for(const s of shifts.rows) processed.push(await processIfExpired(s));

    const relevant = processed.filter(s => {
      if(s.status !== 'open') return false;
      if(s.target_type === 'everyone') return true;
      if(s.target_type === 'house') return s.location_id === userLocId;
      if(s.target_type === 'specific') return (s.target_user_ids||[]).includes(req.userId);
      return false;
    });

    const shiftIds = relevant.map(s => s.id);
    let myResponses = [];
    if(shiftIds.length){
      const r = await db.query(
        'SELECT open_shift_id, response FROM open_shift_claims WHERE user_id=$1 AND open_shift_id=ANY($2)',
        [req.userId, shiftIds]
      );
      myResponses = r.rows;
    }

    const out = relevant.map(s => ({
      ...s,
      my_response: myResponses.find(r => r.open_shift_id === s.id)?.response || null
    }));

    res.json({ ok:true, shifts: out });
  } catch(err){
    console.error(err);
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// POST /api/open-shifts/:id/respond — claim or reject
router.post('/:id/respond', auth, async (req, res) => {
  const { response } = req.body;
  if(!['claimed','rejected'].includes(response))
    return res.status(400).json({ ok:false, error:'Invalid response' });

  try {
    const shiftRes = await db.query(
      `SELECT os.*, l.name AS location_name FROM open_shifts os
       JOIN locations l ON os.location_id = l.id WHERE os.id=$1`,
      [req.params.id]
    );
    if(!shiftRes.rows.length) return res.status(404).json({ ok:false, error:'Shift not found' });
    const shift = shiftRes.rows[0];

    if(shift.status !== 'open')
      return res.status(409).json({ ok:false, error:'This shift is no longer available' });
    if(new Date(shift.deadline) < new Date())
      return res.status(409).json({ ok:false, error:'The response deadline has passed' });

    // Conflict check for claims
    if(response === 'claimed'){
      const conflict = await db.query(
        `SELECT id FROM shifts WHERE user_id=$1 AND date=$2
           AND start_time < $4::time AND end_time > $3::time`,
        [req.userId, shift.date, shift.start_time, shift.end_time]
      );
      if(conflict.rows.length)
        return res.status(409).json({ ok:false, error:'You already have a shift that overlaps this time' });
    }

    // Upsert claim
    await db.query(
      `INSERT INTO open_shift_claims (open_shift_id, user_id, response)
       VALUES ($1,$2,$3)
       ON CONFLICT (open_shift_id, user_id) DO UPDATE SET response=$3, responded_at=NOW()`,
      [req.params.id, req.userId, response]
    );

    let assigned = false;

    // For specific/everyone: first claim wins immediately (atomic UPDATE prevents race condition)
    if(response === 'claimed' && shift.target_type !== 'house'){
      const claimRes = await db.query(
        `UPDATE open_shifts SET status='claimed', claimed_by=$1 WHERE id=$2 AND status='open' RETURNING id`,
        [req.userId, req.params.id]
      );
      if(!claimRes.rows.length)
        return res.status(409).json({ ok:false, error:'This shift was just claimed by someone else' });
      const adminRes = await db.query('SELECT name FROM users WHERE id=$1', [shift.created_by]);
      const adminName = adminRes.rows[0]?.name || 'Admin';
      await db.query(
        `INSERT INTO shifts (user_id, location_id, date, start_time, end_time, notes, open_shift_id, awarded_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [req.userId, shift.location_id, shift.date, shift.start_time, shift.end_time, shift.notes||'', req.params.id, adminName]
      );
      assigned = true;

      // Notify others that shift is gone
      let otherIds = [];
      if(shift.target_type === 'everyone'){
        const r = await db.query(`SELECT id FROM users WHERE role='user' AND id!=$1`, [req.userId]);
        otherIds = r.rows.map(u => u.id);
      } else {
        otherIds = (shift.target_user_ids||[]).filter(id => id !== req.userId);
      }
      if(otherIds.length){
        await notifyUsers(otherIds, 'Open Shift Taken',
          `The shift at ${shift.location_name} on ${shift.date} has been claimed.`);
      }
    }

    res.json({ ok:true, assigned, target_type: shift.target_type });
  } catch(err){
    console.error(err);
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

module.exports = router;

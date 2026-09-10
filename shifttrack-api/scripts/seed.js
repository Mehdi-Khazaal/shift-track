// Synthetic sandbox dataset.
//
// Shaped like real ShiftTrack data (houses, a two-week rotating base schedule
// with overnight shifts, overtime weeks, pulls, awarded shifts, cancelled base
// dates) but entirely invented.
//
// Dates are pinned to fixed pay periods relative to PP_ANCHOR rather than to
// "today", so asserted hours and pay totals stay stable instead of drifting
// every fortnight and rotting the test suite.
'use strict';

require('./assert-local-db'); // MUST be first: refuses non-local databases

const bcrypt = require('bcrypt');
const db = require('../db/index');

const { PP_ANCHOR, PASSWORD, ppDay } = require('./pp-dates');

const HOUSES = [
  { name: 'Orchard',          color: '#f472b6', rate: '23.00', address: '14 Orchard St' },
  { name: 'Mount Pleasant B', color: '#38bdf8', rate: '23.00', address: '88 Mt Pleasant Rd' },
  { name: 'Jackson',          color: '#84cc16', rate: '24.50', address: '5 Jackson Ave' },
  { name: 'Georgetown',       color: '#f97316', rate: '25.00', address: '210 Georgetown Pike' },
];

// position/work_type/gender mirror the values the admin UI renders as badges.
const STAFF = [
  { email: 'ayman@local.test',   name: 'Ayman Tester',   house: 'Mount Pleasant B', position: 'SRC',        work_type: 'block',   gender: 'male'   },
  { email: 'muzan@local.test',   name: 'Muzan Tester',   house: 'Jackson',          position: 'SRC',        work_type: 'regular', gender: 'male'   },
  { email: 'heather@local.test', name: 'Heather Tester', house: null,               position: 'SPECIALIST', work_type: 'regular', gender: 'female' },
  { email: 'alex@local.test',    name: 'Alex Tester',    house: 'Orchard',          position: 'SRC',        work_type: 'regular', gender: ''       },
  { email: 'nadia@local.test',   name: 'Nadia Tester',   house: 'Georgetown',       position: 'SRC',        work_type: 'regular', gender: 'female' },
  { email: 'sam@local.test',     name: 'Sam Tester',     house: 'Orchard',          position: 'SRC',        work_type: 'regular', gender: 'male'   },
];

async function waitForMigration() {
  for (let i = 0; i < 40; i++) {
    if (db.dbStatus.migrated) return;
    if (db.dbStatus.migrationError) throw new Error('migration failed: ' + db.dbStatus.migrationError);
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('timed out waiting for migrate() to finish');
}

async function seed() {
  await waitForMigration();

  // Wipe app rows but keep the schema migrate() just built. TRUNCATE ... CASCADE
  // resets every dependent table in one statement.
  await db.query('TRUNCATE users, locations, leave_types RESTART IDENTITY CASCADE');

  // migrate() seeds leave_types, but TRUNCATE above cleared them; put them back.
  await db.query(`
    INSERT INTO leave_types (name, label, color) VALUES
      ('sick_time','Sick Time','#2dd4bf'),
      ('pto','PTO','#a855f7'),
      ('call_off','Call Off','#fb5264')
  `);

  const hash = await bcrypt.hash(PASSWORD, 10);
  const loc = {};
  for (const h of HOUSES) {
    const r = await db.query(
      `INSERT INTO locations (name,color,rate,address) VALUES ($1,$2,$3,$4) RETURNING id`,
      [h.name, h.color, h.rate, h.address]
    );
    loc[h.name] = r.rows[0].id;
  }

  async function addUser({ email, name, role, position, house, work_type, gender }) {
    const r = await db.query(
      `INSERT INTO users (email,name,password_hash,role,position,location_id,hire_date,work_type,gender)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [email, name, hash, role, position || '', house ? loc[house] : null,
       '2023-01-08', work_type || 'regular', gender || '']
    );
    const id = r.rows[0].id;
    await db.query(
      'INSERT INTO user_settings (user_id, ot_threshold, pp_anchor) VALUES ($1,40,$2)',
      [id, PP_ANCHOR]
    );
    return id;
  }

  const adminId = await addUser({
    email: 'admin@local.test', name: 'Admin Tester', role: 'admin',
    position: 'SRC', house: 'Orchard', work_type: 'regular', gender: 'male',
  });

  const users = { 'admin@local.test': adminId };
  for (const s of STAFF) {
    users[s.email] = await addUser({ ...s, role: s.position === 'SPECIALIST' ? 'specialist' : 'user' });
  }

  const ayman = users['ayman@local.test'];
  const muzan = users['muzan@local.test'];
  const alex  = users['alex@local.test'];

  // ── Base schedule: Ayman works overnights at Mount Pleasant B.
  // Overnight (22:00-08:00) is the case most likely to break hour/pay math.
  const mpb = loc['Mount Pleasant B'];
  for (const [week, day] of [[1,1],[1,2],[1,3],[1,6],[2,0],[2,2],[2,3],[2,4]]) {
    await db.query(
      `INSERT INTO base_schedule (user_id,location_id,week,day_of_week,start_time,end_time)
       VALUES ($1,$2,$3,$4,'22:00','08:00')`,
      [ayman, mpb, week, day]
    );
  }
  // Muzan works regular days at Jackson.
  for (const [week, day] of [[1,1],[1,2],[1,3],[1,4],[2,1],[2,2],[2,3]]) {
    await db.query(
      `INSERT INTO base_schedule (user_id,location_id,week,day_of_week,start_time,end_time)
       VALUES ($1,$2,$3,$4,'08:00','16:00')`,
      [muzan, loc['Jackson'], week, day]
    );
  }

  // ── Logged shifts, all inside pay period 1 (2026-04-05 .. 2026-04-18).
  // Alex gets six 8h day shifts in week 1 => 48h, i.e. an overtime week. (The
  // OT total itself is computed client-side, so it is exercised in the browser,
  // not by the API suite.)
  for (let d = 0; d < 6; d++) {
    await db.query(
      `INSERT INTO shifts (user_id,location_id,date,start_time,end_time,notes)
       VALUES ($1,$2,$3,'08:00','16:00','seeded')`,
      [alex, loc['Orchard'], ppDay(1, d)]
    );
  }

  // A plain single shift, safe for the delete tests to remove.
  await db.query(
    `INSERT INTO shifts (user_id,location_id,date,start_time,end_time,notes)
     VALUES ($1,$2,$3,'08:00','16:00','plain seeded shift')`,
    [muzan, loc['Jackson'], ppDay(1, 8)]
  );

  // A pulled shift: admin delete must REFUSE this one (409).
  await db.query(
    `INSERT INTO shifts (user_id,location_id,date,start_time,end_time,is_pulled,pulled_from_location_id,pull_bonus)
     VALUES ($1,$2,$3,'14:00','22:00',TRUE,$4,50)`,
    [muzan, loc['Georgetown'], ppDay(1, 9), loc['Jackson']]
  );

  // An awarded open shift: admin delete must ALLOW this one.
  // shifts.open_shift_id carries a real FK, so the open_shifts row must exist.
  const awardDate = ppDay(1, 10);
  const openShift = await db.query(
    `INSERT INTO open_shifts (location_id,date,start_time,end_time,target_type,deadline,status,claimed_by,created_by)
     VALUES ($1,$2,'08:00','16:00','everyone',$3,'claimed',$4,$5) RETURNING id`,
    [loc['Georgetown'], awardDate, awardDate + 'T00:00:00Z', alex, adminId]
  );
  await db.query(
    `INSERT INTO shifts (user_id,location_id,date,start_time,end_time,open_shift_id,awarded_by_name)
     VALUES ($1,$2,$3,'08:00','16:00',$4,'Admin Tester')`,
    [alex, loc['Georgetown'], awardDate, openShift.rows[0].id]
  );

  // One cancelled base occurrence for Ayman, exercising base_suppressed_dates.
  await db.query(
    'INSERT INTO base_suppressed_dates (user_id,date) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [ayman, ppDay(1, 2)]
  );

  // ── Leave balances for everyone.
  const types = await db.query('SELECT id, name FROM leave_types');
  for (const uid of Object.values(users)) {
    for (const t of types.rows) {
      if (t.name === 'call_off') continue;
      await db.query(
        `INSERT INTO leave_balances (user_id,leave_type_id,accrued_hours,used_hours,anniversary_year_start)
         VALUES ($1,$2,$3,0,'2026-01-01') ON CONFLICT DO NOTHING`,
        [uid, t.id, t.name === 'pto' ? '37.90' : '40.00']
      );
    }
  }

  const counts = {};
  for (const t of ['users', 'locations', 'shifts', 'base_schedule', 'leave_balances']) {
    counts[t] = (await db.query(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n;
  }

  console.log('\n  Seeded local sandbox');
  console.log('  ' + JSON.stringify(counts));
  console.log('\n  Log in with:');
  console.log(`    admin      admin@local.test / ${PASSWORD}`);
  console.log(`    employee   ayman@local.test / ${PASSWORD}`);
  console.log('');
}

// Exported so tests can reseed between suites without shelling out.
module.exports = { seed, PP_ANCHOR, PASSWORD, ppDay };

if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch(err => { console.error('\n  Seed failed:', err.message, '\n'); process.exit(1); });
}

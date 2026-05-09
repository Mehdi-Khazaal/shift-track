const { Pool, types } = require('pg');
require('dotenv').config();

// Return DATE columns as plain "YYYY-MM-DD" strings instead of JS Date objects.
// The pg library delegates DATE (OID 1082) to postgres-date which returns Date
// objects; String(dateObj).slice(0,10) then yields "Thu Apr 09" - invalid for
// any subsequent SQL DATE parameter.
types.setTypeParser(1082, val => val);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required for Neon
});

async function addConstraintIfMissing(name, sql) {
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = '${name}'
      ) THEN
        ${sql};
      END IF;
    END $$;
  `);
}

// Run migrations on startup - safe to run repeatedly.
async function migrate() {
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

    // Core tables. Keep locations before users because users.location_id
    // references locations; locations.created_by is added afterward.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS locations (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name       TEXT NOT NULL,
        color      TEXT NOT NULL DEFAULT '#5b8fff',
        rate       NUMERIC(10,2) NOT NULL,
        address    TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email         TEXT UNIQUE NOT NULL,
        name          TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'user',
        position      TEXT NOT NULL DEFAULT '',
        location_id   UUID REFERENCES locations(id) ON DELETE SET NULL,
        hire_date     DATE,
        is_active     BOOLEAN NOT NULL DEFAULT TRUE,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS created_by UUID`);
    await addConstraintIfMissing(
      'locations_created_by_fkey',
      'ALTER TABLE locations ADD CONSTRAINT locations_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL'
    );

    await pool.query(`
      CREATE TABLE IF NOT EXISTS shifts (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        date        DATE NOT NULL,
        start_time  TIME NOT NULL,
        end_time    TIME NOT NULL,
        notes       TEXT DEFAULT '',
        admin_notes TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS base_schedule (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        week        INTEGER NOT NULL CHECK (week IN (1, 2)),
        day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
        start_time  TIME NOT NULL,
        end_time    TIME NOT NULL
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        ot_threshold  NUMERIC(5,2) DEFAULT 40,
        pp_anchor     DATE DEFAULT '2026-03-22'
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_unavailability (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        start_date DATE NOT NULL,
        end_date   DATE NOT NULL,
        start_time TIME,
        end_time   TIME,
        note       TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Existing deployments may have older core tables.
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS position TEXT NOT NULL DEFAULT ''`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS location_id UUID`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS hire_date DATE`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`);
    await pool.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS address TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS admin_notes TEXT DEFAULT ''`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS regions (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name           TEXT NOT NULL UNIQUE,
        office_address TEXT DEFAULT '',
        created_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES regions(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS specialist_id UUID REFERENCES users(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS consumer_count INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT ''`);

    // Open shifts system.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS open_shifts (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        location_id     UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        date            DATE NOT NULL,
        start_time      TIME NOT NULL,
        end_time        TIME NOT NULL,
        notes           TEXT DEFAULT '',
        target_type     TEXT NOT NULL CHECK (target_type IN ('specific','house','everyone')),
        target_user_ids UUID[] DEFAULT '{}',
        deadline        TIMESTAMPTZ NOT NULL,
        status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','expired')),
        claimed_by      UUID REFERENCES users(id) ON DELETE SET NULL,
        created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS open_shift_claims (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        open_shift_id   UUID NOT NULL REFERENCES open_shifts(id) ON DELETE CASCADE,
        user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        response        TEXT NOT NULL CHECK (response IN ('claimed','rejected')),
        responded_at    TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(open_shift_id, user_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint        TEXT NOT NULL,
        p256dh          TEXT NOT NULL,
        auth            TEXT NOT NULL,
        notify_minutes  INTEGER DEFAULT 60,
        tz_offset       INTEGER DEFAULT 0,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, endpoint)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS notification_log (
        id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title   TEXT NOT NULL,
        body    TEXT NOT NULL,
        sent_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS open_shift_id UUID`);
    await addConstraintIfMissing(
      'shifts_open_shift_id_fkey',
      'ALTER TABLE shifts ADD CONSTRAINT shifts_open_shift_id_fkey FOREIGN KEY (open_shift_id) REFERENCES open_shifts(id) ON DELETE SET NULL'
    );
    await pool.query(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS awarded_by_name TEXT DEFAULT ''`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS shift_swaps (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        initiator_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        initiator_shift_id    UUID REFERENCES shifts(id) ON DELETE SET NULL,
        initiator_date        DATE NOT NULL,
        initiator_location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        initiator_start       TIME NOT NULL,
        initiator_end         TIME NOT NULL,
        target_shift_id       UUID REFERENCES shifts(id) ON DELETE SET NULL,
        target_date           DATE NOT NULL,
        target_location_id    UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        target_start          TIME NOT NULL,
        target_end            TIME NOT NULL,
        initiator_is_base     BOOLEAN NOT NULL DEFAULT FALSE,
        target_is_base        BOOLEAN NOT NULL DEFAULT FALSE,
        status                TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','accepted','rejected','cancelled')),
        responded_at          TIMESTAMPTZ,
        created_at            TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`ALTER TABLE shift_swaps ADD COLUMN IF NOT EXISTS initiator_is_base BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE shift_swaps ADD COLUMN IF NOT EXISTS target_is_base BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE shift_swaps ADD COLUMN IF NOT EXISTS swapped_initiator_shift_id UUID REFERENCES shifts(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE shift_swaps ADD COLUMN IF NOT EXISTS swapped_target_shift_id UUID REFERENCES shifts(id) ON DELETE SET NULL`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS base_suppressed_dates (
        id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        date    DATE NOT NULL,
        UNIQUE(user_id, date)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS leave_types (
        id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name  TEXT NOT NULL,
        label TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#5b8fff'
      )
    `);
    await addConstraintIfMissing('leave_types_name_key', 'ALTER TABLE leave_types ADD CONSTRAINT leave_types_name_key UNIQUE (name)');
    await pool.query(`
      INSERT INTO leave_types (name, label, color) VALUES
        ('pto',       'PTO',       '#a78bfa'),
        ('sick_time', 'Sick Time', '#2ecc8a'),
        ('call_off',  'Call Off',  '#ff5f6d')
      ON CONFLICT DO NOTHING
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS leave_balances (
        id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        leave_type_id          UUID NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
        accrued_hours          NUMERIC(8,2) NOT NULL DEFAULT 0,
        used_hours             NUMERIC(8,2) NOT NULL DEFAULT 0,
        carried_over_hours     NUMERIC(8,2) NOT NULL DEFAULT 0,
        anniversary_year_start DATE NOT NULL,
        UNIQUE(user_id, leave_type_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS leave_requests (
        id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        leave_type_id      UUID NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
        date               DATE NOT NULL,
        hours_requested    NUMERIC(5,2) NOT NULL,
        status             TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','approved','denied','cancelled')),
        denial_reason      TEXT DEFAULT '',
        notes              TEXT DEFAULT '',
        submitted_by       UUID REFERENCES users(id) ON DELETE SET NULL,
        reviewed_by        UUID REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at        TIMESTAMPTZ,
        sick_hours_applied NUMERIC(5,2) NOT NULL DEFAULT 0,
        start_time         TIME,
        end_time           TIME,
        created_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS start_time TIME`);
    await pool.query(`ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS end_time TIME`);
    await pool.query(`ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS sick_hours_applied NUMERIC(5,2) NOT NULL DEFAULT 0`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sick_time_payouts (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        hours_paid   NUMERIC(8,2) NOT NULL,
        hourly_rate  NUMERIC(10,2) NOT NULL,
        total_amount NUMERIC(10,2) NOT NULL,
        paid_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Backfill UNIQUE constraint on leave_balances (best-effort — skip if duplicates prevent it)
    try {
      await addConstraintIfMissing(
        'leave_balances_user_id_leave_type_id_key',
        'ALTER TABLE leave_balances ADD CONSTRAINT leave_balances_user_id_leave_type_id_key UNIQUE (user_id, leave_type_id)'
      );
    } catch (e) {
      console.warn('[migrate] leave_balances UNIQUE constraint skipped:', e.message);
    }

    // -- Indexes on hot query paths -----------------------------------------------
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_shifts_user_id      ON shifts(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_shifts_user_date     ON shifts(user_id, date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_base_schedule_user   ON base_schedule(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_push_subs_user       ON push_subscriptions(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_leave_req_user       ON leave_requests(user_id, status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_osc_shift            ON open_shift_claims(open_shift_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notif_log_user       ON notification_log(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_suppressed_user      ON base_suppressed_dates(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_open_shifts_status   ON open_shifts(status, deadline)`);

    console.log('OK  Migrations applied');
    dbStatus.migrated = true;
  } catch (err) {
    console.error('ERROR  Migration failed:', err.message);
    dbStatus.migrationError = err.message;
  }
}

// Exposed so /health can report real migration state.
const dbStatus = { connected: false, migrated: false, migrationError: null };

// Test the connection on startup then run migrations.
pool.connect((err, client, release) => {
  if (err) {
    console.error('ERROR  Database connection failed:', err.message);
  } else {
    console.log('OK  Database connected (Neon PostgreSQL)');
    dbStatus.connected = true;
    release();
    migrate();
  }
});

module.exports = pool;
module.exports.dbStatus = dbStatus;

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required for Neon
});

// Run migrations on startup — safe to run repeatedly (all are idempotent)
async function migrate(){
  try {
    // Hire date for seniority tracking
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS hire_date DATE`);

    // Open shifts system
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

    // Push notification subscriptions
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

    // Notification history log
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notification_log (
        id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title   TEXT NOT NULL,
        body    TEXT NOT NULL,
        sent_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Claimed open shift tracking on shifts
    await pool.query(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS admin_notes TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS open_shift_id UUID REFERENCES open_shifts(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS awarded_by_name TEXT DEFAULT ''`);

    // Shift swap system
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

    // Ensure shift_swaps has the is_base columns (added after initial release)
    await pool.query(`ALTER TABLE shift_swaps ADD COLUMN IF NOT EXISTS initiator_is_base BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE shift_swaps ADD COLUMN IF NOT EXISTS target_is_base BOOLEAN NOT NULL DEFAULT FALSE`);

    // Base schedule suppression (used when a swapped base-schedule shift is overridden)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS base_suppressed_dates (
        id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        date    DATE NOT NULL,
        UNIQUE(user_id, date)
      )
    `);

    console.log('✅  Migrations applied');
  } catch(err){
    console.error('❌  Migration failed:', err.message);
  }
}

// Test the connection on startup then run migrations
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌  Database connection failed:', err.message);
  } else {
    console.log('✅  Database connected (Neon PostgreSQL)');
    release();
    migrate();
  }
});

module.exports = pool;
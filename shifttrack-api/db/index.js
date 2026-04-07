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
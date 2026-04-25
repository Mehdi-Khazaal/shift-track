CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Locations are created before users because users.location_id references them.
-- The reverse locations.created_by reference is added after users exists.
CREATE TABLE IF NOT EXISTS locations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#5b8fff',
  rate       NUMERIC(10,2) NOT NULL,
  address    TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

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
);

ALTER TABLE locations ADD COLUMN IF NOT EXISTS created_by UUID;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'locations_created_by_fkey'
  ) THEN
    ALTER TABLE locations
      ADD CONSTRAINT locations_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS shifts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id     UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  date            DATE NOT NULL,
  start_time      TIME NOT NULL,
  end_time        TIME NOT NULL,
  notes           TEXT DEFAULT '',
  admin_notes     TEXT DEFAULT '',
  open_shift_id   UUID,
  awarded_by_name TEXT DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS base_schedule (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  week        INTEGER NOT NULL CHECK (week IN (1, 2)),
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ot_threshold  NUMERIC(5,2) DEFAULT 40,
  pp_anchor     DATE DEFAULT '2026-03-22'
);

CREATE TABLE IF NOT EXISTS user_unavailability (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date   DATE NOT NULL,
  start_time TIME,
  end_time   TIME,
  note       TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

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
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shifts_open_shift_id_fkey'
  ) THEN
    ALTER TABLE shifts
      ADD CONSTRAINT shifts_open_shift_id_fkey
      FOREIGN KEY (open_shift_id) REFERENCES open_shifts(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS open_shift_claims (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  open_shift_id   UUID NOT NULL REFERENCES open_shifts(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  response        TEXT NOT NULL CHECK (response IN ('claimed','rejected')),
  responded_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(open_shift_id, user_id)
);

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
);

CREATE TABLE IF NOT EXISTS notification_log (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title   TEXT NOT NULL,
  body    TEXT NOT NULL,
  sent_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shift_swaps (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  initiator_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  initiator_shift_id         UUID REFERENCES shifts(id) ON DELETE SET NULL,
  initiator_date             DATE NOT NULL,
  initiator_location_id      UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  initiator_start            TIME NOT NULL,
  initiator_end              TIME NOT NULL,
  target_shift_id            UUID REFERENCES shifts(id) ON DELETE SET NULL,
  target_date                DATE NOT NULL,
  target_location_id         UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  target_start               TIME NOT NULL,
  target_end                 TIME NOT NULL,
  initiator_is_base          BOOLEAN NOT NULL DEFAULT FALSE,
  target_is_base             BOOLEAN NOT NULL DEFAULT FALSE,
  swapped_initiator_shift_id UUID REFERENCES shifts(id) ON DELETE SET NULL,
  swapped_target_shift_id    UUID REFERENCES shifts(id) ON DELETE SET NULL,
  status                     TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','accepted','rejected','cancelled')),
  responded_at               TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS base_suppressed_dates (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date    DATE NOT NULL,
  UNIQUE(user_id, date)
);

CREATE TABLE IF NOT EXISTS leave_types (
  id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name  TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#5b8fff'
);

INSERT INTO leave_types (name, label, color) VALUES
  ('pto',       'PTO',       '#a78bfa'),
  ('sick_time', 'Sick Time', '#2ecc8a'),
  ('call_off',  'Call Off',  '#ff5f6d')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS leave_balances (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type_id          UUID NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
  accrued_hours          NUMERIC(8,2) NOT NULL DEFAULT 0,
  used_hours             NUMERIC(8,2) NOT NULL DEFAULT 0,
  carried_over_hours     NUMERIC(8,2) NOT NULL DEFAULT 0,
  anniversary_year_start DATE NOT NULL,
  UNIQUE(user_id, leave_type_id)
);

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
);

CREATE TABLE IF NOT EXISTS sick_time_payouts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hours_paid   NUMERIC(8,2) NOT NULL,
  hourly_rate  NUMERIC(10,2) NOT NULL,
  total_amount NUMERIC(10,2) NOT NULL,
  paid_at      TIMESTAMPTZ DEFAULT NOW()
);

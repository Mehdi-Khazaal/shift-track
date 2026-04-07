-- Users table
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user', -- 'user' or 'admin'
  position      TEXT NOT NULL DEFAULT '',     -- e.g. SRC, DSP, PRN
  location_id   UUID REFERENCES locations(id) ON DELETE SET NULL,
  hire_date     DATE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Locations table (houses with pay rates)
CREATE TABLE IF NOT EXISTS locations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#5b8fff',
  rate       NUMERIC(10,2) NOT NULL,
  address    TEXT DEFAULT '',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Shifts table (logged shifts)
CREATE TABLE IF NOT EXISTS shifts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL,
  notes       TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Base schedule table (repeating 2-week schedule)
CREATE TABLE IF NOT EXISTS base_schedule (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  week        INTEGER NOT NULL CHECK (week IN (1, 2)),
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL
);

-- Settings table (per-user settings like OT threshold and pay period anchor)
CREATE TABLE IF NOT EXISTS user_settings (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ot_threshold  NUMERIC(5,2) DEFAULT 40,
  pp_anchor     DATE DEFAULT '2026-03-22'
);

-- Unavailability table (days/times a user marks themselves unavailable)
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

-- Open shifts (admin posts, employees claim)
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

-- Claims / responses to open shifts
CREATE TABLE IF NOT EXISTS open_shift_claims (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  open_shift_id   UUID NOT NULL REFERENCES open_shifts(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  response        TEXT NOT NULL CHECK (response IN ('claimed','rejected')),
  responded_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(open_shift_id, user_id)
);

-- Notification log (in-app history of all push notifications sent)
CREATE TABLE IF NOT EXISTS notification_log (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title    TEXT NOT NULL,
  body     TEXT NOT NULL,
  sent_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS users (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  username      text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'telecaller',
  status        text NOT NULL DEFAULT 'Active',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users (lower(username));

CREATE TABLE IF NOT EXISTS devices (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   text NOT NULL,
  device_name text NOT NULL DEFAULT 'Android phone',
  platform    text NOT NULL DEFAULT 'android',
  token       text NOT NULL UNIQUE,
  status      text NOT NULL DEFAULT 'Offline',
  last_seen   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS devices_user_key ON devices (user_id);

CREATE TABLE IF NOT EXISTS calls (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone_number text NOT NULL,
  status       text NOT NULL DEFAULT 'Queued',
  started_at   timestamptz,
  offhook_at   timestamptz,
  answered_at  timestamptz,
  ended_at     timestamptz,
  duration     integer NOT NULL DEFAULT 0,
  duration_estimated boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calls_user_created ON calls (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pairings (
  code       text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS commands (
  id           text PRIMARY KEY,
  device_token text NOT NULL,
  type         text NOT NULL,
  call_id      text NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  number       text NOT NULL,
  delivered_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commands_pending ON commands (device_token, delivered_at);

ALTER TABLE calls ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE calls ADD COLUMN IF NOT EXISTS offhook_at timestamptz;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS duration_estimated boolean NOT NULL DEFAULT false;

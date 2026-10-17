-- S2 Ground – D1 schema. Apply with the "migrate" option of the deploy workflow
-- (or: npx wrangler d1 execute s2ground --remote --file=worker/schema.sql). Idempotent.
CREATE TABLE IF NOT EXISTS users (
  name        TEXT PRIMARY KEY,            -- login name, lower case
  full_name   TEXT,
  role        TEXT NOT NULL,               -- master | ground | command | observer | guest
  pw_hash     TEXT NOT NULL,               -- pbkdf2$<iterations>$<salt b64>$<hash b64>
  active      INTEGER NOT NULL DEFAULT 1,
  lang        TEXT,
  created_at  INTEGER NOT NULL,
  last_login  INTEGER
);
CREATE TABLE IF NOT EXISTS tokens (
  token       TEXT PRIMARY KEY,
  user        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user);
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,            -- 'app' holds the JSON settings blob
  value       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  t           INTEGER NOT NULL,            -- ms since epoch (UTC)
  user        TEXT NOT NULL,
  action      TEXT NOT NULL,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS log_t ON activity_log(t);
CREATE TABLE IF NOT EXISTS ascents (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  owner       TEXT NOT NULL,
  follow_code TEXT NOT NULL,               -- guest join code for s2stueve ("7K2-M4Q")
  created_at  INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  meta        TEXT                         -- JSON: start, plannedLaunch
);
CREATE INDEX IF NOT EXISTS ascents_code ON ascents(follow_code);

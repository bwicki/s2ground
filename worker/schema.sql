-- S2 Ground – D1 schema. Apply with the "migrate" option of the deploy workflow
-- (or: npx wrangler d1 execute s2ground --remote --file=worker/schema.sql). Idempotent.
--
-- Access model (Oct 2026): two kinds of people only.
--   * Ground users  – login name + password; one or more carry the flag `master` (Superuser).
--   * Observers     – no password; each has a permanent 8-character code (table observers),
--                     revocable by the master; every join is recorded in observer_logins.
-- Nothing was deployed before this schema, so there is no migration path from the old
-- role-based users table – start with a fresh database (README, "Datenbank").
CREATE TABLE IF NOT EXISTS users (
  name        TEXT PRIMARY KEY,            -- login name, lower case
  full_name   TEXT,
  pw_hash     TEXT NOT NULL,               -- pbkdf2$<iterations>$<salt b64>$<hash b64>
  master      INTEGER NOT NULL DEFAULT 0,  -- 1 = Masteruser (Superuser); the first created user is master
  active      INTEGER NOT NULL DEFAULT 1,
  lang        TEXT,
  created_at  INTEGER NOT NULL,
  last_login  INTEGER
);
CREATE TABLE IF NOT EXISTS tokens (
  token       TEXT PRIMARY KEY,
  user        TEXT NOT NULL,               -- login name, or 'obs:<observer id>' for observer tokens
  observer_id INTEGER,                     -- set for observer tokens (no users row)
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
  created_at  INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  meta        TEXT                         -- JSON: start, plannedLaunch, cutAltAgl, frequencyHz, sondeId
);
-- Observers: one row per access code. Codes are low-sensitivity viewing codes (no hardware
-- action is possible with them), so they are stored in plain text and shown again in the admin page.
CREATE TABLE IF NOT EXISTS observers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,      -- 8 chars, alphabet without 0/O/1/I, e.g. 7K2M4QX9
  label         TEXT NOT NULL,             -- the master's label ("Command Center", "Crew Bergung")
  display_name  TEXT,                      -- Klarname chosen by the observer at the last join
  mobile        TEXT NOT NULL DEFAULT '',  -- E.164 (+41791234567) or ''
  whatsapp      INTEGER NOT NULL DEFAULT 0,-- 1 = notify this observer by WhatsApp about new ascents
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER,                   -- NULL = active
  last_login_at INTEGER,
  login_count   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS observer_logins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  observer_id   INTEGER NOT NULL,
  at            INTEGER NOT NULL,
  ip            TEXT,
  user_agent    TEXT,
  display_name  TEXT,
  ascent_id     TEXT                       -- the active ascent at login time (NULL if none)
);
CREATE INDEX IF NOT EXISTS observer_logins_obs ON observer_logins(observer_id, at);

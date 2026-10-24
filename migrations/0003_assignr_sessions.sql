-- Signed-in Assignr users. The row key is a SHA-256 of the session cookie's
-- value, so the table alone can't be used to impersonate anyone.
CREATE TABLE assignr_sessions (
  id_hash          TEXT PRIMARY KEY,
  created          TEXT NOT NULL,
  last_used        TEXT NOT NULL,
  access_token     TEXT NOT NULL,
  refresh_token    TEXT,
  expires_at       INTEGER NOT NULL,  -- ms since epoch
  account_name     TEXT,
  games_json       TEXT,              -- cached, normalized games (names/positions only)
  games_fetched_at INTEGER
);
CREATE INDEX assignr_sessions_last_used ON assignr_sessions (last_used);

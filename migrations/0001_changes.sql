-- Change tracking: the last-seen version of every match, and a log of changes.

CREATE TABLE matches (
  match_id     INTEGER PRIMARY KEY,
  data         TEXT NOT NULL,       -- normalized event JSON as last seen
  first_seen   TEXT,                -- null for matches present when tracking began
  last_changed TEXT,
  removed_at   TEXT,                -- set while the match is missing from the schedule
  rev          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE changes (
  id       TEXT PRIMARY KEY,        -- "<matchId>.<rev>.<field|kind>", deterministic for dedupe
  at       TEXT NOT NULL,
  match_id INTEGER NOT NULL,
  kind     TEXT NOT NULL,           -- added | changed | removed | restored
  field    TEXT,                    -- when | where | home | away | type | status | notes
  old      TEXT,
  new      TEXT
);
CREATE INDEX changes_at ON changes (at);
CREATE INDEX changes_match ON changes (match_id);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- "Mark done" for schedule changes, shared by everyone connected to the same
-- Assignr site (scope = 'site:<id>', or 'account:<id>' without site access).
ALTER TABLE assignr_sessions ADD COLUMN scope TEXT;
ALTER TABLE assignr_sessions ADD COLUMN account_id TEXT;

CREATE TABLE assignr_done (
  scope      TEXT NOT NULL,
  change_key TEXT NOT NULL,  -- id of the latest change it covers; a newer change re-opens it
  done_at    TEXT NOT NULL,
  done_by    TEXT,
  PRIMARY KEY (scope, change_key)
);

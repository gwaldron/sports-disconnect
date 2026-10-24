-- When the schedule was last checked before each change was noticed. The
-- league's edit happened between prev_checked and at.
ALTER TABLE changes ADD COLUMN prev_checked TEXT;

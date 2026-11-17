-- The daily "right now" snapshot of each known comet (comet-plan/fact-table.md, decision D4): the Worker's cron
-- (worker/src/now.js) asks JPL Horizons for the day's values once a day and writes them here with their date; pages
-- read only this table and say "as of" that date. A failed fetch leaves the last good row (and its date) as it was.
CREATE TABLE IF NOT EXISTS comet_now (
  id TEXT PRIMARY KEY REFERENCES comets(id),
  as_of TEXT,          -- the UTC day (YYYY-MM-DD) the values are for; NULL until the first fetch succeeds
  soln TEXT,           -- JPL's orbit solution the values come from (JPL#34); pages combine it with detail.facts only when equal
  now TEXT,            -- JSON: T, T30 (magnitude today and in 30 days), r, rdot, delta, deldot, elong, side, cnst, ra, dec, x, y, z, vx, vy, vz
  tried_at INTEGER,    -- unix ms of the last attempt, good or not
  error TEXT           -- why the last attempt failed (NULL after a success)
);

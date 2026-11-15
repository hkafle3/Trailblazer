-- Candidates: a moving dot someone reported from a time-lapse ("Discuss this", POST /api/candidates). Each is a comets
-- row (kind 'comet', real 1, ids C-0175 and up) so the comments, tallies, Forums and Explore markers already work.
-- These columns are NULL for every other row. detail holds {"candidate": {"visit": {...}}} with the whole visit.
ALTER TABLE comets ADD COLUMN det TEXT;          -- detector it was seen on, D1..D6
ALTER TABLE comets ADD COLUMN visit TEXT;        -- the visit's first day, YYYY-MM-DD: one dot in one visit is one candidate
ALTER TABLE comets ADD COLUMN author TEXT;       -- who reported it
ALTER TABLE comets ADD COLUMN created_at INTEGER;   -- unix ms
CREATE INDEX comets_by_visit ON comets (visit, dec);

-- "It's <name>": a dot someone matched to a known object SkyBoT predicted there. No candidate, no page, no marker.
CREATE TABLE sightings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,                 -- SkyBoT's name, e.g. '2001 FM127', 'C/2025 R2'
  ra         REAL NOT NULL,
  dec        REAL NOT NULL,
  det        TEXT NOT NULL,
  visit      TEXT NOT NULL,                 -- the visit's first day, YYYY-MM-DD
  author     TEXT NOT NULL,
  created_at INTEGER NOT NULL               -- unix ms
);

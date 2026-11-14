-- Comets on the map: ones people found (kind 'comet') and known objects (kind 'known').
-- detail is JSON for the comet page: photos, measurements, spectrum (see bake/comet_3iatlas.py).
CREATE TABLE comets (
  id       TEXT PRIMARY KEY,                -- 'C-0147', '3I/ATLAS'
  kind     TEXT NOT NULL CHECK (kind IN ('comet', 'known')),
  ra       REAL NOT NULL,                   -- degrees
  dec      REAL NOT NULL,
  day      INTEGER,                         -- days since 2025-04-24 (coverage start) when first seen
  tail     REAL,                            -- marker tail angle, degrees (cosmetic)
  real     INTEGER NOT NULL DEFAULT 0,      -- 1 = real object and real data, 0 = example
  detail   TEXT                             -- JSON, may be NULL
);

-- Comments on a comet (and later on one dot of it). A tag makes the comment a vote; a person's latest tag counts.
CREATE TABLE comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  comet_id   TEXT NOT NULL REFERENCES comets(id),
  dot_id     TEXT,                          -- which moving dot, once dots are stored
  author     TEXT NOT NULL,                 -- nickname for now
  tag        TEXT CHECK (tag IN ('comet', 'asteroid', 'glitch', 'unsure')),
  body       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL               -- unix ms
);
CREATE INDEX comments_by_comet ON comments (comet_id, created_at);

-- "star": a time-lapse vote that the moving dot is a star (a fixed source), stored as its own tag instead of 'unsure'.
-- SQLite cannot change a CHECK in place, so the comments table is rebuilt with the wider CHECK. Every row and id carries over.
CREATE TABLE comments_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  comet_id   TEXT NOT NULL REFERENCES comets(id),
  dot_id     TEXT,
  author     TEXT NOT NULL,
  tag        TEXT CHECK (tag IN ('comet', 'asteroid', 'glitch', 'unsure', 'star')),
  body       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
INSERT INTO comments_new (id, comet_id, dot_id, author, tag, body, created_at)
  SELECT id, comet_id, dot_id, author, tag, body, created_at FROM comments;
DROP TABLE comments;
ALTER TABLE comments_new RENAME TO comments;
CREATE INDEX comments_by_comet ON comments (comet_id, created_at);

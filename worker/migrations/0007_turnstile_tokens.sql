-- Turnstile tokens already used for a comment (SHA-256, hex), so a token cannot post twice.
-- Claimed in the same D1 batch (one transaction) as the comment it paid for.
CREATE TABLE turnstile_tokens (
  hash       TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL               -- unix ms; rows older than a few minutes can be pruned (tokens expire after 300 s)
);

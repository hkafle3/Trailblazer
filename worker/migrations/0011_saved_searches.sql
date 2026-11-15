-- The last complete answer to each outside search (IRSA images, Gaia stars, SkyBoT), served when that service is down.
-- key is the request path and its sorted parameters; body is the JSON answer as sent.
CREATE TABLE searches (key TEXT PRIMARY KEY, body TEXT NOT NULL, saved_at INTEGER NOT NULL);

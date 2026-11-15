-- The last complete answer to each outside search (IRSA images, Gaia stars, SkyBoT), served when that service is down.
-- key is the request path and the parameters it reads. A long answer is split over parts 0, 1, ... (D1 rows stop at 2 MB).
CREATE TABLE searches (key TEXT NOT NULL, part INTEGER NOT NULL, body TEXT NOT NULL, saved_at INTEGER NOT NULL, PRIMARY KEY (key, part));

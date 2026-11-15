-- The last complete answer to each outside search (IRSA images, Gaia stars, SkyBoT), served when that service is down.
-- key is the request path and the parameters it reads. A long answer is split over parts 0, 1, ... (D1 rows stop at 2 MB).
CREATE TABLE searches (key TEXT NOT NULL, part INTEGER NOT NULL, body TEXT NOT NULL, saved_at INTEGER NOT NULL, PRIMARY KEY (key, part));
-- Bytes kept, updated by the triggers below. The CHECK caps saved answers at 100 MB of the free plan's 500 MB, leaving the
-- rest for comments and checks: an insert past it fails, and the save's transaction keeps the old answer.
CREATE TABLE saved_bytes (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL CHECK (n <= 100000000));
INSERT INTO saved_bytes VALUES (1, 0);
CREATE TRIGGER searches_add AFTER INSERT ON searches BEGIN UPDATE saved_bytes SET n = n + length(CAST(NEW.body AS BLOB)) WHERE id = 1; END;
CREATE TRIGGER searches_drop AFTER DELETE ON searches BEGIN UPDATE saved_bytes SET n = n - length(CAST(OLD.body AS BLOB)) WHERE id = 1; END;

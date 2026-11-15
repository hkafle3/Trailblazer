-- Remove the five made-up example comets (C-0147, C-0152, C-0161, C-0170, C-0174, seeded with real = 0 by 0002_seed.sql)
-- and the invented comments on them. comments is the only table that references comets(id) (0001); sightings (0013),
-- checks, searches and turnstile_tokens do not. Comments go first so no comment points at a missing comet.
DELETE FROM comments WHERE comet_id IN (SELECT id FROM comets WHERE real = 0);
DELETE FROM comets WHERE real = 0;

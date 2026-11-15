-- How many times people opened each patch-sized cell of the sky (POST /api/checks), for the Explore heat map.
-- cell = position in the grid of 51 Dec bands from the north pole, each cut into about 3.5 degree steps of RA (worker/src/index.js grid).
CREATE TABLE checks (
  cell INTEGER PRIMARY KEY,
  n    INTEGER NOT NULL
);

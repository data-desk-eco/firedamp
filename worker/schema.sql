CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plume_id TEXT NOT NULL,
  model TEXT NOT NULL,
  response TEXT NOT NULL,             -- raw JSON object from the model
  source_label TEXT,                  -- short label parsed from JSON
  source_kind TEXT,                   -- well | facility | pipeline | mine | landfill | other | none
  attributed_id TEXT,                 -- 'OGIM:<id>' | 'OSM:<type>/<id>' | null
  paragraph TEXT,                     -- explanatory paragraph parsed from JSON
  lat REAL,
  lon REAL,
  plume_date TEXT,
  plume_rate REAL,
  plume_src TEXT,
  prompt_sha TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  place_name TEXT,
  wind_speed REAL,
  wind_dir_from REAL
);

CREATE INDEX IF NOT EXISTS idx_analyses_attributed ON analyses(attributed_id);

-- Migrations for existing deployments. SQLite tolerates ALTER ADD COLUMN
-- twice gracefully via the IF NOT EXISTS pattern through caught errors;
-- D1 currently errors if the column exists, so apply once on bootstrap.
-- ALTER TABLE analyses ADD COLUMN place_name TEXT;
-- ALTER TABLE analyses ADD COLUMN wind_speed REAL;
-- ALTER TABLE analyses ADD COLUMN wind_dir_from REAL;

CREATE INDEX IF NOT EXISTS idx_analyses_plume ON analyses(plume_id, model, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analyses_prompt ON analyses(plume_id, model, prompt_sha);
CREATE INDEX IF NOT EXISTS idx_analyses_latlon ON analyses(lat, lon);
CREATE INDEX IF NOT EXISTS idx_analyses_date ON analyses(plume_date);
CREATE INDEX IF NOT EXISTS idx_analyses_created ON analyses(created_at DESC);

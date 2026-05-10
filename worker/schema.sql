CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plume_id TEXT NOT NULL,
  model TEXT NOT NULL,
  response TEXT NOT NULL,
  source_label TEXT,
  lat REAL,
  lon REAL,
  plume_date TEXT,
  plume_rate REAL,
  plume_src TEXT,
  prompt_sha TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analyses_plume ON analyses(plume_id, model, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analyses_prompt ON analyses(plume_id, model, prompt_sha);
CREATE INDEX IF NOT EXISTS idx_analyses_latlon ON analyses(lat, lon);
CREATE INDEX IF NOT EXISTS idx_analyses_date ON analyses(plume_date);
CREATE INDEX IF NOT EXISTS idx_analyses_created ON analyses(created_at DESC);

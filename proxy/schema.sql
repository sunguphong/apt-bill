CREATE TABLE IF NOT EXISTS bills (
  id          TEXT PRIMARY KEY,      -- 'YYYY-MM'
  data        TEXT NOT NULL,         -- bill JSON (items, total, memo ...)
  updated_at  TEXT NOT NULL
);

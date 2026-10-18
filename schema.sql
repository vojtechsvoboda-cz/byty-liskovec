CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  title TEXT,
  price INTEGER,
  disposition TEXT,
  area INTEGER,
  locality TEXT,
  lat REAL,
  lon REAL,
  km REAL,
  url TEXT,
  image TEXT,
  first_seen INTEGER,
  last_seen INTEGER,
  posted_at INTEGER,      -- datum zveřejnění/úpravy ze zdroje, pokud ho zdroj uvádí
  posted_kind TEXT,       -- 'published' nebo 'edited'
  approx INTEGER DEFAULT 0, -- 1 = poloha dohledaná podle adresy/PSČ
  geoq TEXT
);
CREATE INDEX IF NOT EXISTS idx_last_seen ON listings(last_seen);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS geo (q TEXT PRIMARY KEY, lat REAL, lon REAL, ok INTEGER);

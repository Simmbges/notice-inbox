CREATE TABLE notice_events (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, id)
);
CREATE UNIQUE INDEX notice_events_owner_fingerprint ON notice_events (owner_id, fingerprint);

CREATE TABLE notice_categories (
  owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  names TEXT NOT NULL
);

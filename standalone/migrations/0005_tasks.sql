CREATE TABLE personal_tasks (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  PRIMARY KEY (owner_id, id)
);
CREATE INDEX personal_tasks_owner_updated ON personal_tasks(owner_id, updated_at DESC);

CREATE TABLE task_settings (
  owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1)
);

CREATE TABLE task_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  before_data TEXT,
  after_data TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id, task_id) REFERENCES personal_tasks(owner_id, id) ON DELETE CASCADE
);
CREATE INDEX task_history_owner_changed ON task_history(owner_id, changed_at DESC, id DESC);

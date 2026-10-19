ALTER TABLE agent_keys ADD COLUMN permission TEXT NOT NULL DEFAULT 'import'
  CHECK (permission IN ('import', 'read', 'read_import'));

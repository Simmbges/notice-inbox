ALTER TABLE agent_keys ADD COLUMN planner_access INTEGER NOT NULL DEFAULT 0 CHECK (planner_access IN (0, 1));

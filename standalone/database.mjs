import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true, mode: 0o700 });
  const sqlite = new DatabaseSync(filename);
  sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  sqlite.exec('CREATE TABLE IF NOT EXISTS standalone_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const folder of ['drizzle', 'standalone/migrations']) {
    for (const file of readdirSync(resolve(root, folder)).filter(f => f.endsWith('.sql')).sort()) {
      const name = `${folder}/${file}`;
      if (sqlite.prepare('SELECT name FROM standalone_migrations WHERE name = ?').get(name)) continue;
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        sqlite.exec(readFileSync(resolve(root, name), 'utf8'));
        sqlite.prepare('INSERT INTO standalone_migrations VALUES (?, ?)').run(name, Date.now());
        sqlite.exec('COMMIT');
      } catch (error) { sqlite.exec('ROLLBACK'); sqlite.close(); throw error; }
    }
  }
  // 复用现有通知业务，给 SQLite 提供它使用的 D1 接口。
  function prepare(sql) {
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      execute() { return { results: sqlite.prepare(sql).all(...values) }; },
      async all() { return this.execute(); },
      async first() { return sqlite.prepare(sql).get(...values) ?? null; },
    };
  }
  const db = {
    prepare,
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const result = statements.map(s => s.execute()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { sqlite, db, close: () => sqlite.close() };
}

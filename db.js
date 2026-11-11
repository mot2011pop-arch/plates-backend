import Database from 'better-sqlite3';

const db = new Database('game.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    user_id    INTEGER PRIMARY KEY,
    first_name TEXT,
    username   TEXT,
    money      INTEGER DEFAULT 50000,
    best_value INTEGER DEFAULT 0,
    best_plate TEXT,
    collection TEXT DEFAULT '[]',
    updated_at INTEGER DEFAULT 0
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS promos (
    code       TEXT PRIMARY KEY,
    reward     TEXT NOT NULL,
    max_uses   INTEGER DEFAULT 1,
    used_count INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT 0
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS promo_uses (
    code    TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    used_at INTEGER NOT NULL,
    PRIMARY KEY (code, user_id)
  );
`);

export default db;

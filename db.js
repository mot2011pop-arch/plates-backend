import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Обязательно для Supabase
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      user_id    BIGINT PRIMARY KEY,
      first_name TEXT,
      username   TEXT,
      money      INTEGER DEFAULT 50000,
      best_value INTEGER DEFAULT 0,
      best_plate TEXT,
      collection TEXT DEFAULT '[]',
      updated_at BIGINT DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS promos (
      code       TEXT PRIMARY KEY,
      reward     TEXT NOT NULL,
      max_uses   INTEGER DEFAULT 1,
      used_count INTEGER DEFAULT 0,
      created_at BIGINT DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS promo_uses (
      code    TEXT NOT NULL,
      user_id BIGINT NOT NULL,
      used_at BIGINT NOT NULL,
      PRIMARY KEY (code, user_id)
    );
  `);
  console.log('✅ Database initialized');
}

initDB();

export default {
  query: (text, params) => pool.query(text, params),
};

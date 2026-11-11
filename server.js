import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import db from './db.js';

// Токен должен быть в переменных окружения Render!
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me-please';

if (!BOT_TOKEN) {
  console.error('❌ ОШИБКА: TELEGRAM_BOT_TOKEN не задан в Environment на Render!');
  console.error('Сервер не сможет проверять игроков. Добавь переменную и перезапусти.');
  // Мы не завершаем процесс, чтобы ты мог увидеть логи, но игра работать не будет.
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

// Ручная проверка подписи Telegram
function authMiddleware(req, res, next) {
  try {
    if (!BOT_TOKEN) {
      return res.status(500).json({ error: 'server_misconfigured', message: 'Нет TELEGRAM_BOT_TOKEN на сервере' });
    }

    const raw = req.headers['x-init-data'];
    if (!raw) return res.status(401).json({ error: 'no_init_data' });

    const urlParams = new URLSearchParams(raw);
    const hash = urlParams.get('hash');
    if (!hash) return res.status(401).json({ error: 'no_hash' });

    urlParams.delete('hash');
    const dataCheckString = Array.from(urlParams.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (calculatedHash !== hash) {
      console.log('❌ ОШИБКА ПОДПИСИ!');
      console.log('Токен (начало):', BOT_TOKEN.substring(0, 10) + '...');
      console.log('Длина токена:', BOT_TOKEN.length);
      return res.status(401).json({ error: 'invalid_init_data' });
    }

    const userStr = urlParams.get('user');
    if (!userStr) return res.status(401).json({ error: 'no_user' });
    req.tgUser = JSON.parse(userStr);
    next();
  } catch (e) {
    console.error('Auth error:', e);
    return res.status(401).json({ error: 'invalid_init_data' });
  }
}

function adminMiddleware(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) return res.status(403).json({ error: 'forbidden' });
  next();
}

app.get('/', (req, res) => res.json({ ok: true, name: 'plates-backend', token_set: !!BOT_TOKEN }));

app.post('/load', authMiddleware, (req, res) => {
  const userId = req.tgUser.id;
  let player = db.prepare('SELECT * FROM players WHERE user_id = ?').get(userId);
  if (!player) {
    db.prepare(`INSERT INTO players (user_id, first_name, username, money, best_value, best_plate, collection, updated_at) VALUES (?, ?, ?, 50000, 0, NULL, '[]', ?)`)
      .run(userId, req.tgUser.first_name || '', req.tgUser.username || '', Date.now());
    player = db.prepare('SELECT * FROM players WHERE user_id = ?').get(userId);
  }
  res.json({
    money: player.money,
    best: player.best_plate ? { plate: JSON.parse(player.best_plate), value: player.best_value } : null,
    collection: JSON.parse(player.collection || '[]'),
  });
});

app.post('/save', authMiddleware, (req, res) => {
  const userId = req.tgUser.id;
  const { money, best, collection } = req.body || {};
  if (typeof money !== 'number' || money < 0) return res.status(400).json({ error: 'bad_money' });
  if (money > 1_000_000_000) return res.status(400).json({ error: 'too_much_money' });
  const colJson = JSON.stringify(Array.isArray(collection) ? collection.slice(-50) : []);
  const bestJson = best?.plate ? JSON.stringify(best.plate) : null;
  const bestValue = best?.value ?? 0;
  db.prepare(`UPDATE players SET money = ?, best_value = ?, best_plate = ?, collection = ?, updated_at = ? WHERE user_id = ?`)
    .run(money, bestValue, bestJson, colJson, Date.now(), userId);
  res.json({ ok: true });
});

app.post('/redeem', authMiddleware, (req, res) => {
  const userId = req.tgUser.id;
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'empty_code' });

  const promo = db.prepare('SELECT * FROM promos WHERE code = ?').get(code);
  if (!promo) return res.status(404).json({ error: 'not_found' });
  if (promo.used_count >= promo.max_uses) return res.status(400).json({ error: 'limit_reached' });

  const already = db.prepare('SELECT 1 FROM promo_uses WHERE code = ? AND user_id = ?').get(code, userId);
  if (already) return res.status(400).json({ error: 'already_used' });

  let reward;
  try { reward = JSON.parse(promo.reward); } catch { return res.status(500).json({ error: 'bad_reward' }); }

  db.transaction(() => {
    db.prepare('INSERT INTO promo_uses (code, user_id, used_at) VALUES (?, ?, ?)').run(code, userId, Date.now());
    db.prepare('UPDATE promos SET used_count = used_count + 1 WHERE code = ?').run(code);
    if (reward.type === 'money') {
      db.prepare('UPDATE players SET money = money + ?, updated_at = ? WHERE user_id = ?')
        .run(reward.amount, Date.now(), userId);
    }
  })();

  res.json({ ok: true, reward });
});

app.get('/leaderboard', (req, res) => {
  const rows = db.prepare(`SELECT first_name, username, best_value FROM players WHERE best_value > 0 ORDER BY best_value DESC LIMIT 50`).all();
  res.json(rows.map((r, i) => ({ rank: i + 1, name: r.first_name || r.username || 'Игрок', value: r.best_value })));
});

// Админка
app.post('/admin/promo/create', adminMiddleware, (req, res) => {
  const { code, reward, maxUses } = req.body || {};
  if (!code || !reward) return res.status(400).json({ error: 'bad_input' });
  const upperCode = String(code).trim().toUpperCase();
  try {
    db.prepare('INSERT INTO promos (code, reward, max_uses, created_at) VALUES (?, ?, ?, ?)')
      .run(upperCode, JSON.stringify(reward), Number(maxUses) || 1, Date.now());
    res.json({ ok: true, code: upperCode });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(400).json({ error: 'code_exists' });
    res.status(500).json({ error: 'db_error', detail: String(e) });
  }
});

app.get('/admin/promo/list', adminMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM promos ORDER BY created_at DESC').all();
  res.json(rows.map(r => ({ code: r.code, reward: JSON.parse(r.reward), maxUses: r.max_uses, usedCount: r.used_count })));
});

app.delete('/admin/promo/:code', adminMiddleware, (req, res) => {
  const code = String(req.params.code).toUpperCase();
  db.prepare('DELETE FROM promos WHERE code = ?').run(code);
  db.prepare('DELETE FROM promo_uses WHERE code = ?').run(code);
  res.json({ ok: true });
});

// Стартовые промокоды
const DEFAULT_PROMOS = [
  ['WELCOME',   { type: 'money', amount: 25000 }, 1000],
  ['TG2025',    { type: 'money', amount: 50000 }, 100],
  ['LUCKY777',  { type: 'money', amount: 77777 }, 50],
  ['BOOST',     { type: 'booster', mult: 2, durationMs: 300000 }, 500],
  ['EPICGIFT',  { type: 'guarantee', rarity: 'epic', count: 1 }, 100],
];
const insertPromo = db.prepare('INSERT OR IGNORE INTO promos (code, reward, max_uses, created_at) VALUES (?, ?, ?, ?)');
DEFAULT_PROMOS.forEach(([code, reward, max]) => insertPromo.run(code, JSON.stringify(reward), max, Date.now()));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server on :${PORT}`));

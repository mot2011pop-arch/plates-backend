import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import db from './db.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me-please';
if (!BOT_TOKEN) console.error('❌ TELEGRAM_BOT_TOKEN не задан!');

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

function authMiddleware(req, res, next) {
  try {
    if (!BOT_TOKEN) return res.status(500).json({ error: 'server_misconfigured' });
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

    if (calculatedHash !== hash) return res.status(401).json({ error: 'invalid_init_data' });

    const userStr = urlParams.get('user');
    if (!userStr) return res.status(401).json({ error: 'no_user' });
    req.tgUser = JSON.parse(userStr);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_init_data' });
  }
}

function adminMiddleware(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) return res.status(403).json({ error: 'forbidden' });
  next();
}

app.get('/', (req, res) => res.json({ ok: true, name: 'plates-backend', token_set: !!BOT_TOKEN }));

app.post('/load', authMiddleware, async (req, res) => {
  try {
    const userId = req.tgUser.id;
    let result = await db.query('SELECT * FROM players WHERE user_id = $1', [userId]);
    let player = result.rows[0];

    if (!player) {
      await db.query(
        `INSERT INTO players (user_id, first_name, username, money, best_value, best_plate, collection, updated_at) 
         VALUES ($1, $2, $3, 5000, 0, NULL, '[]', $4)`, // <--- Стартовый баланс изменён на 5000
        [userId, req.tgUser.first_name || '', req.tgUser.username || '', Date.now()]
      );
      result = await db.query('SELECT * FROM players WHERE user_id = $1', [userId]);
      player = result.rows[0];
    }

    res.json({
      money: player.money,
      best: player.best_plate ? { plate: JSON.parse(player.best_plate), value: player.best_value } : null,
      collection: JSON.parse(player.collection || '[]'),
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db_error' }); }
});

app.post('/save', authMiddleware, async (req, res) => {
  try {
    const userId = req.tgUser.id;
    const { money, best, collection } = req.body || {};
    if (typeof money !== 'number' || money < 0) return res.status(400).json({ error: 'bad_money' });
    if (money > 1_000_000_000) return res.status(400).json({ error: 'too_much_money' });

    const colJson = JSON.stringify(Array.isArray(collection) ? collection.slice(-50) : []);
    const bestJson = best?.plate ? JSON.stringify(best.plate) : null;
    const bestValue = best?.value ?? 0;

    await db.query(
      `UPDATE players SET money = $1, best_value = $2, best_plate = $3, collection = $4, updated_at = $5 WHERE user_id = $6`,
      [money, bestValue, bestJson, colJson, Date.now(), userId]
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db_error' }); }
});

app.post('/redeem', authMiddleware, async (req, res) => {
  try {
    const userId = req.tgUser.id;
    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'empty_code' });

    const promoResult = await db.query('SELECT * FROM promos WHERE code = $1', [code]);
    const promo = promoResult.rows[0];
    if (!promo) return res.status(404).json({ error: 'not_found' });
    if (promo.used_count >= promo.max_uses) return res.status(400).json({ error: 'limit_reached' });

    const usedCheck = await db.query('SELECT 1 FROM promo_uses WHERE code = $1 AND user_id = $2', [code, userId]);
    if (usedCheck.rows.length > 0) return res.status(400).json({ error: 'already_used' });

    const reward = JSON.parse(promo.reward);

    await db.query('BEGIN');
    await db.query('INSERT INTO promo_uses (code, user_id, used_at) VALUES ($1, $2, $3)', [code, userId, Date.now()]);
    await db.query('UPDATE promos SET used_count = used_count + 1 WHERE code = $1', [code]);
    
    if (reward.type === 'money') {
      await db.query('UPDATE players SET money = money + $1, updated_at = $2 WHERE user_id = $3', [reward.amount, Date.now(), userId]);
    }
    await db.query('COMMIT');

    res.json({ ok: true, reward });
  } catch (e) { 
    await db.query('ROLLBACK');
    console.error(e); 
    res.status(500).json({ error: 'db_error' }); 
  }
});

app.get('/leaderboard', async (req, res) => {
  try {
    const result = await db.query(`SELECT first_name, username, best_value FROM players WHERE best_value > 0 ORDER BY best_value DESC LIMIT 50`);
    res.json(result.rows.map((r, i) => ({ rank: i + 1, name: r.first_name || r.username || 'Игрок', value: r.best_value })));
  } catch (e) { res.status(500).json({ error: 'db_error' }); }
});

app.post('/admin/promo/create', adminMiddleware, async (req, res) => {
  try {
    const { code, reward, maxUses } = req.body || {};
    if (!code || !reward) return res.status(400).json({ error: 'bad_input' });
    const upperCode = String(code).trim().toUpperCase();
    
    await db.query(
      'INSERT INTO promos (code, reward, max_uses, created_at) VALUES ($1, $2, $3, $4)',
      [upperCode, JSON.stringify(reward), Number(maxUses) || 1, Date.now()]
    );
    res.json({ ok: true, code: upperCode });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'code_exists' });
    res.status(500).json({ error: 'db_error' });
  }
});

app.get('/admin/promo/list', adminMiddleware, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM promos ORDER BY created_at DESC');
    res.json(result.rows.map(r => ({ code: r.code, reward: JSON.parse(r.reward), maxUses: r.max_uses, usedCount: r.used_count })));
  } catch (e) { res.status(500).json({ error: 'db_error' }); }
});

app.delete('/admin/promo/:code', adminMiddleware, async (req, res) => {
  try {
    const code = String(req.params.code).toUpperCase();
    await db.query('DELETE FROM promos WHERE code = $1', [code]);
    await db.query('DELETE FROM promo_uses WHERE code = $1', [code]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'db_error' }); }
});

// Сбалансированные стартовые промокоды
const DEFAULT_PROMOS = [
  ['WELCOME',   { type: 'money', amount: 10000 }, 1000],
  ['TG2025',    { type: 'money', amount: 20000 }, 100],
  ['LUCKY777',  { type: 'money', amount: 25000 }, 50],
  ['BOOST',     { type: 'booster', mult: 2, durationMs: 300000 }, 500],
  ['EPICGIFT',  { type: 'guarantee', rarity: 'epic', count: 1 }, 100],
];

setTimeout(async () => {
  for (const [code, reward, max] of DEFAULT_PROMOS) {
    await db.query('INSERT INTO promos (code, reward, max_uses, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', 
      [code, JSON.stringify(reward), max, Date.now()]);
  }
}, 2000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server on :${PORT}`));

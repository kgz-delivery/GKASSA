const { db } = require('./database');
const crypto = require('crypto');

function normalizeUsername(username) {
  if (!username) return null;
  return String(username).trim().replace(/^@/, '') || null;
}

const Users = {
  createOrUpdate(telegramId, { username, first_name, last_name } = {}) {
    const existing = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
    if (existing) {
      db.prepare(`
        UPDATE users SET username = ?, first_name = ?, last_name = ?, updated_at = CURRENT_TIMESTAMP
        WHERE telegram_id = ?
      `).run(username || null, first_name || null, last_name || null, telegramId);
      return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
    }
    db.prepare(`
      INSERT INTO users (telegram_id, username, first_name, last_name, active)
      VALUES (?, ?, ?, ?, 1)
    `).run(telegramId, username || null, first_name || null, last_name || null);
    return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  },

  getByTelegramId(telegramId) {
    return db.prepare('SELECT * FROM users WHERE telegram_id = ? AND active = 1').get(telegramId);
  },

  setReferrer(telegramId, referrerTelegramId) {
    if (!telegramId || !referrerTelegramId || Number(telegramId) === Number(referrerTelegramId)) return false;
    const referrer = this.getByTelegramIdAny(Number(referrerTelegramId));
    if (!referrer) return false;
    return db.prepare(`
      UPDATE users SET referrer_user_id = ?
      WHERE telegram_id = ? AND referrer_user_id IS NULL
    `).run(referrer.id, Number(telegramId)).changes === 1;
  },

  getByTelegramIdAny(telegramId) {
    return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  },

  getById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  },

  getByUsername(username) {
    const nick = normalizeUsername(username);
    if (!nick) return null;
    return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(nick);
  },

  find(query) {
    const raw = String(query || '').trim();
    if (!raw) return null;
    const nick = normalizeUsername(raw);
    if (/^\d+$/.test(nick)) {
      return this.getByTelegramIdAny(Number(nick));
    }
    return this.getByUsername(nick);
  },

  isBanned(telegramId) {
    const user = this.getByTelegramIdAny(telegramId);
    return Boolean(user && user.active === 0);
  },

  getAll() {
    return db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  },

  getBanned() {
    return db.prepare('SELECT * FROM users WHERE active = 0 ORDER BY updated_at DESC').all();
  },

  getStats() {
    const total = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const active = db.prepare('SELECT COUNT(*) as c FROM users WHERE active = 1').get().c;
    const banned = db.prepare('SELECT COUNT(*) as c FROM users WHERE active = 0').get().c;
    return { total, active, banned };
  },

  banById(id) {
    return db.prepare('UPDATE users SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  },

  banByTelegramId(telegramId, profile = {}) {
    const existing = this.getByTelegramIdAny(telegramId);
    if (existing) {
      db.prepare(`
        UPDATE users SET
          active = 0,
          username = COALESCE(?, username),
          first_name = COALESCE(?, first_name),
          last_name = COALESCE(?, last_name),
          updated_at = CURRENT_TIMESTAMP
        WHERE telegram_id = ?
      `).run(profile.username || null, profile.first_name || null, profile.last_name || null, telegramId);
      return this.getByTelegramIdAny(telegramId);
    }
    db.prepare(`
      INSERT INTO users (telegram_id, username, first_name, last_name, active)
      VALUES (?, ?, ?, ?, 0)
    `).run(telegramId, profile.username || null, profile.first_name || null, profile.last_name || null);
    return this.getByTelegramIdAny(telegramId);
  },

  unbanById(id) {
    return db.prepare('UPDATE users SET active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  },

  unbanByTelegramId(telegramId) {
    return db.prepare(
      'UPDATE users SET active = 1, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?'
    ).run(telegramId);
  },
};

const Admins = {
  getByUserId(userId) {
    return db.prepare('SELECT * FROM admins WHERE user_id = ? AND active = 1').get(userId);
  },

  getById(id) {
    return db.prepare('SELECT * FROM admins WHERE id = ?').get(id);
  },

  getAll() {
    return db.prepare('SELECT * FROM admins ORDER BY created_at DESC').all();
  },

  getByTelegramId(telegramId) {
    return db.prepare('SELECT * FROM admins WHERE user_id = ?').get(telegramId);
  },
};

const Requisites = {
  getActive() {
    return db.prepare('SELECT * FROM requisites WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1').get();
  },

  getActiveByProvider(provider) {
    return db.prepare(
      'SELECT * FROM requisites WHERE provider = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1'
    ).get(provider);
  },

  getActiveBySite(site) {
    return db.prepare(
      'SELECT * FROM requisites WHERE site = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1'
    ).get(site);
  },

  getAllBySite(site) {
    return db.prepare(
      'SELECT * FROM requisites WHERE site = ? ORDER BY created_at DESC'
    ).all(site);
  },

  getAll() {
    return db.prepare('SELECT * FROM requisites ORDER BY created_at DESC').all();
  },

  getById(id) {
    return db.prepare('SELECT * FROM requisites WHERE id = ?').get(id);
  },

  create({ kind, provider, qr_code_file, qr_code_photo_id, payment_link_fragment, wallet_address, details, amount, currency, site, created_by }) {
    const stmt = db.prepare(`
      INSERT INTO requisites (kind, provider, qr_code_photo_id, qr_code_file, payment_link_fragment, wallet_address, details, amount, currency, site, created_by, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);
    return stmt.run(
      kind || 'bank_qr',
      provider || null,
      qr_code_photo_id || null,
      qr_code_file || null,
      payment_link_fragment || null,
      wallet_address || null,
      details || null,
      amount || 0,
      currency || 'KGS',
      site || null,
      created_by || null
    );
  },

  setPaymentLinkFragment(id, fragment) {
    return db.prepare('UPDATE requisites SET payment_link_fragment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(fragment || null, id);
  },

  activateForProvider(id, provider) {
    const deactivate = db.prepare('UPDATE requisites SET is_active = 0 WHERE provider = ?');
    const activate = db.prepare('UPDATE requisites SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const run = db.transaction(() => {
      deactivate.run(provider);
      activate.run(id);
    });
    return run();
  },

  activateForSite(id, site) {
    const deactivate = db.prepare('UPDATE requisites SET is_active = 0 WHERE site = ?');
    const activate = db.prepare('UPDATE requisites SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const run = db.transaction(() => {
      deactivate.run(site);
      activate.run(id);
    });
    return run();
  },

  deactivateAll() {
    return db.prepare('UPDATE requisites SET is_active = 0').run();
  },

  deactivate(id) {
    return db.prepare('UPDATE requisites SET is_active = 0 WHERE id = ?').run(id);
  },

  delete(id) {
    const detachTransactions = db.prepare(
      'UPDATE transactions SET requisite_id = NULL WHERE requisite_id = ?'
    );
    const deleteRequisite = db.prepare('DELETE FROM requisites WHERE id = ?');
    return db.transaction(() => {
      detachTransactions.run(id);
      return deleteRequisite.run(id);
    })();
  },
};

const Transactions = {
  generateId() {
    return 'TXN-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  },

  create({ user_id, type, amount, requisite_id, provider, receipt_file, receipt_photo_id, payment_id, withdraw_details, site }) {
    const transaction_id = this.generateId();
    const stmt = db.prepare(`
      INSERT INTO transactions
        (transaction_id, user_id, type, amount, requisite_id, provider, receipt_file, receipt_photo_id, payment_id, withdraw_details, site)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      transaction_id,
      user_id,
      type,
      amount,
      requisite_id || null,
      provider || null,
      receipt_file || null,
      receipt_photo_id || null,
      payment_id || null,
      withdraw_details || null,
      site || null
    );
    return { id: info.lastInsertRowid, transaction_id };
  },

  getById(id) {
    return db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  },

  getByTransactionId(transactionId) {
    return db.prepare('SELECT * FROM transactions WHERE transaction_id = ?').get(transactionId);
  },

  updateStatus(id, status, confirmedBy = null) {
    const stmt = db.prepare(`
      UPDATE transactions SET status = ?, confirmed_by = ?, confirmed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    return stmt.run(status, confirmedBy || null, id);
  },

  getByUserId(userId, limit = 50) {
    return db.prepare(
      'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(userId, limit);
  },

  getByStatus(status, type = null, limit = 50) {
    let query = 'SELECT * FROM transactions WHERE status = ?';
    const params = [status];
    if (type) {
      query += ' AND type = ?';
      params.push(type);
    }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    return db.prepare(query).all(...params);
  },

  getAll(limit = 100) {
    return db.prepare('SELECT * FROM transactions ORDER BY created_at DESC LIMIT ?').all(limit);
  },

  getConfirmedForReport(type) {
    return db.prepare(`
      SELECT transaction_id, type, amount, provider, site, payment_id, withdraw_details,
             created_at, confirmed_at
      FROM transactions
      WHERE type = ? AND status = 'confirmed'
      ORDER BY COALESCE(confirmed_at, created_at) DESC, id DESC
    `).all(type);
  },

  getStats() {
    const topups = db.prepare(`
      SELECT COUNT(*) as c, COALESCE(SUM(amount), 0) as sum FROM transactions WHERE type = 'topup' AND status = 'confirmed'
    `).get();
    const withdrawals = db.prepare(`
      SELECT COUNT(*) as c, COALESCE(SUM(amount), 0) as sum FROM transactions WHERE type = 'withdraw' AND status = 'confirmed'
    `).get();
    const pendingTopups = db.prepare(`
      SELECT COUNT(*) as c FROM transactions WHERE type = 'topup' AND status = 'pending'
    `).get();
    const pendingWithdrawals = db.prepare(`
      SELECT COUNT(*) as c FROM transactions WHERE type = 'withdraw' AND status = 'pending'
    `).get();

    return {
      topups: { count: topups.c, sum: topups.sum },
      withdrawals: { count: withdrawals.c, sum: withdrawals.sum },
      pending: {
        topups: pendingTopups.c,
        withdrawals: pendingWithdrawals.c,
      },
    };
  },

  getStatsByProvider() {
    return db.prepare(`
      SELECT provider, COUNT(*) as c, COALESCE(SUM(amount), 0) as sum
      FROM transactions
      WHERE type = 'topup' AND status = 'confirmed' AND provider IS NOT NULL
      GROUP BY provider
    `).all();
  },

  incrementStat(metric, amount = null) {
    if (amount !== null) {
      return db.prepare(
        'UPDATE statistics SET value = value + ?, updated_at = CURRENT_TIMESTAMP WHERE metric = ?'
      ).run(amount, metric);
    }
    return db.prepare(
      'UPDATE statistics SET value = value + 1, updated_at = CURRENT_TIMESTAMP WHERE metric = ?'
    ).run(metric);
  },
};

const PlayerIds = {
  remember(telegramId, paymentId, site) {
    const id = String(paymentId || '').trim();
    const siteId = String(site || '').trim();
    if (!telegramId || !id || !siteId) return;
    db.prepare(`
      INSERT INTO player_ids (telegram_id, site, payment_id, used_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(telegram_id, site, payment_id) DO UPDATE SET used_at = CURRENT_TIMESTAMP
    `).run(telegramId, siteId, id);

    const stale = db.prepare(`
      SELECT id FROM player_ids
      WHERE telegram_id = ? AND site = ?
      ORDER BY used_at DESC
      LIMIT -1 OFFSET 2
    `).all(telegramId, siteId);
    if (stale.length) {
      const ids = stale.map((row) => row.id);
      db.prepare(`DELETE FROM player_ids WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    }
  },

  lastTwo(telegramId, site) {
    const siteId = String(site || '').trim();
    if (!telegramId || !siteId) return [];
    return db.prepare(
      'SELECT payment_id FROM player_ids WHERE telegram_id = ? AND site = ? ORDER BY used_at DESC LIMIT 2'
    ).all(telegramId, siteId).map((row) => row.payment_id);
  },
};

const BotSettings = {
  get(key, fallback = null) {
    const row = db.prepare('SELECT value FROM bot_settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  },
  set(key, value) {
    db.prepare(`INSERT INTO bot_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
  },
  isEnabled(key) {
    return this.get(key, '1') === '1';
  },
};

module.exports = { Users, Admins, Requisites, Transactions, PlayerIds, BotSettings };

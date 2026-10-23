const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

const dbFile = path.resolve(config.database.path);
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new Database(dbFile);

function columnExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}

function addColumnIfMissing(table, column, ddl) {
  if (!columnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE NOT NULL,
      username TEXT,
      role TEXT DEFAULT 'admin',
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER UNIQUE NOT NULL,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      referrer_user_id INTEGER,
      referral_rewarded_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS requisites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT DEFAULT 'bank_qr',
      provider TEXT,
      qr_code_photo_id TEXT,
      qr_code_file TEXT,
      payment_link_fragment TEXT,
      wallet_address TEXT,
      details TEXT,
      amount REAL DEFAULT 0,
      currency TEXT DEFAULT 'KGS',
      is_active INTEGER DEFAULT 1,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('topup', 'withdraw')),
      amount REAL NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'rejected', 'cancelled')),
      requisite_id INTEGER,
      provider TEXT,
      receipt_photo_id TEXT,
      receipt_file TEXT,
      payment_id TEXT,
      withdraw_details TEXT,
      confirmed_by INTEGER,
      confirmed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (requisite_id) REFERENCES requisites(id),
      FOREIGN KEY (confirmed_by) REFERENCES admins(id)
    );

    CREATE TABLE IF NOT EXISTS statistics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      metric TEXT NOT NULL UNIQUE,
      value REAL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS player_ids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      site TEXT NOT NULL,
      payment_id TEXT NOT NULL,
      used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(telegram_id, site, payment_id)
    );

    CREATE TABLE IF NOT EXISTS bot_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS spin_credits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('topup', 'referral')),
      source_key TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      used_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS spin_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('topup', 'daily', 'referral')),
      prize_key TEXT NOT NULL,
      prize_amount INTEGER NOT NULL DEFAULT 0,
      payout_status TEXT NOT NULL DEFAULT 'none' CHECK(payout_status IN ('none', 'pending', 'paid')),
      paid_by INTEGER,
      paid_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (paid_by) REFERENCES admins(id)
    );

    CREATE INDEX IF NOT EXISTS idx_spin_credits_available ON spin_credits(user_id, used_at, id);
    CREATE INDEX IF NOT EXISTS idx_spin_results_user_created ON spin_results(user_id, created_at);
  `);

  migratePlayerIdsBySite();

  db.exec(`
    UPDATE requisites SET provider = 'qr_bank'
    WHERE provider IN ('mbank', 'elqr', 'bakai')
  `);
  const extraActiveQr = db.prepare(`
    SELECT id FROM requisites
    WHERE provider = 'qr_bank' AND is_active = 1
    ORDER BY created_at DESC
  `).all();
  if (extraActiveQr.length > 1) {
    const keepId = extraActiveQr[0].id;
    db.prepare(`
      UPDATE requisites SET is_active = 0
      WHERE provider = 'qr_bank' AND id != ?
    `).run(keepId);
  }

  addColumnIfMissing('requisites', 'kind', "TEXT DEFAULT 'bank_qr'");
  addColumnIfMissing('requisites', 'provider', 'TEXT');
  addColumnIfMissing('requisites', 'payment_link_fragment', 'TEXT');
  addColumnIfMissing('requisites', 'wallet_address', 'TEXT');
  addColumnIfMissing('requisites', 'site', 'TEXT');
  addColumnIfMissing('transactions', 'provider', 'TEXT');
  addColumnIfMissing('transactions', 'withdraw_details', 'TEXT');
  addColumnIfMissing('transactions', 'site', 'TEXT');
  addColumnIfMissing('users', 'referrer_user_id', 'INTEGER');
  addColumnIfMissing('users', 'referral_rewarded_at', 'DATETIME');

  const insertStat = db.prepare('INSERT OR IGNORE INTO statistics (metric, value) VALUES (?, ?)');
  insertStat.run('total_topups', 0);
  insertStat.run('total_withdrawals', 0);
  insertStat.run('total_transactions', 0);
  insertStat.run('total_volume', 0);

  db.prepare(`INSERT OR IGNORE INTO bot_settings (key, value) VALUES ('freespin_started_at', CURRENT_TIMESTAMP)`).run();

  syncAdminsFromEnv();
}

function playerIdsNeedsSiteRebuild() {
  const cols = db.prepare('PRAGMA table_info(player_ids)').all();
  if (!cols.length) return false;
  if (!cols.some((c) => c.name === 'site')) return true;
  const indexes = db.prepare('PRAGMA index_list(player_ids)').all();
  for (const idx of indexes) {
    if (!idx.unique) continue;
    const info = db.prepare(`PRAGMA index_info("${idx.name}")`).all();
    const names = info.map((i) => i.name).join(',');
    if (names === 'telegram_id,payment_id') return true;
  }
  return false;
}

function migratePlayerIdsBySite() {
  const cols = db.prepare('PRAGMA table_info(player_ids)').all();
  if (!cols.length) return;

  if (playerIdsNeedsSiteRebuild()) {
    db.exec(`
      CREATE TABLE player_ids_by_site (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL,
        site TEXT NOT NULL,
        payment_id TEXT NOT NULL,
        used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(telegram_id, site, payment_id)
      );
    `);
    if (cols.some((c) => c.name === 'site')) {
      db.exec(`
        INSERT INTO player_ids_by_site (telegram_id, site, payment_id, used_at)
        SELECT telegram_id, site, payment_id, used_at
        FROM player_ids
        WHERE site IS NOT NULL AND TRIM(site) != ''
      `);
    }
    db.exec(`
      DROP TABLE player_ids;
      ALTER TABLE player_ids_by_site RENAME TO player_ids;
    `);
    return;
  }

  db.exec(`DELETE FROM player_ids WHERE site IS NULL OR TRIM(site) = ''`);
}

function syncAdminsFromEnv() {
  const adminIds = config.admin.telegramIds;
  if (adminIds.length === 0) {
    console.warn('[DB] ADMIN_TELEGRAM_IDS is empty — no bot admins until you set it in .env');
    return;
  }

  const upsert = db.prepare(`
    INSERT INTO admins (user_id, username, role, active)
    VALUES (?, ?, 'admin', 1)
    ON CONFLICT(user_id) DO UPDATE SET active = 1, username = excluded.username
  `);

  adminIds.forEach((tgId, i) => {
    upsert.run(tgId, 'admin' + (i + 1));
  });
  console.log(`[DB] Synced ${adminIds.length} admin(s) from ADMIN_TELEGRAM_IDS`);
}

function getDb() {
  return db;
}

module.exports = { db, initDatabase, getDb };

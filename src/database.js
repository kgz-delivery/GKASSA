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
      amount_text TEXT,
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

    CREATE TABLE IF NOT EXISTS mobcash_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id TEXT NOT NULL UNIQUE,
      bookmaker TEXT NOT NULL,
      payer_id TEXT NOT NULL,
      amount_text TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('sending', 'success', 'failed', 'unknown')),
      nickname TEXT,
      api_response TEXT,
      error TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id)
    );

    -- Bank push matching and automatic top-up pipeline. Existing transactions
    -- remain the source of truth for the receipt based manual flow.
    CREATE TABLE IF NOT EXISTS banks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      package_name TEXT NOT NULL DEFAULT '',
      requisites TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 100,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bank_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_id INTEGER NOT NULL,
      package_name TEXT NOT NULL,
      regex_amount TEXT NOT NULL,
      regex_sender TEXT,
      example_text TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bank_id) REFERENCES banks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_bank_templates_active ON bank_templates(bank_id, is_active);

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      bookmaker TEXT NOT NULL,
      player_id TEXT NOT NULL,
      amount_requested INTEGER NOT NULL CHECK(amount_requested > 0),
      amount_unique_cents INTEGER NOT NULL,
      bank_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'paid', 'completed', 'expired', 'manual_review', 'failed')),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      paid_at DATETIME,
      bookmaker_tx_id TEXT,
      transaction_id TEXT UNIQUE,
      auto_confirmed INTEGER NOT NULL DEFAULT 0,
      failure_reason TEXT,
      FOREIGN KEY (bank_id) REFERENCES banks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_orders_match ON orders(bank_id, amount_unique_cents, status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(telegram_user_id, created_at);

    -- Reservations remain held through expires_at + grace_until, including
    -- after an order becomes expired, preventing late-payment ambiguity.
    CREATE TABLE IF NOT EXISTS payment_reservations (
      bank_id INTEGER NOT NULL,
      amount_unique_cents INTEGER NOT NULL,
      order_id INTEGER NOT NULL UNIQUE,
      reserved_until DATETIME NOT NULL,
      PRIMARY KEY (bank_id, amount_unique_cents),
      FOREIGN KEY (bank_id) REFERENCES banks(id),
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_payment_reservations_expiry ON payment_reservations(reserved_until);

    CREATE TABLE IF NOT EXISTS incoming_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_id INTEGER,
      bank_code TEXT NOT NULL,
      package_name TEXT NOT NULL,
      amount_unique_cents INTEGER NOT NULL,
      sender TEXT,
      raw_text TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE,
      received_at TEXT NOT NULL,
      matched_order_id INTEGER,
      status TEXT NOT NULL DEFAULT 'unmatched'
        CHECK(status IN ('matched', 'unmatched', 'manual_review', 'duplicate', 'rejected')),
      review_note TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bank_id) REFERENCES banks(id),
      FOREIGN KEY (matched_order_id) REFERENCES orders(id)
    );
    CREATE INDEX IF NOT EXISTS idx_incoming_payments_review ON incoming_payments(status, received_at);

    CREATE TABLE IF NOT EXISTS manual_topups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      bookmaker TEXT NOT NULL,
      player_id TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK(amount > 0),
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'sending', 'completed', 'failed', 'unknown')),
      idempotency_key TEXT NOT NULL UNIQUE,
      bookmaker_tx_id TEXT,
      api_response TEXT,
      error TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_telegram_id INTEGER,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);

    CREATE TABLE IF NOT EXISTS payment_devices (
      device_id TEXT PRIMARY KEY,
      battery INTEGER,
      app_version TEXT,
      last_heartbeat_at DATETIME NOT NULL,
      offline_notified_at DATETIME
    );
    CREATE TABLE IF NOT EXISTS payment_raw_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      package_name TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      received_at TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS referral_payout_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      payment_details TEXT NOT NULL,
      request_type TEXT NOT NULL DEFAULT 'withdraw' CHECK(request_type IN ('withdraw', 'topup')),
      bookmaker TEXT,
      bookmaker_id TEXT,
      withdraw_code TEXT,
      receipt_photo_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'paid', 'rejected')),
      paid_by_telegram_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS referral_commissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_user_id INTEGER NOT NULL,
      referred_user_id INTEGER NOT NULL,
      transaction_id TEXT NOT NULL UNIQUE,
      deposit_amount REAL NOT NULL,
      commission_amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available', 'requested', 'paid')),
      payout_request_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (referrer_user_id) REFERENCES users(id),
      FOREIGN KEY (referred_user_id) REFERENCES users(id),
      FOREIGN KEY (payout_request_id) REFERENCES referral_payout_requests(id)
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

    CREATE TABLE IF NOT EXISTS daily_spin_claims (
      user_id INTEGER PRIMARY KEY,
      claimed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
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

    CREATE TABLE IF NOT EXISTS spin_prize_payouts (
      spin_result_id INTEGER PRIMARY KEY,
      admin_telegram_id INTEGER NOT NULL,
      bookmaker TEXT NOT NULL,
      player_id TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK(amount > 0),
      status TEXT NOT NULL CHECK(status IN ('sending', 'completed', 'unknown', 'failed')),
      error TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY (spin_result_id) REFERENCES spin_results(id)
    );

    CREATE INDEX IF NOT EXISTS idx_spin_credits_available ON spin_credits(user_id, used_at, id);
    CREATE INDEX IF NOT EXISTS idx_spin_results_user_created ON spin_results(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_referral_commissions_balance ON referral_commissions(referrer_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_referral_payout_requests_user ON referral_payout_requests(user_id, created_at);
  `);

  // Seed the Optima identity and a starter parser based on the supplied push
  // screenshots. The actual QR/requisite remains managed by the existing bot.
  const seedBank = db.prepare(`
    INSERT INTO banks (bank_code, name, package_name, requisites, is_active, priority)
    VALUES (?, ?, ?, '', ?, ?)
    ON CONFLICT(bank_code) DO UPDATE SET
      package_name = CASE WHEN excluded.package_name != '' THEN excluded.package_name ELSE banks.package_name END,
      is_active = CASE WHEN excluded.package_name != '' THEN 1 ELSE banks.is_active END
  `);
  seedBank.run('optima', 'Optima', config.paymentAutomation.optimaPackageName,
    config.paymentAutomation.optimaPackageName ? 1 : 0, 10);
  if (config.paymentAutomation.optimaPackageName) {
    const optima = db.prepare("SELECT id FROM banks WHERE bank_code = 'optima'").get();
    db.prepare(`
      INSERT INTO bank_templates (bank_id, package_name, regex_amount, regex_sender, example_text, is_active)
      SELECT ?, ?, ?, ?, ?, 1
      WHERE NOT EXISTS (
        SELECT 1 FROM bank_templates WHERE bank_id = ? AND package_name = ?
      )
    `).run(
      optima.id,
      config.paymentAutomation.optimaPackageName,
      'На сумму:\\s*([0-9]+(?:[.,][0-9]{1,2})?)\\s*KGS',
      'От:\\s*(.+?)\\s*$',
      'Пополнение по QR\nНа сумму: 100.00 KGS\nОт: Абдыманнапов Э. Э.',
      optima.id,
      config.paymentAutomation.optimaPackageName
    );
    db.prepare(`
      UPDATE bank_templates SET example_text = ?
      WHERE bank_id = ? AND example_text = 'Пополнение по QR На сумму: 100.00 KGS От: Абд..'
    `).run('Пополнение по QR\nНа сумму: 100.00 KGS\nОт: Абдыманнапов Э. Э.', optima.id);
  }

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
  addColumnIfMissing('transactions', 'amount_text', 'TEXT');
  addColumnIfMissing('transactions', 'receipt_hash', 'TEXT');
  addColumnIfMissing('transactions', 'payment_order_id', 'INTEGER');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_payment_order_id ON transactions(payment_order_id) WHERE payment_order_id IS NOT NULL');
  addColumnIfMissing('manual_topups', 'api_response', 'TEXT');
  addColumnIfMissing('admins', 'manual_limit', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('admins', 'daily_limit', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('orders', 'transaction_id', 'TEXT');
  addColumnIfMissing('orders', 'auto_confirmed', 'INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_transaction_id ON orders(transaction_id) WHERE transaction_id IS NOT NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_receipt_hash ON transactions(receipt_hash) WHERE receipt_hash IS NOT NULL');
  addColumnIfMissing('mobcash_orders', 'bookmaker', "TEXT NOT NULL DEFAULT ''");
  db.exec(`
    UPDATE mobcash_orders
    SET bookmaker = COALESCE((
      SELECT LOWER(transactions.site) FROM transactions
      WHERE transactions.transaction_id = mobcash_orders.transaction_id
    ), '')
    WHERE bookmaker IS NULL OR bookmaker = ''
  `);
  addColumnIfMissing('users', 'referrer_user_id', 'INTEGER');
  addColumnIfMissing('users', 'referral_rewarded_at', 'DATETIME');
  addColumnIfMissing('referral_payout_requests', 'request_type', "TEXT NOT NULL DEFAULT 'withdraw'");
  addColumnIfMissing('referral_payout_requests', 'bookmaker', 'TEXT');
  addColumnIfMissing('referral_payout_requests', 'bookmaker_id', 'TEXT');
  addColumnIfMissing('referral_payout_requests', 'withdraw_code', 'TEXT');
  addColumnIfMissing('referral_payout_requests', 'receipt_photo_id', 'TEXT');

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

const crypto = require('node:crypto');
const { db } = require('./database');
const config = require('./config');
const { Users, Transactions, MobcashOrders } = require('./models');
const { getBot } = require('./bots');
const { getMobcashClient } = require('./mobcash');
const { createMobcashTopupProcessor, MobcashPersistenceError } = require('./mobcashTopup');
const { isMobcashEnabledFor } = require('./mobcashConfig');

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function deviceAuth(req, res, next) {
  if (process.env.NODE_ENV === 'production' && !req.secure) {
    return res.status(426).json({ error: 'https_required' });
  }
  const token = req.get('x-token');
  const deviceId = req.get('x-device-id');
  if (!config.paymentAutomation.deviceToken || !safeEqual(token, config.paymentAutomation.deviceToken) ||
      !deviceId || deviceId.length > 128) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.paymentDeviceId = deviceId;
  return next();
}

function parseAmountCents(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fractional = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fractional.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function validIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function toSqliteUtc(value) {
  return new Date(value).toISOString().slice(0, 19).replace('T', ' ');
}

async function notifyAdmins(text) {
  const bot = getBot();
  if (!bot) return;
  const adminIds = db.prepare('SELECT user_id FROM admins WHERE active = 1').all().map((row) => row.user_id);
  await Promise.all(adminIds.map((id) => bot.telegram.sendMessage(id, text).catch((error) => {
    console.error(`[Payments] Admin notification failed for ${id}:`, error.message);
  })));
}

function insertAudit(actorTelegramId, action, entityType, entityId, details = {}) {
  db.prepare(`
    INSERT INTO audit_log (actor_telegram_id, action, entity_type, entity_id, details_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(actorTelegramId || null, action, entityType, entityId == null ? null : String(entityId), JSON.stringify(details));
}

function formatAutoTopupAdminMessage(order, status, reason = '') {
  const amount = Number(order.amount_requested).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  return `ID ${order.player_id}\nСумма: ${amount} KGS\n${status}${reason ? `\nПричина: ${reason}` : ''}`;
}

async function markTopupChannelMessageConfirmed(transactionId, getBotInstance) {
  const transaction = Transactions.getByTransactionId(transactionId);
  if (!transaction?.channel_chat_id || !transaction.channel_message_id || !transaction.channel_message_caption) return;
  const bot = getBotInstance();
  if (!bot) return;

  const caption = `${transaction.channel_message_caption}\n\n<b>ПОДТВЕРЖДЁН ✅ (автоматически)</b>`;
  try {
    await bot.telegram.editMessageCaption(
      transaction.channel_chat_id,
      transaction.channel_message_id,
      undefined,
      caption,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
    );
    Transactions.setChannelMessage(
      transactionId,
      transaction.channel_chat_id,
      transaction.channel_message_id,
      caption
    );
  } catch (error) {
    console.error('[Payments] Could not mark auto-confirmed channel post:', error.message);
  }
}

async function runMatchedTopup(order, transaction, {
  manualOverride = false,
  getClient = getMobcashClient,
  isBookmakerEnabled = isMobcashEnabledFor,
  getBotInstance = getBot,
  confirmTopup,
} = {}) {
  if ((!manualOverride && (config.paymentAutomation.autoConfirmMaxSom <= 0 ||
      order.amount_requested > config.paymentAutomation.autoConfirmMaxSom)) || !isBookmakerEnabled(order.bookmaker)) {
    db.prepare("UPDATE orders SET status = 'manual_review', failure_reason = ? WHERE id = ? AND status = 'paid'")
      .run('Автопополнение отключено, сумма выше лимита или API букмекера не настроен', order.id);
    db.prepare("UPDATE incoming_payments SET status = 'manual_review', review_note = ? WHERE matched_order_id = ? AND status = 'matched'")
      .run('Требуется ручная проверка: автопополнение не настроено или превышен лимит', order.id);
    return 'matched';
  }

  try {
    const processor = createMobcashTopupProcessor({
      getClient,
      orders: MobcashOrders,
      dryRun: config.mobcash.dryRun,
    });
    const result = await processor.process(transaction);
    if (result.state === 'success') {
      let confirmed;
      if (confirmTopup) {
        confirmed = await confirmTopup(transaction.transaction_id);
      } else {
        const { applyTopupConfirm } = require('./bot/handlers/adminCallbacks');
        const bot = getBotInstance();
        if (!bot) throw new Error('Telegram bot is unavailable after bookmaker deposit');
        confirmed = await applyTopupConfirm({
          from: { id: 0 },
          telegram: bot.telegram,
        }, transaction.transaction_id, { silent: true });
      }
      if (!confirmed) throw new Error('Bookmaker deposit succeeded but local confirmation did not apply');
      db.prepare("UPDATE orders SET status = 'completed', auto_confirmed = 1, paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP) WHERE id = ? AND status IN ('paid', 'completed')")
        .run(order.id);
      await markTopupChannelMessageConfirmed(transaction.transaction_id, getBotInstance);
      insertAudit(null, 'payment.auto_completed', 'order', order.id, { transaction_id: transaction.transaction_id });
      await notifyAdmins(formatAutoTopupAdminMessage(order, 'ПОДТВЕРЖДЁН ✅'));
      return 'matched';
    }

    const reviewNote = result.state === 'failed'
      ? `API букмекера отклонил пополнение: ${String(result.error?.message || 'ошибка').slice(0, 300)}`
      : `Неопределённый результат API букмекера (${result.state}); требуется сверка`;
    db.prepare("UPDATE orders SET status = ?, failure_reason = ? WHERE id = ? AND status = 'paid'")
      .run(result.state === 'failed' ? 'failed' : 'manual_review', reviewNote, order.id);
    db.prepare("UPDATE incoming_payments SET status = 'manual_review', review_note = ? WHERE matched_order_id = ?")
      .run(reviewNote, order.id);
    await notifyAdmins(formatAutoTopupAdminMessage(order, 'ТРЕБУЕТ СВЕРКИ ⚠️', reviewNote));
    return 'matched';
  } catch (error) {
    const reviewNote = error instanceof MobcashPersistenceError && error.depositSucceeded
      ? 'Пополнение букмекера могло пройти, результат не сохранён. Нужна сверка до повторной попытки.'
      : `Ошибка API букмекера: ${String(error.message || 'неизвестная ошибка').slice(0, 300)}`;
    db.prepare("UPDATE orders SET status = 'manual_review', failure_reason = ? WHERE id = ? AND status = 'paid'")
      .run(reviewNote, order.id);
    db.prepare("UPDATE incoming_payments SET status = 'manual_review', review_note = ? WHERE matched_order_id = ?")
      .run(reviewNote, order.id);
    await notifyAdmins(formatAutoTopupAdminMessage(order, 'ТРЕБУЕТ СВЕРКИ ⚠️', reviewNote));
    console.error('[Payments] Bookmaker top-up processing failed:', { orderId: order.id, error: error.message });
    return 'matched';
  }
}

async function assignIncomingPaymentToOrder(paymentId, orderId, adminTelegramId) {
  const assignment = db.transaction(() => {
    const payment = db.prepare(`
      SELECT * FROM incoming_payments WHERE id = ? AND status = 'manual_review'
    `).get(paymentId);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!payment || !order || payment.bank_id !== order.bank_id || payment.amount_unique_cents !== order.amount_unique_cents) {
      return null;
    }
    if (!['pending', 'expired', 'manual_review', 'paid'].includes(order.status)) return null;

    let transaction = order.transaction_id
      ? Transactions.getByTransactionId(order.transaction_id)
      : null;
    if (order.transaction_id && !transaction) return null;
    if (!transaction) {
      const user = Users.getByTelegramIdAny(order.telegram_user_id);
      if (!user) return null;
      transaction = Transactions.create({
        user_id: user.id,
        type: 'topup',
        amount: order.amount_requested,
        amount_text: String(order.amount_requested),
        requisite_id: null,
        provider: 'qr_bank',
        payment_id: order.player_id,
        site: order.bookmaker,
        payment_order_id: order.id,
      });
      transaction = Transactions.getByTransactionId(transaction.transaction_id);
      db.prepare("UPDATE orders SET transaction_id = ?, status = 'paid', paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP) WHERE id = ? AND transaction_id IS NULL")
        .run(transaction.transaction_id, order.id);
    }
    db.prepare("UPDATE incoming_payments SET matched_order_id = ?, status = 'matched', review_note = NULL WHERE id = ? AND status = 'manual_review'")
      .run(order.id, payment.id);
    insertAudit(adminTelegramId, 'payment.manual_assign', 'order', order.id, { payment_id: payment.id, transaction_id: transaction.transaction_id });
    return { order: { ...order, status: 'paid', transaction_id: transaction.transaction_id }, transaction };
  });

  const result = assignment.immediate();
  if (!result) return { ok: false, reason: 'not_assignable' };
  const outcome = await runMatchedTopup(result.order, result.transaction, { manualOverride: true });
  return { ok: true, outcome };
}

function rejectIncomingPayment(paymentId, adminTelegramId, reason = 'Отклонён администратором') {
  return db.transaction(() => {
    const payment = db.prepare("SELECT * FROM incoming_payments WHERE id = ? AND status = 'manual_review'").get(paymentId);
    if (!payment) return false;
    db.prepare("UPDATE incoming_payments SET status = 'rejected', review_note = ? WHERE id = ?").run(reason, paymentId);
    insertAudit(adminTelegramId, 'payment.manual_reject', 'incoming_payment', paymentId, { reason });
    return true;
  }).immediate();
}

async function receivePayment(req, res, dependencies = {}) {
  const body = req.body || {};
  if (body.device_id !== req.paymentDeviceId || typeof body.bank_code !== 'string' ||
      typeof body.package_name !== 'string' || typeof body.raw_text !== 'string' ||
      typeof body.hash !== 'string' || !body.hash || body.hash.length > 255 || !validIsoDate(body.received_at)) {
    return res.status(400).json({ error: 'invalid_payload' });
  }
  const amountCents = parseAmountCents(body.amount);
  if (!amountCents) return res.status(400).json({ error: 'invalid_amount' });
  if (body.raw_text.length > 10_000) return res.status(413).json({ error: 'raw_text_too_long' });

  const bank = db.prepare(`
    SELECT * FROM banks WHERE bank_code = ? AND package_name = ? AND is_active = 1
  `).get(body.bank_code, body.package_name);
  if (!bank) return res.status(400).json({ error: 'unknown_bank_or_package' });
  const receivedAtSql = toSqliteUtc(body.received_at);

  const alreadyReceived = db.prepare('SELECT id FROM incoming_payments WHERE hash = ?').get(body.hash);
  if (alreadyReceived) return res.status(200).json({ status: 'duplicate' });

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO incoming_payments
        (bank_id, bank_code, package_name, amount_unique_cents, sender, raw_text, hash, received_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unmatched')
    `).run(bank.id, body.bank_code, body.package_name, amountCents,
      body.sender == null ? null : String(body.sender).slice(0, 300), body.raw_text, body.hash, receivedAtSql);

    const activeOrders = db.prepare(`
      SELECT * FROM orders
      WHERE bank_id = ? AND amount_unique_cents = ? AND status IN ('pending', 'expired')
        AND created_at <= ? AND expires_at >= ?
    `).all(bank.id, amountCents, receivedAtSql, receivedAtSql);

    if (activeOrders.length !== 1) {
      let candidates = [];
      let note = activeOrders.length > 1
        ? 'Найдено несколько активных заявок с этой суммой'
        : 'Активная заявка с этой суммой не найдена';
      if (activeOrders.length === 0) {
        candidates = db.prepare(`
          SELECT orders.* FROM orders
          JOIN payment_reservations ON payment_reservations.order_id = orders.id
          WHERE orders.bank_id = ? AND orders.amount_unique_cents = ?
            AND orders.status IN ('pending', 'expired') AND orders.expires_at < ?
            AND payment_reservations.reserved_until >= ?
        `).all(bank.id, amountCents, receivedAtSql, receivedAtSql);
        if (candidates.length === 1) note = `Совпал с истёкшей заявкой №${candidates[0].id}`;
        else if (candidates.length > 1) note = 'Совпал с несколькими истёкшими заявками в grace-периоде';
      }
      const candidateId = candidates.length === 1 ? candidates[0].id : null;
      db.prepare("UPDATE incoming_payments SET status = 'manual_review', matched_order_id = ?, review_note = ? WHERE id = ?")
        .run(candidateId, note, info.lastInsertRowid);
      if (activeOrders.length > 1) {
        db.prepare("UPDATE orders SET status = 'manual_review', failure_reason = ? WHERE id IN (" + activeOrders.map(() => '?').join(',') + ")")
          .run(note, ...activeOrders.map((order) => order.id));
      }
      if (candidates.length > 0) {
        db.prepare("UPDATE orders SET status = 'manual_review', failure_reason = ? WHERE id IN (" + candidates.map(() => '?').join(',') + ")")
          .run(note, ...candidates.map((order) => order.id));
      }
      insertAudit(null, 'payment.manual_review', 'incoming_payment', info.lastInsertRowid, { note, candidate_order_ids: [...activeOrders, ...candidates].map((order) => order.id) });
      return { status: 'unmatched', order: null };
    }

    const order = activeOrders[0];
    const existingTransaction = db.prepare(`
      SELECT * FROM transactions WHERE payment_order_id = ?
    `).get(order.id);
    if (existingTransaction && existingTransaction.status !== 'pending') {
      db.prepare("UPDATE incoming_payments SET status = 'manual_review', matched_order_id = ?, review_note = ? WHERE id = ?")
        .run(order.id, `С заявкой уже связана транзакция со статусом ${existingTransaction.status}`, info.lastInsertRowid);
      db.prepare("UPDATE orders SET status = 'manual_review', failure_reason = ? WHERE id = ?")
        .run('Нужно проверить существующую транзакцию по заявке', order.id);
      return { status: 'unmatched', order: null };
    }

    let transaction;
    if (existingTransaction) {
      transaction = { id: existingTransaction.id, transaction_id: existingTransaction.transaction_id };
    } else {
      const user = Users.getByTelegramIdAny(order.telegram_user_id);
      if (!user) {
        db.prepare("UPDATE incoming_payments SET status = 'manual_review', matched_order_id = ?, review_note = 'Telegram пользователь не найден' WHERE id = ?")
          .run(order.id, info.lastInsertRowid);
        db.prepare("UPDATE orders SET status = 'manual_review', failure_reason = 'Telegram пользователь не найден' WHERE id = ?")
          .run(order.id);
        return { status: 'unmatched', order: null };
      }
      transaction = Transactions.create({
        user_id: user.id,
        type: 'topup',
        amount: order.amount_requested,
        amount_text: String(order.amount_requested),
        requisite_id: null,
        provider: 'qr_bank',
        payment_id: order.player_id,
        site: order.bookmaker,
        payment_order_id: order.id,
      });
    }
    db.prepare("UPDATE orders SET status = 'paid', paid_at = CURRENT_TIMESTAMP, transaction_id = ? WHERE id = ? AND status IN ('pending', 'expired')")
      .run(transaction.transaction_id, order.id);
    db.prepare("UPDATE incoming_payments SET status = 'matched', matched_order_id = ? WHERE id = ?")
      .run(order.id, info.lastInsertRowid);
    insertAudit(null, 'payment.matched', 'order', order.id, { payment_id: info.lastInsertRowid, transaction_id: transaction.transaction_id });
    return { status: 'matched', order: { ...order, id: order.id, transaction_id: transaction.transaction_id }, transaction };
  });

  let matched;
  try {
    matched = tx.immediate();
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(200).json({ status: 'duplicate' });
    throw error;
  }
  if (!matched.order) {
    await notifyAdmins(`⚠️ Новый платёж Optima требует ручной проверки. Сумма ${String(body.amount)} сом. ${body.sender ? `От: ${body.sender}. ` : ''}Причина: ${db.prepare('SELECT review_note FROM incoming_payments WHERE hash = ?').get(body.hash)?.review_note || 'не найдено точное совпадение'}`);
    return res.status(200).json({ status: 'unmatched' });
  }

  const outcome = await runMatchedTopup(
    matched.order,
    Transactions.getByTransactionId(matched.transaction.transaction_id),
    dependencies
  );
  return res.status(200).json({ status: outcome });
}

function setupPaymentApi(app, dependencies = {}) {
  app.get('/api/templates', deviceAuth, (_req, res) => {
    const rows = db.prepare(`
      SELECT banks.bank_code, bank_templates.package_name, bank_templates.regex_amount,
             bank_templates.regex_sender, bank_templates.is_active
      FROM bank_templates JOIN banks ON banks.id = bank_templates.bank_id
      WHERE banks.is_active = 1 AND bank_templates.is_active = 1
      ORDER BY banks.priority, bank_templates.id
    `).all();
    res.set('Cache-Control', 'no-store').json(rows);
  });

  app.post('/api/payments', deviceAuth, (req, res, next) => {
    receivePayment(req, res, dependencies).catch(next);
  });

  app.post('/api/heartbeat', deviceAuth, (req, res) => {
    const { battery, app_version: appVersion } = req.body || {};
    db.prepare(`
      INSERT INTO payment_devices (device_id, battery, app_version, last_heartbeat_at, offline_notified_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, NULL)
      ON CONFLICT(device_id) DO UPDATE SET battery = excluded.battery,
        app_version = excluded.app_version, last_heartbeat_at = CURRENT_TIMESTAMP, offline_notified_at = NULL
    `).run(req.paymentDeviceId, Number.isInteger(battery) ? battery : null,
      typeof appVersion === 'string' ? appVersion.slice(0, 100) : null);
    res.json({ status: 'ok' });
  });

  app.post('/api/raw-logs', deviceAuth, (req, res) => {
    const { package_name: packageName, raw_text: rawText, received_at: receivedAt } = req.body || {};
    if (typeof packageName !== 'string' || typeof rawText !== 'string' || rawText.length > 10_000 || !validIsoDate(receivedAt)) {
      return res.status(400).json({ error: 'invalid_payload' });
    }
    db.prepare(`
      INSERT INTO payment_raw_logs (device_id, package_name, raw_text, received_at)
      VALUES (?, ?, ?, ?)
    `).run(req.paymentDeviceId, packageName.slice(0, 255), rawText, receivedAt);
    res.status(201).json({ status: 'stored' });
  });

  return setInterval(() => {
    const stale = db.prepare(`
      SELECT device_id FROM payment_devices
      WHERE last_heartbeat_at <= datetime('now', '-3 minutes') AND offline_notified_at IS NULL
    `).all();
    for (const { device_id: deviceId } of stale) {
      const changed = db.prepare(`
        UPDATE payment_devices SET offline_notified_at = CURRENT_TIMESTAMP
        WHERE device_id = ? AND offline_notified_at IS NULL
      `).run(deviceId).changes;
      if (changed) void notifyAdmins(`⚠️ Телефон-читалка офлайн: ${deviceId}`);
    }
  }, 30_000);
}

module.exports = { setupPaymentApi, parseAmountCents, assignIncomingPaymentToOrder, rejectIncomingPayment };

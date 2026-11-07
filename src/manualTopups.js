const crypto = require('node:crypto');
const { db } = require('./database');
const config = require('./config');
const { createMobcashTopupProcessor, MobcashPersistenceError } = require('./mobcashTopup');
const { getMobcashClient } = require('./mobcash');
const { isMobcashEnabledFor } = require('./mobcashConfig');

function localDayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bishkek', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function manualOrdersAdapter() {
  return {
    claim(idempotencyKey, payerId, amountText, nickname, bookmaker) {
      const changed = db.prepare(`
        UPDATE manual_topups SET status = 'sending'
        WHERE idempotency_key = ? AND status = 'pending'
          AND bookmaker = ? AND player_id = ? AND amount = ?
      `).run(idempotencyKey, bookmaker, String(payerId), Number(amountText)).changes;
      if (changed) return { claimed: true };
      return {
        claimed: false,
        order: db.prepare('SELECT * FROM manual_topups WHERE idempotency_key = ?').get(idempotencyKey),
      };
    },

    finishSending(idempotencyKey, state, { apiResponse = null, error = null } = {}) {
      const finalState = state === 'success' ? 'completed' : state;
      return db.prepare(`
        UPDATE manual_topups SET status = ?, api_response = ?,
          error = ?, completed_at = CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP ELSE completed_at END
        WHERE idempotency_key = ? AND status = 'sending'
      `).run(finalState, apiResponse, error, finalState, idempotencyKey).changes === 1;
    },
  };
}

function getManualLimits(admin) {
  const isSuperadmin = ['admin', 'superadmin'].includes(String(admin.role || '').toLowerCase());
  if (isSuperadmin) return { isSuperadmin: true, perOperation: Infinity, perDay: Infinity };
  if (String(admin.role || '').toLowerCase() !== 'operator') {
    throw new Error('У вас нет роли для ручного пополнения.');
  }
  const perOperation = Number(admin.manual_limit) || config.paymentAutomation.operatorManualMaxSom;
  const perDay = Number(admin.daily_limit) || config.paymentAutomation.operatorDailyLimitSom;
  if (perOperation <= 0 || perDay <= 0) {
    throw new Error('Для оператора не настроены лимиты на операцию и за сутки.');
  }
  return { isSuperadmin: false, perOperation, perDay };
}

function createManualTopup({ adminTelegramId, bookmaker, playerId, amount, reason }) {
  const normalizedBookmaker = String(bookmaker || '').trim().toLowerCase();
  const normalizedPlayerId = String(playerId || '').trim();
  const normalizedReason = String(reason || '').trim();
  const amountSom = Number(amount);
  if (!/^[a-z0-9]+$/.test(normalizedBookmaker) || !normalizedPlayerId || normalizedPlayerId.length > 128 ||
      !Number.isSafeInteger(amountSom) || amountSom <= 0 || !normalizedReason || normalizedReason.length > 500) {
    throw new TypeError('Нужны корректные bookmaker, ID игрока, целая сумма и причина.');
  }
  if (!isMobcashEnabledFor(normalizedBookmaker)) {
    throw new Error(`API пополнения для ${normalizedBookmaker} не настроен.`);
  }

  const create = db.transaction(() => {
    const admin = db.prepare('SELECT * FROM admins WHERE user_id = ? AND active = 1').get(adminTelegramId);
    if (!admin) throw new Error('Администратор не найден.');
    const limits = getManualLimits(admin);
    if (!limits.isSuperadmin && amountSom > limits.perOperation) {
      throw new Error(`Лимит оператора на одну операцию: ${limits.perOperation} сом.`);
    }
    if (!limits.isSuperadmin) {
      const current = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) AS total FROM manual_topups
        WHERE admin_id = ? AND date(created_at, '+6 hours') = ?
          AND status IN ('pending', 'sending', 'completed', 'unknown')
      `).get(adminTelegramId, localDayKey()).total;
      if (Number(current) + amountSom > limits.perDay) {
        throw new Error(`Дневной лимит оператора: ${limits.perDay} сом; уже использовано ${Number(current)} сом.`);
      }
    }
    const idempotencyKey = `MANUAL-${crypto.randomUUID()}`;
    const result = db.prepare(`
      INSERT INTO manual_topups (admin_id, bookmaker, player_id, amount, reason, status, idempotency_key)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(adminTelegramId, normalizedBookmaker, normalizedPlayerId, amountSom, normalizedReason, idempotencyKey);
    db.prepare(`
      INSERT INTO audit_log (actor_telegram_id, action, entity_type, entity_id, details_json)
      VALUES (?, 'manual_topup.created', 'manual_topup', ?, ?)
    `).run(adminTelegramId, String(result.lastInsertRowid), JSON.stringify({ bookmaker: normalizedBookmaker, playerId: normalizedPlayerId, amount: amountSom, reason: normalizedReason }));
    return { id: Number(result.lastInsertRowid), idempotencyKey, bookmaker: normalizedBookmaker, playerId: normalizedPlayerId, amount: amountSom };
  }).immediate();
  return create;
}

async function runManualTopup({ adminTelegramId, bookmaker, playerId, amount, reason, getClient = getMobcashClient }) {
  const topup = createManualTopup({ adminTelegramId, bookmaker, playerId, amount, reason });
  const orders = manualOrdersAdapter();
  try {
    const processor = createMobcashTopupProcessor({ getClient, orders, dryRun: config.mobcash.dryRun });
    const result = await processor.process({
      transaction_id: topup.idempotencyKey,
      site: topup.bookmaker,
      payment_id: topup.playerId,
      amount_text: String(topup.amount),
    });
    if (result.state === 'dry_run') {
      db.prepare("UPDATE manual_topups SET status = 'failed', error = 'dry-run: bookmaker deposit was not sent' WHERE id = ? AND status = 'pending'")
        .run(topup.id);
      db.prepare(`
        INSERT INTO audit_log (actor_telegram_id, action, entity_type, entity_id, details_json)
        VALUES (?, 'manual_topup.dry_run', 'manual_topup', ?, ?)
      `).run(adminTelegramId, String(topup.id), JSON.stringify({ nickname: result.nickname || null }));
      return { ...topup, state: 'dry_run', nickname: result.nickname };
    }
    return { ...topup, state: result.state, error: result.error?.message || null };
  } catch (error) {
    const state = error instanceof MobcashPersistenceError && error.depositSucceeded ? 'unknown' : 'failed';
    db.prepare(`
      UPDATE manual_topups SET status = ?, error = ?, completed_at = CASE WHEN ? = 'failed' THEN CURRENT_TIMESTAMP ELSE completed_at END
      WHERE idempotency_key = ? AND status IN ('pending', 'sending')
    `).run(state, String(error.message || 'Ошибка API').slice(0, 1000), state, topup.idempotencyKey);
    db.prepare(`
      INSERT INTO audit_log (actor_telegram_id, action, entity_type, entity_id, details_json)
      VALUES (?, 'manual_topup.error', 'manual_topup', ?, ?)
    `).run(adminTelegramId, String(topup.id), JSON.stringify({ state, error: String(error.message || 'Ошибка API') }));
    return { ...topup, state, error: error.message };
  }
}

module.exports = { runManualTopup, createManualTopup, getManualLimits, localDayKey };

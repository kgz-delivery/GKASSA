const { db } = require('./database');
const config = require('./config');

function sqliteUtcDate(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function reservePaymentOrder({ telegramUserId, bookmaker, playerId, amountRequested }) {
  const amount = Number(amountRequested);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new TypeError('Payment order amount must be a positive whole number of som');
  }
  if (!Number.isSafeInteger(Number(telegramUserId)) || !String(bookmaker || '').trim() || !String(playerId || '').trim()) {
    throw new TypeError('Payment order requires a Telegram user, bookmaker and player ID');
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.paymentAutomation.orderTtlMinutes * 60_000);
  const reservedUntil = new Date(expiresAt.getTime() + config.paymentAutomation.reservationGraceMinutes * 60_000);
  const expiresText = sqliteUtcDate(expiresAt);
  const reservedUntilText = sqliteUtcDate(reservedUntil);

  // better-sqlite3 runs this synchronously in one SQLite transaction. The
  // reservation primary key serializes concurrent requests across processes.
  return db.transaction(() => {
    db.prepare(`
      UPDATE orders SET status = 'expired'
      WHERE status = 'pending' AND expires_at <= datetime('now')
    `).run();
    db.prepare("DELETE FROM payment_reservations WHERE reserved_until <= datetime('now')").run();

    const banks = db.prepare(`
      SELECT id FROM banks
      WHERE is_active = 1 AND bank_code = 'optima'
      ORDER BY priority ASC, id ASC
    `).all();
    if (!banks.length) return { ok: false, reason: 'no_active_bank' };

    const insertOrder = db.prepare(`
      INSERT INTO orders
        (telegram_user_id, bookmaker, player_id, amount_requested, amount_unique_cents, bank_id, status, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `);
    const insertReservation = db.prepare(`
      INSERT INTO payment_reservations (bank_id, amount_unique_cents, order_id, reserved_until)
      VALUES (?, ?, ?, ?)
    `);
    const isReserved = db.prepare(`
      SELECT 1 FROM payment_reservations WHERE bank_id = ? AND amount_unique_cents = ?
    `);

    for (const bank of banks) {
      for (let cents = 1; cents <= 99; cents += 1) {
        const uniqueCents = amount * 100 + cents;
        if (isReserved.get(bank.id, uniqueCents)) continue;
        const order = insertOrder.run(
          Number(telegramUserId), String(bookmaker).trim().toLowerCase(), String(playerId).trim(),
          amount, uniqueCents, bank.id, expiresText
        );
        insertReservation.run(bank.id, uniqueCents, order.lastInsertRowid, reservedUntilText);
        return {
          ok: true,
          orderId: Number(order.lastInsertRowid),
          bankId: bank.id,
          amountRequested: amount,
          amountUniqueCents: uniqueCents,
          amountUnique: `${Math.floor(uniqueCents / 100)}.${String(uniqueCents % 100).padStart(2, '0')}`,
          expiresAt: expiresText,
          expiresInMinutes: config.paymentAutomation.orderTtlMinutes,
        };
      }
    }
    return { ok: false, reason: 'no_free_amounts' };
  }).immediate();
}

module.exports = { reservePaymentOrder };

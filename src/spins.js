const crypto = require('crypto');
const { db } = require('./database');
const { BotSettings, Users } = require('./models');
const { creditReferralCommission } = require('./referrals');

const FIRST_SPINS_WITHOUT_PRIZE = 5;
const DAILY_SPIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PRIZE_BUCKETS = [
  { key: '35', amount: 35, weight: 100000 },
  { key: '50', amount: 50, weight: 1000 },
  { key: '65', amount: 65, weight: 10 },
  { key: '80', amount: 80, weight: 10 },
  { key: 'no_win', amount: 0, weight: 898980 },
];
const WEIGHT_TOTAL = PRIZE_BUCKETS.reduce((sum, prize) => sum + prize.weight, 0);

function drawPrize() {
  let value = crypto.randomInt(WEIGHT_TOTAL);
  for (const prize of PRIZE_BUCKETS) {
    if (value < prize.weight) return prize;
    value -= prize.weight;
  }
  return PRIZE_BUCKETS[PRIZE_BUCKETS.length - 1];
}

const confirmTopupAndGrantSpins = db.transaction((transactionId, adminId) => {
  const changed = db.prepare(`
    UPDATE transactions
    SET status = 'confirmed', confirmed_by = ?, confirmed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE transaction_id = ? AND type = 'topup' AND status = 'pending'
  `).run(adminId || null, transactionId).changes;
  if (!changed) return { confirmed: false, spinsGranted: 0, referralCommission: null };

  const transaction = db.prepare('SELECT id, user_id, amount FROM transactions WHERE transaction_id = ?').get(transactionId);
  const campaignStart = BotSettings.get('freespin_started_at', '1970-01-01 00:00:00');
  const confirmedTotal = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS amount
    FROM transactions
    WHERE user_id = ? AND type = 'topup' AND status = 'confirmed' AND confirmed_at >= ?
  `).get(transaction.user_id, campaignStart).amount;
  const earnedTotal = Math.floor(Number(confirmedTotal) / 100);
  const alreadyGranted = db.prepare(`
    SELECT COUNT(*) AS count FROM spin_credits WHERE user_id = ? AND source = 'topup'
  `).get(transaction.user_id).count;
  const spinsGranted = Math.max(0, earnedTotal - alreadyGranted);
  const insertCredit = db.prepare(`
    INSERT OR IGNORE INTO spin_credits (user_id, source, source_key)
    VALUES (?, 'topup', ?)
  `);
  for (let i = 0; i < spinsGranted; i += 1) {
    insertCredit.run(transaction.user_id, `topup:${transaction.id}:${i + 1}`);
  }

  const referralCommission = creditReferralCommission(transaction.user_id, transactionId, transaction.amount);
  return { confirmed: true, spinsGranted, referralCommission, userId: transaction.user_id };
});

function getSpinStatus(telegramId, botUsername = '') {
  const user = Users.getByTelegramId(telegramId);
  if (!user) return null;
  const credits = db.prepare(`
    SELECT source, COUNT(*) AS count FROM spin_credits WHERE user_id = ? AND used_at IS NULL GROUP BY source
  `).all(user.id);
  const availableTopup = credits.find((row) => row.source === 'topup')?.count || 0;
  const dailyClaim = db.prepare('SELECT claimed_at FROM daily_spin_claims WHERE user_id = ?').get(user.id);
  const lastDailyClaimAt = dailyClaim ? `${dailyClaim.claimed_at.replace(' ', 'T')}Z` : null;
  const dailyNextAt = lastDailyClaimAt
    ? new Date(new Date(lastDailyClaimAt).getTime() + DAILY_SPIN_INTERVAL_MS).toISOString()
    : null;
  const dailyRemainingMs = dailyNextAt ? Math.max(0, new Date(dailyNextAt).getTime() - Date.now()) : 0;
  const availableDaily = dailyRemainingMs === 0 ? 1 : 0;
  const usedSpins = db.prepare('SELECT COUNT(*) AS count FROM spin_results WHERE user_id = ?').get(user.id).count;
  const campaignStart = BotSettings.get('freespin_started_at', '1970-01-01 00:00:00');
  const isNewUser = user.created_at >= campaignStart;
  const referralLink = botUsername
    ? `https://t.me/${botUsername}?start=ref_${user.telegram_id}`
    : null;
  return {
    availableTopup,
    availableDaily,
    dailyNextAt: availableDaily ? null : dailyNextAt,
    firstLosingSpinsLeft: isNewUser ? Math.max(0, FIRST_SPINS_WITHOUT_PRIZE - usedSpins) : 0,
    usedSpins,
    referralLink,
  };
}

const createSpin = db.transaction((userId) => {
  const dailyClaim = db.prepare('SELECT claimed_at FROM daily_spin_claims WHERE user_id = ?').get(userId);
  const lastDailyClaimMs = dailyClaim
    ? new Date(`${dailyClaim.claimed_at.replace(' ', 'T')}Z`).getTime()
    : 0;
  const dailyAvailable = !dailyClaim || Date.now() - lastDailyClaimMs >= DAILY_SPIN_INTERVAL_MS;
  const credit = dailyAvailable ? null : db.prepare(`
    SELECT id, source FROM spin_credits
    WHERE user_id = ? AND source = 'topup' AND used_at IS NULL ORDER BY id LIMIT 1
  `).get(userId);
  if (!dailyAvailable && !credit) throw new Error('NO_SPINS_AVAILABLE');
  const source = dailyAvailable ? 'daily' : 'topup';
  if (dailyAvailable) {
    db.prepare(`
      INSERT INTO daily_spin_claims (user_id, claimed_at) VALUES (?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET claimed_at = CURRENT_TIMESTAMP
    `).run(userId);
  } else {
    db.prepare('UPDATE spin_credits SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND used_at IS NULL').run(credit.id);
  }

  const user = db.prepare('SELECT created_at FROM users WHERE id = ?').get(userId);
  const campaignStart = BotSettings.get('freespin_started_at', '1970-01-01 00:00:00');
  const isNewUser = Boolean(user && user.created_at >= campaignStart);
  const usedSpins = db.prepare('SELECT COUNT(*) AS count FROM spin_results WHERE user_id = ?').get(userId).count;
  const forcedLoss = isNewUser && usedSpins < FIRST_SPINS_WITHOUT_PRIZE;
  const prize = forcedLoss
    ? { key: 'no_win', amount: 0 }
    : drawPrize();
  const inserted = db.prepare(`
    INSERT INTO spin_results (user_id, source, prize_key, prize_amount, payout_status)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, source, prize.key, prize.amount, prize.amount > 0 ? 'pending' : 'none');
  return {
    id: inserted.lastInsertRowid,
    source,
    prizeKey: prize.key,
    amount: prize.amount,
    spinNumber: usedSpins + 1,
    forcedLoss,
  };
});

function spin(telegramId) {
  const user = Users.getByTelegramId(telegramId);
  if (!user) throw new Error('USER_NOT_FOUND');
  return createSpin(user.id);
}

function getPrizeWinner(resultId) {
  return db.prepare(`
    SELECT r.*, u.telegram_id, u.username, u.first_name
    FROM spin_results r JOIN users u ON u.id = r.user_id WHERE r.id = ?
  `).get(resultId);
}

function setPrizeWinnerAccount({ resultId, telegramId, bookmaker, playerId }) {
  return db.transaction(() => {
    const payout = db.prepare('SELECT status FROM spin_prize_payouts WHERE spin_result_id = ?').get(resultId);
    if (payout && payout.status !== 'failed') return null;
    const changed = db.prepare(`
      UPDATE spin_results
      SET bookmaker = ?, player_id = ?
      WHERE id = ? AND payout_status = 'pending'
        AND user_id = (SELECT id FROM users WHERE telegram_id = ?)
    `).run(String(bookmaker), String(playerId), resultId, telegramId).changes;
    if (!changed) return null;
    db.prepare(`
      INSERT INTO audit_log (actor_telegram_id, action, entity_type, entity_id, details_json)
      VALUES (?, 'spin.prize_account_submitted', 'spin_result', ?, ?)
    `).run(telegramId, String(resultId), JSON.stringify({ bookmaker, playerId }));
    return getPrizeWinner(resultId);
  }).immediate();
}

function listActiveAdminTelegramIds(configuredIds = []) {
  const stored = db.prepare('SELECT user_id FROM admins WHERE active = 1').all().map((row) => row.user_id);
  return [...new Set([...configuredIds, ...stored].map(Number).filter(Number.isFinite))];
}

function markPrizePaid(resultId, telegramAdminId) {
  const admin = db.prepare('SELECT id FROM admins WHERE user_id = ? AND active = 1').get(telegramAdminId);
  const changed = db.prepare(`
    UPDATE spin_results SET payout_status = 'paid', paid_by = ?, paid_at = CURRENT_TIMESTAMP
    WHERE id = ? AND payout_status = 'pending' AND prize_amount > 0
  `).run(admin?.id || null, resultId).changes;
  return changed === 1 ? getPrizeWinner(resultId) : null;
}

function getPrizePayout(resultId) {
  return db.prepare('SELECT * FROM spin_prize_payouts WHERE spin_result_id = ?').get(resultId) || null;
}

function claimPrizePayout({ resultId, telegramAdminId, bookmaker, playerId }) {
  return db.transaction(() => {
    const prize = getPrizeWinner(resultId);
    if (!prize || prize.prize_amount <= 0 || prize.payout_status !== 'pending') {
      return { claimed: false, reason: 'not_pending', prize: prize || null };
    }
    const existing = getPrizePayout(resultId);
    if (existing && existing.status !== 'failed') {
      return { claimed: false, reason: existing.status, prize, payout: existing };
    }
    if (existing) {
      db.prepare(`
        UPDATE spin_prize_payouts
        SET admin_telegram_id = ?, bookmaker = ?, player_id = ?, status = 'sending', error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE spin_result_id = ? AND status = 'failed'
      `).run(telegramAdminId, bookmaker, playerId, resultId);
    } else {
      db.prepare(`
        INSERT INTO spin_prize_payouts
          (spin_result_id, admin_telegram_id, bookmaker, player_id, amount, status)
        VALUES (?, ?, ?, ?, ?, 'sending')
      `).run(resultId, telegramAdminId, bookmaker, playerId, prize.prize_amount);
    }
    db.prepare(`
      INSERT INTO audit_log (actor_telegram_id, action, entity_type, entity_id, details_json)
      VALUES (?, 'spin.prize_topup_started', 'spin_result', ?, ?)
    `).run(telegramAdminId, String(resultId), JSON.stringify({ bookmaker, playerId, amount: prize.prize_amount }));
    return { claimed: true, prize: { ...prize, bookmaker, player_id: playerId, prize_amount: prize.prize_amount } };
  }).immediate();
}

function finishPrizePayout(resultId, telegramAdminId, state, error = null) {
  const status = state === 'success' ? 'completed' : state;
  if (!['completed', 'unknown', 'failed'].includes(status)) return false;
  return db.transaction(() => {
    const changed = db.prepare(`
      UPDATE spin_prize_payouts
      SET status = ?, error = ?, updated_at = CURRENT_TIMESTAMP,
          completed_at = CASE WHEN ? IN ('completed', 'unknown') THEN CURRENT_TIMESTAMP ELSE NULL END
      WHERE spin_result_id = ? AND status = 'sending'
    `).run(status, error ? String(error).slice(0, 1000) : null, status, resultId).changes;
    if (!changed) return false;
    if (['completed', 'unknown'].includes(status)) {
      const admin = db.prepare('SELECT id FROM admins WHERE user_id = ? AND active = 1').get(telegramAdminId);
      db.prepare(`
        UPDATE spin_results SET payout_status = 'paid', paid_by = ?, paid_at = CURRENT_TIMESTAMP
        WHERE id = ? AND payout_status = 'pending'
      `).run(admin?.id || null, resultId);
    }
    db.prepare(`
      INSERT INTO audit_log (actor_telegram_id, action, entity_type, entity_id, details_json)
      VALUES (?, ?, 'spin_result', ?, ?)
    `).run(telegramAdminId, `spin.prize_topup_${status}`, String(resultId), JSON.stringify({ status, error: error || null }));
    return true;
  }).immediate();
}

module.exports = {
  confirmTopupAndGrantSpins,
  getSpinStatus,
  spin,
  getPrizeWinner,
  setPrizeWinnerAccount,
  listActiveAdminTelegramIds,
  markPrizePaid,
  getPrizePayout,
  claimPrizePayout,
  finishPrizePayout,
};
